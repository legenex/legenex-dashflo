import { requireUser, HttpError } from './_runtime.js';

// Operator-gated bulk delete for Lead records. The client cannot delete
// thousands of admin-RLS leads reliably in a per-record loop, so this deletes
// server side in chunks.
//
// Accepts either:
//   { ids: ["..", ".."] }              delete these specific leads
//   { all: true, filter: {..} }        delete every lead matching the filter
//
// Returns { deleted }.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

export default async function bulkDeleteLeads(ctx) {
  try {
    const db = ctx.db;

    const user = requireUser(ctx);

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

    let ids = [];

    if (Array.isArray(body.ids) && body.ids.length > 0) {
      ids = body.ids.filter((x) => typeof x === 'string' && x);
    } else if (body.all === true) {
      // Collect ids for the full filtered set.
      const filter = body.filter && typeof body.filter === 'object' ? body.filter : {};
      const maxLeads = 500000;
      const page = await db.entities.Lead.filter(filter, '-created_date', maxLeads);
      for (const l of (page || [])) { if (l?.id) ids.push(l.id); }
    } else {
      return ctx.json({ error: 'Provide either { ids: [] } or { all: true, filter: {} }' }, 400);
    }

    let deleted = 0;
    const chunkSize = 100;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      for (const id of chunk) {
        try {
          await db.entities.Lead.delete(id);
          deleted++;
        } catch { /* skip individual failures, keep going */ }
      }
    }

    return { deleted };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
