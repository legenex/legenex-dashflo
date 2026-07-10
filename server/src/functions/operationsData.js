// Server-side aggregation endpoint for the Operations Dashboard. Never returns
// raw Lead rows: all counts are computed here.
//
// Access rules mirror operatorData exactly:
// - Must be an authenticated session.
// - Rejected if base_role is supplier or buyer, or if linked_buyer_id /
//   linked_supplier_id is set (those are portal accounts, not operators).
// - Must have at least one operator permission set true (or be an admin).
//
// Read-only: this endpoint never creates, updates, or deletes anything.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

const DAY_MS = 86400000;

// Reference tables here are small and operator-scoped; load them fully in one
// bounded read (the entity API has no offset, only sort + limit).
const LOAD_LIMIT = 100000;

async function loadAll(entity, filter) {
  const rows = filter
    ? await entity.filter(filter, '-created_date', LOAD_LIMIT)
    : await entity.list('-created_date', LOAD_LIMIT);
  return Array.isArray(rows) ? rows : [];
}

export default async function operationsData(ctx) {
  const db = ctx.db;
  try {
    const user = ctx.user;
    if (!user) return ctx.json({ error: 'Unauthorized' }, 401);

    const record = await db.entities.User.get(user.id).catch(() => null);
    const caller = record || user;

    if (caller.base_role === 'supplier' || caller.base_role === 'buyer') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }
    if (caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }
    const hasOperatorPermission = OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
    if (!hasOperatorPermission && caller.role !== 'admin') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    const body = ctx.body || {};
    const vertical = body && typeof body.vertical === 'string' && body.vertical.trim()
      ? body.vertical.trim()
      : null;

    const now = Date.now();
    const rangeStart = body && body.start_date ? new Date(body.start_date) : new Date(now - 30 * DAY_MS);
    const rangeEnd = body && body.end_date ? new Date(body.end_date) : new Date(now);
    const startIso = rangeStart.toISOString();
    const endIso = rangeEnd.toISOString();
    const sevenDaysAgo = new Date(now - 7 * DAY_MS);
    const twentyFourHoursAgoIso = new Date(now - DAY_MS).toISOString();

    // Load the reference tables (small, operator-scoped).
    const [buyers, suppliers, campaigns, stateStatuses, stateChangeAll] = await Promise.all([
      loadAll(db.entities.Buyer),
      loadAll(db.entities.Supplier),
      loadAll(db.entities.Campaign),
      loadAll(db.entities.StateStatus),
      loadAll(db.entities.StateChangeEvent),
    ]);

    // ---- counts ----
    const activeBuyers = buyers.filter((b) => b.status === 'active').length;
    const activeSuppliers = suppliers.filter((s) => s.status === 'active').length;
    const activeStateRows = stateStatuses.filter((s) => s.active === true);
    const activeStates = activeStateRows.length;
    const activeCampaigns = campaigns.filter((c) => c.active === true).length;

    const counts = {
      active_buyers: activeBuyers,
      total_buyers: buyers.length,
      active_suppliers: activeSuppliers,
      total_suppliers: suppliers.length,
      active_states: activeStates,
      total_states: stateStatuses.length,
      active_campaigns: activeCampaigns,
      total_campaigns: campaigns.length,
    };

    // ---- deltas (values as at 7 days ago) ----
    // Buyer/Supplier/Campaign status history is not tracked, so we cannot know
    // the prior active count: return null so the UI hides the indicator.
    // States can be derived from StateChangeEvent: reverse the last 7 days of
    // opened/closed transitions from the current active count.
    let statesDelta = null;
    const recentStateChanges7d = stateChangeAll.filter((e) => {
      const t = e.created_date ? new Date(e.created_date).getTime() : 0;
      return t >= sevenDaysAgo.getTime();
    });
    if (recentStateChanges7d.length > 0) {
      let priorActive = activeStates;
      for (const e of recentStateChanges7d) {
        if (e.direction === 'opened') priorActive -= 1;
        else if (e.direction === 'closed') priorActive += 1;
      }
      statesDelta = priorActive;
    }

    const deltas = {
      active_buyers: null,
      active_suppliers: null,
      active_states: statesDelta,
      active_campaigns: null,
    };

    // ---- recent_state_changes (last 7 days, newest first, cap 50) ----
    const recent_state_changes = recentStateChanges7d
      .sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())
      .slice(0, 50)
      .map((e) => ({
        vertical: e.vertical,
        state: e.state,
        direction: e.direction,
        old_cpl: e.old_cpl ?? null,
        new_cpl: e.new_cpl ?? null,
        old_client_type: e.old_client_type ?? null,
        new_client_type: e.new_client_type ?? null,
        created_date: e.created_date,
      }));

    // ---- state_grid (one entry per StateStatus for the selected vertical) ----
    const gridRows = vertical
      ? stateStatuses.filter((s) => s.vertical === vertical)
      : stateStatuses;
    const state_grid = gridRows.map((s) => ({
      state: s.state,
      active: s.active === true,
      effective_client_type: s.effective_client_type ?? null,
      highest_cpl: s.highest_cpl ?? 0,
      lowest_cpl: s.lowest_cpl ?? 0,
      active_buyer_count: s.active_buyer_count ?? 0,
    }));

    // ---- period lead volume (server side, date-filtered, count only) ----
    // Count with a date filter; if the range is too large to treat as cheap,
    // return null so the UI can handle the missing figure.
    let periodLeadCount = 0;
    try {
      const leadFilter = { created_date: { $gte: startIso, $lte: endIso } };
      if (vertical) leadFilter.vertical = vertical;
      const maxScan = 50000;
      const total = await db.entities.Lead.count(leadFilter);
      periodLeadCount = (typeof total === 'number' && total < maxScan) ? total : null;
    } catch {
      periodLeadCount = null;
    }

    // ---- section_metrics ----
    // Billing Reports, Buyer Onboarding: no dedicated entities exist yet, so
    // their metrics are null rather than invented.
    const section_metrics = {
      buyers: { active: activeBuyers, total: buyers.length },
      suppliers: { active: activeSuppliers, total: suppliers.length },
      active_states: { active: activeStates, period_leads: periodLeadCount },
      billing_reports: { due_to_bill: null, outstanding: null },
      buyer_onboarding: { in_progress: null, blocked: null },
      campaigns: { active: activeCampaigns, total: campaigns.length },
    };

    // ---- needs_attention ----
    const needs_attention = [];
    for (const s of suppliers) {
      if (s.status !== 'active') continue;
      const hasChannel = (s.notify_email && String(s.notify_email).trim())
        || (s.notify_slack_channel && String(s.notify_slack_channel).trim())
        || (s.notify_whatsapp && String(s.notify_whatsapp).trim());
      if (!hasChannel) {
        needs_attention.push({
          type: 'supplier_no_channel',
          label: 'Supplier with no notification channel',
          supplier_id: s.id,
          supplier_name: s.name,
        });
      }
    }
    for (const e of recentStateChanges7d) {
      if (e.direction === 'closed') {
        needs_attention.push({
          type: 'state_closed',
          label: 'State closed',
          vertical: e.vertical,
          state: e.state,
          created_date: e.created_date,
        });
      }
    }

    // ---- telemetry ----
    const priorityRunTimes = stateStatuses
      .map((s) => (s.last_changed_at ? new Date(s.last_changed_at).getTime() : 0))
      .filter((t) => t > 0);
    const priorityLastRun = priorityRunTimes.length
      ? new Date(Math.max(...priorityRunTimes)).toISOString()
      : null;

    const changes24h = stateChangeAll.filter((e) => {
      const t = e.created_date ? new Date(e.created_date).getTime() : 0;
      return t >= new Date(twentyFourHoursAgoIso).getTime();
    }).length;
    const unnotified = stateChangeAll.filter((e) => !e.notified_at).length;
    const activeSuppliersNoChannel = suppliers.filter((s) => {
      if (s.status !== 'active') return false;
      const hasChannel = (s.notify_email && String(s.notify_email).trim())
        || (s.notify_slack_channel && String(s.notify_slack_channel).trim())
        || (s.notify_whatsapp && String(s.notify_whatsapp).trim());
      return !hasChannel;
    }).length;

    const telemetry = {
      priority_engine_last_run: priorityLastRun,
      state_changes_24h: changes24h,
      unnotified_state_changes: unnotified,
      active_suppliers_no_channel: activeSuppliersNoChannel,
    };

    return ctx.json({
      counts,
      deltas,
      recent_state_changes,
      state_grid,
      section_metrics,
      needs_attention,
      telemetry,
      period: { start_date: startIso, end_date: endIso, vertical },
    });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
