const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];
// Operator authorization: admins and operators holding a management permission
// are allowed; portal (buyer or supplier) accounts are rejected.
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Syncs Meta ad spend for every enabled SupplierAdAccount association.
// Attribution model: each SupplierAdAccount row links one Meta ad account to
// exactly one Supplier (enforced by a unique constraint), and every imported
// AdSpend row inherits supplier_id from that association at sync time.
//
// Windows:
//   - First sync per account: today minus backfill_days .. today (account level).
//   - Later syncs: last success minus 3 days .. today, to absorb Meta's spend
//     restatement window.
//   - Campaign and ad level rows (used by the Ad Manager pages, not by cost
//     totals) always cover only the trailing 30 days to keep sync time bounded.
// Insights calls use time_increment=1, limit=500 and follow paging.next, and
// long ranges are chunked into 180 day segments.
//
// Cost totals must only ever read level=account rows; campaign and ad rows are
// granular views and would double count if summed alongside account rows.
//
// Manual calls carry a user token and require admin; scheduled service-role
// calls carry no user. Optional payload filters: { supplier_id, ad_account_ids }.
export default async function syncMetaSpend(ctx) {
  try {
    const user = ctx.user || null;
    if (user && !isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};

    const svc = ctx.db;
    const ver = 'v21.0';
    const trigger = body.trigger || (user ? 'manual' : 'scheduled');

    // Load the associations to sync.
    let assocs = await svc.entities.SupplierAdAccount.filter({ platform: 'meta', enabled: true });
    if (body.supplier_id) assocs = assocs.filter((a) => a.supplier_id === body.supplier_id);
    if (Array.isArray(body.ad_account_ids) && body.ad_account_ids.length) {
      assocs = assocs.filter((a) => body.ad_account_ids.includes(a.ad_account_id));
    }

    if (!assocs.length) {
      // Point legacy setups at the migration instead of silently doing nothing.
      const cfgList = await svc.entities.IntegrationConfig.filter({ name: 'meta' });
      let hasLegacy = false;
      try {
        const cfg = JSON.parse(cfgList[0]?.config || '{}');
        hasLegacy = Boolean((Array.isArray(cfg.tokens) && cfg.tokens.length) || cfg.system_user_token || cfg.access_token);
      } catch { hasLegacy = false; }
      return {
        success: true,
        accounts_synced: 0,
        rows_synced: 0,
        hint: hasLegacy
          ? 'No supplier ad account associations found, but legacy Meta tokens exist. Run migrateMetaConnector to convert them.'
          : 'No supplier ad account associations to sync. Link an ad account to a supplier first.',
      };
    }

    // Load connections referenced by the associations.
    const connIds = Array.from(new Set(assocs.map((a) => String(a.connection_id || '')).filter(Boolean)));
    const connections = {};
    for (const id of connIds) {
      const c = await svc.entities.MetaConnection.get(id).catch(() => null);
      if (c) connections[id] = c;
    }

    // Account-level AdSpendMapping rows still supply vertical and brand tags.
    const allMappings = await svc.entities.AdSpendMapping.list();
    const acctMappingById = {};
    for (const m of allMappings) {
      if (m.platform === 'meta' && m.enabled && m.match_level === 'ad_account' && m.ad_account_id) {
        acctMappingById[m.ad_account_id] = m;
      }
    }

    const dayMs = 86400000;
    const dateStr = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    const todayStr = dateStr(today);
    const daysAgoStr = (n) => dateStr(new Date(today.getTime() - n * dayMs));
    const MAX_HISTORY_DAYS = 1100; // Meta insights history limit is about 37 months.

    const LEAD_ACTION_PRIORITY = ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_conversion.lead_grouped'];
    const extractLeads = (actions) => {
      if (!Array.isArray(actions)) return 0;
      for (const type of LEAD_ACTION_PRIORITY) {
        const matches = actions.filter((a) => a && a.action_type === type);
        if (matches.length) return matches.reduce((sum, a) => sum + (Number(a.value) || 0), 0);
      }
      return 0;
    };
    const sumActionValues = (actions) => {
      if (!Array.isArray(actions)) return 0;
      return actions.reduce((sum, a) => sum + (Number(a?.value) || 0), 0);
    };

    // Fetch daily insights for one level across [since, until], chunked and paginated.
    // Throws on Graph errors, tagging auth failures so the connection can be flagged.
    const fetchInsights = async (token, node, level, fields, since, until) => {
      const rows = [];
      let chunkStart = new Date(`${since}T00:00:00Z`);
      const rangeEnd = new Date(`${until}T00:00:00Z`);
      while (chunkStart <= rangeEnd) {
        const chunkEnd = new Date(Math.min(chunkStart.getTime() + 179 * dayMs, rangeEnd.getTime()));
        const params = new URLSearchParams({
          level,
          fields,
          time_increment: '1',
          time_range: JSON.stringify({ since: dateStr(chunkStart), until: dateStr(chunkEnd) }),
          limit: '500',
        });
        let url = `https://graph.facebook.com/${ver}/${node}/insights?${params}&access_token=${encodeURIComponent(token)}`;
        for (let page = 0; page < 20 && url; page++) {
          const r = await fetch(url);
          const j = await r.json();
          if (j.error) {
            const err = new Error(j.error.error_user_msg || j.error.message || 'Graph API error');
            err.metaCode = j.error.code;
            throw err;
          }
          for (const row of j.data || []) rows.push(row);
          url = j.paging?.next || '';
        }
        chunkStart = new Date(chunkEnd.getTime() + dayMs);
      }
      return rows;
    };

    // Bulk upsert: load existing rows for this account and level once, then
    // delete the ones being replaced and insert fresh rows.
    let skippedNoDate = 0;
    const upsertLevel = async (node, level, keyOf, rows, build) => {
      const existing = await svc.entities.AdSpend.filter({ ad_account_id: node, level }, '-date', 10000);
      const existingByKey = {};
      for (const e of existing) {
        const k = keyOf(e);
        (existingByKey[k] = existingByKey[k] || []).push(e);
      }
      let inserted = 0;
      let skipped = 0;
      for (const row of rows) {
        // Build first, then derive the dedup key from the built row. The built
        // row uses AdSpend field names, which is how existing rows are keyed, so
        // this stays correct for raw Meta insight rows and for aggregated
        // attribution rows alike. Keying off raw Meta field names broke dedup on
        // the aggregated path and let duplicates accumulate on every sync.
        const doc = build(row);
        if (!doc || !doc.date) { skipped++; continue; }
        const k = keyOf(doc);
        for (const e of existingByKey[k] || []) await svc.entities.AdSpend.delete(e.id);
        delete existingByKey[k];
        await svc.entities.AdSpend.create(doc);
        inserted++;
      }
      if (skipped) skippedNoDate += skipped;
      return inserted;
    };

    let accountsSynced = 0;
    let accountsFailed = 0;
    let accountRows = 0;
    let campaignRows = 0;
    let adRows = 0;
    const accountErrors = [];
    const now = new Date().toISOString();

    // Campaign-level supplier mappings, indexed by account then campaign id.
    const campMapsRaw = await svc.entities.AdSpendMapping.filter({ platform: 'meta', match_level: 'campaign' });
    const campMapsByAcct = {};
    for (const m of campMapsRaw) {
      if (!m.ad_account_id || !m.meta_campaign_id) continue;
      (campMapsByAcct[m.ad_account_id] = campMapsByAcct[m.ad_account_id] || {})[m.meta_campaign_id] = m;
    }

    for (const assoc of assocs) {
      const node = assoc.ad_account_id;
      const conn = connections[assoc.connection_id];
      const runStart = Date.now();
      let levelError = '';

      // Records one MetaSyncRun history row for this account.
      const logRun = async (fields) => {
        await svc.entities.MetaSyncRun.create({
          platform: 'meta',
          connection_id: assoc.connection_id || '',
          supplier_ad_account_id: assoc.id,
          supplier_id: assoc.supplier_id || '',
          supplier_name: assoc.supplier_name || '',
          ad_account_id: node,
          ad_account_name: assoc.ad_account_name || '',
          currency: assoc.currency || '',
          trigger,
          started_at: new Date(runStart).toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - runStart,
          account_rows: 0,
          spend_days: 0,
          spend_total: 0,
          ...fields,
        }).catch(() => {});
      };

      const failAccount = async (message) => {
        accountsFailed++;
        accountErrors.push({ ad_account_id: node, supplier: assoc.supplier_name || assoc.supplier_id, error: message });
        await svc.entities.SupplierAdAccount.update(assoc.id, {
          last_synced_at: now,
          last_sync_status: 'Error',
          last_sync_error: message,
        }).catch(() => {});
        await logRun({ status: 'error', error_message: message });
      };

      if (!conn || !conn.token) {
        await failAccount('Connection missing or has no token');
        continue;
      }
      if (conn.token_expires_at && new Date(conn.token_expires_at).getTime() < Date.now()) {
        await svc.entities.MetaConnection.update(conn.id, { status: 'expired', last_error: 'Token expired' }).catch(() => {});
        await failAccount('Connection token expired. Reconnect Meta.');
        continue;
      }

      // Resolve the account-level window.
      const backfillDays = Math.min(Math.max(Number(assoc.backfill_days) || 30, 1), MAX_HISTORY_DAYS);
      let since;
      if (!assoc.backfill_done) {
        if (assoc.backfill_since && /^\d{4}-\d{2}-\d{2}$/.test(assoc.backfill_since)) {
          since = assoc.backfill_since;
          if (since < daysAgoStr(MAX_HISTORY_DAYS)) since = daysAgoStr(MAX_HISTORY_DAYS);
          if (since > todayStr) since = todayStr;
        } else {
          since = daysAgoStr(backfillDays - 1);
        }
      } else {
        const lastSuccess = assoc.last_success_at ? assoc.last_success_at.slice(0, 10) : daysAgoStr(30);
        const base = new Date(`${lastSuccess}T00:00:00Z`);
        since = dateStr(new Date(base.getTime() - 3 * dayMs));
        if (since < daysAgoStr(MAX_HISTORY_DAYS)) since = daysAgoStr(MAX_HISTORY_DAYS);
      }
      const granularSince = since > daysAgoStr(29) ? since : daysAgoStr(29);

      const mapping = acctMappingById[node];
      const supplierName = assoc.supplier_name || mapping?.supplier_name || '';
      const supplierKey = supplierName.trim().toLowerCase();
      const baseRow = (row) => ({
        platform: 'meta',
        mapping_id: mapping?.id || '',
        supplier_id: assoc.supplier_id,
        supplier_ad_account_id: assoc.id,
        date: row.date_start,
        ad_account_id: node,
        spend: Number(row.spend) || 0,
        currency: assoc.currency || '',
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        leads: extractLeads(row.actions),
        vertical: mapping?.vertical || '',
        brand: mapping?.brand || '',
        supplier_name: supplierName,
        supplier_key: supplierKey,
        cost_source: assoc.ad_account_name || node,
      });

      try {
        const acctCampMaps = campMapsByAcct[node] || {};
        // Campaign attribution when the account is in campaign mode, has no
        // single supplier, or has any campaign mappings. Otherwise legacy
        // whole-account attribution.
        const useCampaign = (assoc.mapping_mode === 'campaign') || (!assoc.supplier_id) || (Object.keys(acctCampMaps).length > 0);
        const daysCovered = Math.round((new Date(`${todayStr}T00:00:00Z`).getTime() - new Date(`${since}T00:00:00Z`).getTime()) / dayMs) + 1;
        let spendTotal = 0;
        let acctRowCount = 0;

        if (useCampaign) {
          // CAMPAIGN ATTRIBUTION: spend follows the campaign to supplier map.
          const campInsights = await fetchInsights(conn.token, node, 'campaign', 'spend,impressions,clicks,date_start,actions,campaign_id,campaign_name', since, todayStr);

          // Detail rows per campaign per day, stamped with the mapped supplier
          // for display. Only account-level rows drive cost, so these never
          // double count.
          campaignRows += await upsertLevel(node, 'campaign', (r) => `${r.date}|${r.meta_campaign_id || ''}`, campInsights, (row) => {
            const cm = acctCampMaps[row.campaign_id || ''];
            const sName = cm?.supplier_name || '';
            return {
              platform: 'meta',
              supplier_id: cm?.supplier_id || '',
              supplier_ad_account_id: assoc.id,
              date: row.date_start,
              ad_account_id: node,
              level: 'campaign',
              spend: Number(row.spend) || 0,
              currency: assoc.currency || '',
              impressions: Number(row.impressions) || 0,
              clicks: Number(row.clicks) || 0,
              leads: extractLeads(row.actions),
              vertical: cm?.vertical || '',
              brand: cm?.brand || '',
              supplier_name: sName,
              supplier_key: sName.trim().toLowerCase(),
              cost_source: assoc.ad_account_name || node,
              meta_campaign_id: row.campaign_id || '',
              meta_campaign_name: row.campaign_name || '',
              adset_id: '', adset_name: '', ad_id: '', ad_name: '',
            };
          });

          // Aggregate mapped campaigns into per (supplier, day) account rows that
          // drive supplier cost. Unmapped campaigns are skipped (unattributed).
          const bySupDay = {};
          for (const row of campInsights) {
            const cm = acctCampMaps[row.campaign_id || ''];
            if (!cm || !cm.supplier_id) continue;
            const key = `${cm.supplier_id}|${row.date_start}`;
            const agg = bySupDay[key] || (bySupDay[key] = { cm, date: row.date_start, spend: 0, impressions: 0, clicks: 0, leads: 0 });
            agg.spend += Number(row.spend) || 0;
            agg.impressions += Number(row.impressions) || 0;
            agg.clicks += Number(row.clicks) || 0;
            agg.leads += extractLeads(row.actions);
          }
          const attribution = Object.values(bySupDay);
          spendTotal = attribution.reduce((s, r) => s + r.spend, 0);
          acctRowCount = attribution.length;

          // Remove any legacy single-supplier account rows for this account in
          // the window, then write the per-supplier attribution rows.
          const legacyAcct = await svc.entities.AdSpend.filter({ ad_account_id: node, level: 'account' }, '-date', 10000);
          for (const e of legacyAcct) {
            if ((e.date || '') >= since && !String(e.meta_campaign_id || '').startsWith('__sup__')) await svc.entities.AdSpend.delete(e.id).catch(() => {});
          }
          accountRows += await upsertLevel(node, 'account', (r) => `${r.date}|${r.meta_campaign_id}`, attribution, (agg) => ({
            platform: 'meta',
            supplier_id: agg.cm.supplier_id,
            supplier_ad_account_id: assoc.id,
            date: agg.date,
            ad_account_id: node,
            level: 'account',
            spend: agg.spend,
            currency: assoc.currency || '',
            impressions: agg.impressions,
            clicks: agg.clicks,
            leads: agg.leads,
            vertical: agg.cm.vertical || '',
            brand: agg.cm.brand || '',
            supplier_name: agg.cm.supplier_name || '',
            supplier_key: (agg.cm.supplier_name || '').trim().toLowerCase(),
            cost_source: assoc.ad_account_name || node,
            meta_campaign_id: `__sup__${agg.cm.supplier_id}`,
            meta_campaign_name: '', adset_id: '', adset_name: '', ad_id: '', ad_name: '',
          }));
        } else {
          // LEGACY ACCOUNT ATTRIBUTION: whole account to supplier_id.
          const acctInsights = await fetchInsights(conn.token, node, 'account', 'spend,impressions,clicks,date_start,actions', since, todayStr);
          acctRowCount = acctInsights.length;
          spendTotal = acctInsights.reduce((s, r) => s + (Number(r.spend) || 0), 0);
          accountRows += await upsertLevel(node, 'account', (r) => r.date, acctInsights, (row) => ({
            ...baseRow(row),
            level: 'account',
            meta_campaign_id: '', meta_campaign_name: '', adset_id: '', adset_name: '', ad_id: '', ad_name: '',
          }));
          try {
            const campInsights = await fetchInsights(conn.token, node, 'campaign', 'spend,impressions,clicks,date_start,actions,campaign_id,campaign_name', granularSince, todayStr);
            campaignRows += await upsertLevel(node, 'campaign', (r) => `${r.date}|${r.meta_campaign_id || ''}`, campInsights, (row) => ({
              ...baseRow(row),
              level: 'campaign',
              meta_campaign_id: row.campaign_id || '', meta_campaign_name: row.campaign_name || '',
              adset_id: '', adset_name: '', ad_id: '', ad_name: '',
            }));
          } catch (e) {
            levelError = `Campaign level: ${e.message}`;
            accountErrors.push({ ad_account_id: node, level: 'campaign', error: e.message });
          }
          try {
            const adInsights = await fetchInsights(conn.token, node, 'ad', 'spend,impressions,clicks,date_start,actions,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,video_play_actions,video_thruplay_watched_actions', granularSince, todayStr);
            adRows += await upsertLevel(node, 'ad', (r) => `${r.date}|${r.ad_id || ''}`, adInsights, (row) => ({
              ...baseRow(row),
              level: 'ad',
              meta_campaign_id: row.campaign_id || '', meta_campaign_name: row.campaign_name || '',
              adset_id: row.adset_id || '', adset_name: row.adset_name || '',
              ad_id: row.ad_id || '', ad_name: row.ad_name || '',
              video_3s_views: sumActionValues(row.video_play_actions),
              video_thruplays: sumActionValues(row.video_thruplay_watched_actions),
            }));
          } catch (e) {
            levelError = `Ad level: ${e.message}`;
            accountErrors.push({ ad_account_id: node, level: 'ad', error: e.message });
          }
        }

        accountsSynced++;
        await svc.entities.SupplierAdAccount.update(assoc.id, {
          last_synced_at: now,
          last_success_at: now,
          last_sync_status: `Imported ${daysCovered} day${daysCovered === 1 ? '' : 's'}`,
          last_sync_error: '',
          backfill_done: true,
        }).catch(() => {});
        await logRun({
          status: levelError ? 'partial' : 'success',
          error_message: levelError,
          account_rows: acctRowCount,
          spend_days: daysCovered,
          spend_total: spendTotal,
        });
      } catch (e) {
        const err = e;
        // Graph auth errors (code 190) invalidate the whole connection.
        if (err.metaCode === 190) {
          await svc.entities.MetaConnection.update(conn.id, { status: 'invalid', last_error: err.message }).catch(() => {});
        }
        await failAccount(err.message || 'Sync failed');
      }
    }

    // Refresh validation timestamps on connections that worked this run.
    for (const id of Object.keys(connections)) {
      const failed = accountErrors.some((e) => {
        const a = assocs.find((x) => x.ad_account_id === e.ad_account_id);
        return a && a.connection_id === id && !e.level;
      });
      if (!failed) {
        await svc.entities.MetaConnection.update(id, { status: 'active', last_validated_at: now, last_error: '' }).catch(() => {});
      }
    }

    return {
      success: true,
      accounts_synced: accountsSynced,
      accounts_failed: accountsFailed,
      rows_synced: accountRows,
      campaign_rows_inserted: campaignRows,
      ad_rows_inserted: adRows,
      skipped_no_date: skippedNoDate,
      account_errors: accountErrors,
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
