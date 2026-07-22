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

// Admin only. Associates one or more Meta ad accounts with a supplier by
// creating (or re-enabling) SupplierAdAccount rows. Enforces the rule that an
// ad account belongs to exactly one supplier: any account already linked to a
// different supplier is returned as a conflict and skipped, never reassigned
// silently. The caller (connect wizard) triggers syncMetaSpend afterwards.
// Payload: {
//   supplier_id: string,
//   connection_id: string,
//   backfill_days?: number,               // 1..1100, default 30
//   accounts: [{ id, account_id?, name?, business_id?, business_name?, currency?, timezone_name? }]
// }
// Returns { success, linked: [...], updated: [...], conflicts: [{ ad_account_id, supplier_name }], error }
export default async function linkAdAccountToSupplier(ctx) {
  try {
    const db = ctx.db;
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const supplierId = String(body.supplier_id || '');
    const connectionId = String(body.connection_id || '');
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    let backfillDays = Number(body.backfill_days) || 30;
    backfillDays = Math.min(Math.max(Math.round(backfillDays), 1), 1100);
    const backfillSince = (typeof body.backfill_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.backfill_since)) ? body.backfill_since : '';

    if (!supplierId) return ctx.json({ error: 'supplier_id is required' }, 400);
    if (!connectionId) return ctx.json({ error: 'connection_id is required' }, 400);
    if (!accounts.length) return ctx.json({ error: 'accounts is required' }, 400);

    const supplier = await db.entities.Supplier.get(supplierId).catch(() => null);
    if (!supplier) return ctx.json({ error: 'Supplier not found' }, 404);
    const connection = await db.entities.MetaConnection.get(connectionId).catch(() => null);
    if (!connection) return ctx.json({ error: 'Connection not found' }, 404);

    const linked = [];
    const updated = [];
    const conflicts = [];

    for (const a of accounts) {
      const adAccountId = String(a.id || a.ad_account_id || '');
      if (!adAccountId) continue;

      const existing = (await db.entities.SupplierAdAccount.filter({ platform: 'meta', ad_account_id: adAccountId }))[0] || null;

      if (existing && existing.supplier_id !== supplierId) {
        const other = await db.entities.Supplier.get(existing.supplier_id).catch(() => null);
        conflicts.push({ ad_account_id: adAccountId, ad_account_name: a.name || existing.ad_account_name || '', supplier_name: other?.name || existing.supplier_name || 'another supplier' });
        continue;
      }

      const fields = {
        supplier_id: supplierId,
        supplier_name: supplier.name || '',
        connection_id: connectionId,
        platform: 'meta',
        ad_account_id: adAccountId,
        ad_account_name: a.name || '',
        business_id: a.business_id || '',
        business_name: a.business_name || '',
        currency: a.currency || '',
        timezone_name: a.timezone_name || '',
        enabled: true,
        backfill_days: backfillDays,
        backfill_since: backfillSince,
      };

      if (existing) {
        await db.entities.SupplierAdAccount.update(existing.id, fields);
        updated.push({ id: existing.id, ad_account_id: adAccountId });
      } else {
        const row = await db.entities.SupplierAdAccount.create({ ...fields, backfill_done: false });
        linked.push({ id: row.id, ad_account_id: adAccountId });
      }
    }

    return ctx.json({ success: true, linked, updated, conflicts });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
