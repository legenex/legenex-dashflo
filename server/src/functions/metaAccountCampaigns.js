import { HttpError } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. Lists the Meta campaigns inside one ad account so the map
// modal can show them with Active/Paused status. Follows paging up to a cap.
// Payload: { ad_account_id: string, connection_id: string }
export default async function metaAccountCampaigns(ctx) {
  try {
    const db = ctx.db;
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const adAccountId = String(body.ad_account_id || '');
    const connectionId = String(body.connection_id || '');
    if (!adAccountId || !connectionId) return ctx.json({ error: 'ad_account_id and connection_id are required' }, 400);

    const conn = await db.entities.MetaConnection.get(connectionId).catch(() => null);
    if (!conn || !conn.token) return ctx.json({ error: 'Connection not found or has no token' }, 404);

    const ver = 'v21.0';
    const node = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    let url = `https://graph.facebook.com/${ver}/${node}/campaigns?fields=id,name,effective_status,status&limit=200&access_token=${encodeURIComponent(conn.token)}`;
    const campaigns = [];
    let pages = 0;
    while (url && pages < 15) {
      const res = await fetch(url);
      const payload = await res.json();
      if (payload.error) {
        const msg = payload.error.error_user_msg || payload.error.message || 'Failed to load campaigns';
        return ctx.json({ error: msg, meta_code: payload.error.code || null });
      }
      for (const c of payload.data || []) {
        const eff = String(c.effective_status || c.status || '').toUpperCase();
        campaigns.push({ id: c.id, name: c.name || c.id, status: eff === 'ACTIVE' ? 'active' : 'paused', raw_status: eff });
      }
      url = payload.paging?.next || '';
      pages++;
    }

    campaigns.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1));
    return ctx.json({
      success: true,
      campaigns,
      counts: { total: campaigns.length, active: campaigns.filter(c => c.status === 'active').length, paused: campaigns.filter(c => c.status === 'paused').length },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
