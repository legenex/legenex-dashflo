import { HttpError } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {});
  } catch {
    permissions = {};
  }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. Single entry point for mutating a SupplierAdAccount mapping, so
// the UI never writes the entity directly (its row-level security is admin only,
// but operators must be able to manage mappings). All writes use the service
// role after the operator check.
// Payload: { id: string, action: 'set_enabled'|'reassign'|'set_backfill'|'unlink', ... }
//   set_enabled: { enabled: boolean }
//   reassign:    { supplier_id: string }   // moves the account to a different supplier
//   set_backfill:{ backfill_days?: number, backfill_since?: string }
//   unlink:      deletes the association (historical AdSpend rows are kept)
export default async function manageSupplierAdAccount(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const id = String(body.id || '');
    const action = String(body.action || '');
    if (!id) return ctx.json({ error: 'id is required' }, 400);

    const svc = ctx.db;
    const row = await svc.entities.SupplierAdAccount.get(id).catch(() => null);
    if (!row) return ctx.json({ error: 'Mapping not found' }, 404);

    if (action === 'set_enabled') {
      await svc.entities.SupplierAdAccount.update(id, { enabled: body.enabled !== false });
      return ctx.json({ success: true });
    }

    if (action === 'reassign') {
      const supplierId = String(body.supplier_id || '');
      if (!supplierId) return ctx.json({ error: 'supplier_id is required' }, 400);
      const supplier = await svc.entities.Supplier.get(supplierId).catch(() => null);
      if (!supplier) return ctx.json({ error: 'Supplier not found' }, 404);
      await svc.entities.SupplierAdAccount.update(id, { supplier_id: supplierId, supplier_name: supplier.name || '' });
      // Re-stamp existing AdSpend rows for this account onto the new supplier so
      // historical cost follows the mapping change.
      const rows = await svc.entities.AdSpend.filter({ ad_account_id: row.ad_account_id }, '-date', 10000);
      let restamped = 0;
      for (const r of rows) {
        if (r.supplier_id === supplierId) continue;
        await svc.entities.AdSpend.update(r.id, { supplier_id: supplierId, supplier_name: supplier.name || '', supplier_key: (supplier.name || '').trim().toLowerCase() });
        restamped++;
      }
      return ctx.json({ success: true, restamped });
    }

    if (action === 'set_backfill') {
      const patch = {};
      if (body.backfill_days != null) patch.backfill_days = Math.min(Math.max(Math.round(Number(body.backfill_days) || 30), 1), 1100);
      if (body.backfill_since !== undefined) patch.backfill_since = body.backfill_since || '';
      // Changing the window re-arms the initial import.
      patch.backfill_done = false;
      await svc.entities.SupplierAdAccount.update(id, patch);
      return ctx.json({ success: true });
    }

    if (action === 'unlink') {
      await svc.entities.SupplierAdAccount.delete(id);
      return ctx.json({ success: true, unlinked: true });
    }

    return ctx.json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    return ctx.json({ error: error instanceof HttpError ? error.message : error.message }, 500);
  }
}
