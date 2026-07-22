import { requireUser, HttpError, json } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. Disconnects a Meta connection: deletes the MetaConnection and,
// by default, its SupplierAdAccount mappings. Historical AdSpend rows are never
// deleted, so past cost and CPL stay intact. The account mappings are removed so
// the scheduled sync stops trying to use the dead token.
// Payload: { connection_id: string, keep_mappings?: boolean }
export default async function disconnectMetaConnection(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const connectionId = String(body.connection_id || '');
    if (!connectionId) return ctx.json({ error: 'connection_id is required' }, 400);

    const db = ctx.db;
    const conn = await db.entities.MetaConnection.get(connectionId).catch(() => null);
    if (!conn) return ctx.json({ error: 'Connection not found' }, 404);

    let removedMappings = 0;
    if (!body.keep_mappings) {
      const mappings = await db.entities.SupplierAdAccount.filter({ platform: 'meta', connection_id: connectionId });
      for (const m of mappings) { await db.entities.SupplierAdAccount.delete(m.id); removedMappings++; }
    }
    await db.entities.MetaConnection.delete(connectionId);

    return ctx.json({ success: true, removed_mappings: removedMappings }, 200);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
