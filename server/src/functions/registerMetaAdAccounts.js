import { requireUser, HttpError } from './_runtime.js';

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

// Operator only. Registers one or more Meta ad accounts as connected (the
// SupplierAdAccount registry) WITHOUT assigning a supplier. This backs the
// connect-first flow: accounts are connected, then their campaigns are mapped
// to a Campaign + Source (supplier) later via mapMetaCampaigns, which writes the
// campaign-level AdSpendMapping rows that carry attribution.
// Idempotent by (platform, ad_account_id): existing rows are re-enabled and
// their connection/name refreshed; any supplier_id already set is left untouched.
// Payload: {
//   connection_id: string,
//   backfill_days?: number,   // 1..1100, default 30
//   accounts: [{ id|ad_account_id, name?|ad_account_name?, business_id?, business_name?, currency?, timezone_name? }]
// }
// Returns { success, registered: [...], updated: [...], error }
export default async function registerMetaAdAccounts(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const connectionId = String(body.connection_id || '');
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    let backfillDays = Number(body.backfill_days) || 30;
    backfillDays = Math.min(Math.max(Math.round(backfillDays), 1), 1100);

    if (!connectionId) return ctx.json({ error: 'connection_id is required' }, 400);
    if (!accounts.length) return ctx.json({ error: 'accounts is required' }, 400);

    const db = ctx.db;
    const connection = await db.entities.MetaConnection.get(connectionId).catch(() => null);
    if (!connection) return ctx.json({ error: 'Connection not found' }, 404);

    const existingRows = await db.entities.SupplierAdAccount.filter({ platform: 'meta' });
    const byAccount = {};
    for (const r of existingRows) if (r.ad_account_id) byAccount[r.ad_account_id] = r;

    const registered = [];
    const updated = [];

    for (const a of accounts) {
      const adAccountId = String(a.id || a.ad_account_id || '');
      if (!adAccountId) continue;
      const name = String(a.name || a.ad_account_name || adAccountId);
      const fields = {
        platform: 'meta',
        connection_id: connectionId,
        ad_account_id: adAccountId,
        ad_account_name: name,
        business_id: String(a.business_id || ''),
        business_name: String(a.business_name || ''),
        currency: String(a.currency || ''),
        timezone_name: String(a.timezone_name || ''),
        enabled: true,
      };
      const existing = byAccount[adAccountId];
      if (existing) {
        await db.entities.SupplierAdAccount.update(existing.id, fields);
        updated.push({ id: existing.id, ad_account_id: adAccountId, ad_account_name: name });
      } else {
        const created = await db.entities.SupplierAdAccount.create({ ...fields, backfill_days: backfillDays, backfill_done: false });
        registered.push({ id: created.id, ad_account_id: adAccountId, ad_account_name: name });
      }
    }

    return { success: true, registered, updated };
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 200);
  }
}
