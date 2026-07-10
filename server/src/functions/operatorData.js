import { requireUser, HttpError } from './_runtime.js';

// Read-only Lead data endpoint for operator users. Lead has admin-only RLS, so
// platform role "user" (base_role manager) gets empty results from client-side
// Lead reads. This serves those reads via the service role, gated to operators.
//
// Access rules:
// - Must be an authenticated session.
// - Rejected if base_role is supplier or buyer, or if linked_buyer_id /
//   linked_supplier_id is set (those are portal accounts, not operators).
// - Must have at least one operator permission set true.
//
// Read-only: this endpoint never creates, updates, or deletes anything.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

export default async function operatorData(ctx) {
  try {
    const db = ctx.db;

    const user = ctx.user || null;
    if (!user) return ctx.json({ error: 'Unauthorized' }, 401);

    // Load the caller's User record via service role so we can read fields that
    // may be admin-scoped.
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
    const entity = body.entity;
    if (entity !== 'Lead') return ctx.json({ error: 'Unsupported entity' }, 400);

    const query = body.query || null;
    const sort = body.sort || '-created_date';
    let limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 2000;
    if (limit > 5000) limit = 5000;
    let skip = Number(body.skip);
    if (!Number.isFinite(skip) || skip < 0) skip = 0;

    const rows = query
      ? await db.entities.Lead.filter(query, sort, limit, skip)
      : await db.entities.Lead.list(sort, limit, skip);

    return ctx.json({ rows: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
