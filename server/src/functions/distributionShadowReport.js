import * as engine from './routingEngine.generated.js';

// Caller model: OPERATOR-ONLY. Read-only shadow-comparison report. Pairs recent
// legacy Lead outcomes with their RouteDecisionTrace records and returns the full
// discrepancy taxonomy. Authorization runs BEFORE any service-role read. Rejected
// if base_role is supplier or buyer, or if linked_buyer_id / linked_supplier_id is
// set (portal accounts), or without an operator permission. Never writes anything.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

async function assertOperator(db, user) {
  const record = await db.entities.User.get(user.id).catch(() => null);
  const caller = record || user;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {});
  } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Map a legacy Lead final_status to routed/status for comparison.
function legacyOutcome(lead) {
  const status = String(lead.final_status || '').toLowerCase();
  return { routed: status === 'sold', buyerId: lead.buyer_id || null, destinationId: null, price: Number(lead.revenue || 0), status };
}

export default async function distributionShadowReport(ctx) {
  try {
    const db = ctx.db;
    const user = ctx.user;
    if (!user) return ctx.json({ error: 'Unauthorized' }, 401);
    if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const limit = Math.min(Number(body.limit) || 500, 2000);

    // Recent traces, paired with their lead's legacy outcome. Filtered reads.
    const traces = await db.entities.RouteDecisionTrace.filter({}, '-created_date', limit);
    const memberIds = [...new Set(traces.map((t) => t.winner_member_id).filter(Boolean))];
    const members = {};
    for (const id of memberIds) { const r = await db.entities.RouteMember.filter({ id }); if (r && r[0]) members[id] = r[0]; }

    const pairs = [];
    for (const t of traces) {
      const leads = await db.entities.Lead.filter({ id: t.lead_id });
      const lead = leads && leads[0];
      if (!lead) continue;
      const winner = members[t.winner_member_id];
      const native = {
        routed: t.result === 'shadow_selected',
        buyerId: winner ? winner.buyer_id : null,
        destinationId: winner ? winner.destination_id : null,
        price: Number(t.price || 0),
        status: t.result === 'shadow_selected' ? 'sold' : String(t.result || ''),
        evalError: t.result === 'evaluation_error' || t.result === 'engine_load_error',
        configError: t.result === 'no_route_config',
      };
      pairs.push({ legacy: legacyOutcome(lead), native });
    }

    const summary = engine.summarizeComparisons(pairs);
    return ctx.json({ summary, sample_size: pairs.length });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
