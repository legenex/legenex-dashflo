import { requireUser } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. Lists every ad account reachable by any Meta connection, each
// annotated with its campaign-mapping count and registry status (enabled, last
// sync). This backs the LeadDistro-style all-accounts list. Live Graph reads,
// deduped by ad_account_id across connections.
export default async function metaAdAccountsOverview(ctx) {
  const user = requireUser(ctx);
  if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

  try {
    const db = ctx.db;
    const ver = 'v21.0';

    const conns = await db.entities.MetaConnection.filter({ platform: 'meta' });

    // Map counts per ad account (campaign-level mappings) and distinct suppliers.
    const mappings = await db.entities.AdSpendMapping.filter({ platform: 'meta', match_level: 'campaign' });
    const mapCount = {};
    const mapSuppliers = {};
    for (const m of mappings) {
      if (!m.ad_account_id) continue;
      mapCount[m.ad_account_id] = (mapCount[m.ad_account_id] || 0) + 1;
      (mapSuppliers[m.ad_account_id] = mapSuppliers[m.ad_account_id] || new Set()).add(m.supplier_name || m.supplier_id || '');
    }

    // Registry rows for enabled/sync status.
    const registry = await db.entities.SupplierAdAccount.filter({ platform: 'meta' });
    const regByAccount = {};
    for (const r of registry) regByAccount[r.ad_account_id] = r;

    const accountsById = {};
    const connectionsOut = [];

    for (const c of conns) {
      const now = Date.now();
      let status = c.status || 'active';
      if (c.token_expires_at && new Date(c.token_expires_at).getTime() < now) status = 'expired';
      connectionsOut.push({ id: c.id, name: c.name, status, action_required: status === 'expired' || status === 'invalid', auth_type: c.auth_type });
      if (!c.token || status === 'expired' || status === 'invalid') continue;

      let url = `https://graph.facebook.com/${ver}/me/adaccounts?fields=id,account_id,name,account_status,currency,timezone_name,business{id,name}&limit=200&access_token=${encodeURIComponent(c.token)}`;
      let pages = 0;
      while (url && pages < 15) {
        const res = await fetch(url);
        const json = await res.json();
        if (json.error) break;
        for (const a of json.data || []) {
          const id = a.id || (a.account_id ? `act_${a.account_id}` : '');
          if (!id || accountsById[id]) continue;
          const reg = regByAccount[id];
          accountsById[id] = {
            ad_account_id: id,
            ad_account_name: a.name || id,
            currency: a.currency || reg?.currency || '',
            timezone_name: a.timezone_name || '',
            business_id: a.business?.id || reg?.business_id || '',
            business_name: a.business?.name || reg?.business_name || '',
            account_status: a.account_status === 1 ? 'active' : 'inactive',
            connection_id: c.id,
            connection_name: c.name,
            connection_status: status,
            action_required: status === 'expired' || status === 'invalid',
            map_count: mapCount[id] || 0,
            suppliers: Array.from(mapSuppliers[id] || []).filter(Boolean),
            enabled: reg ? reg.enabled !== false : false,
            registered: !!reg,
            last_success_at: reg?.last_success_at || null,
            last_synced_at: reg?.last_synced_at || null,
            last_sync_error: reg?.last_sync_error || '',
          };
        }
        url = json.paging?.next || '';
        pages++;
      }
    }

    let hiddenIds = [];
    try {
      const hiddenCfg = await db.entities.IntegrationConfig.filter({ name: 'meta_hidden_accounts' });
      hiddenIds = JSON.parse(hiddenCfg[0]?.config || '{}').ids || [];
    } catch { hiddenIds = []; }
    const hiddenSet = new Set(hiddenIds);

    const sortAcct = (a, b) => (b.map_count - a.map_count) || a.ad_account_name.localeCompare(b.ad_account_name);
    const all = Object.values(accountsById);
    const accounts = all.filter((a) => !hiddenSet.has(a.ad_account_id)).sort(sortAcct);
    const hidden = all.filter((a) => hiddenSet.has(a.ad_account_id)).sort(sortAcct);
    return { success: true, accounts, hidden, connections: connectionsOut, total: accounts.length };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
