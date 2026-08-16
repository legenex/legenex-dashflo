import { requireUser } from './_runtime.js';

// Owner facing control surface for the Base44 to DashFlo migration sync.
//
// Caller model: MASTER ADMIN ONLY, the same model as systemExport. Partner
// accounts are rejected outright and can never be granted access. This function
// can read every entity in the source app and write to every table in this one,
// so it is held by the owner alone by default.
//
// Ops (POST JSON):
//   { op: 'status' }                     durable run history and per entity state
//   { op: 'sync', entities?: [...] }     run now, same code path as the scheduler
//   { op: 'reconcile', entities?: [...] } identifier level comparison
//
// There is deliberately no separate manual implementation. `Base44Sync.run()`
// is the single entry point for both the systemd timer and this function, so a
// manual run and a scheduled run cannot drift apart, and the advisory lock in
// the engine is what stops them colliding.

export default async function base44SyncControl(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;
    const caller = (await db.entities.User.get(user.id).catch(() => null)) || user;

    // Hard partner exclusion first, before any permission map is consulted.
    if (caller.base_role === 'buyer' || caller.base_role === 'supplier'
      || caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    if (caller.base_role !== 'owner') return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const op = String(body.op || 'status');
    const entities = Array.isArray(body.entities) && body.entities.length ? body.entities : null;

    const { Base44Sync, syncStatus } = await import('../lib/base44Sync.js');

    if (op === 'status') {
      return ctx.json({ success: true, ...(await syncStatus({ limit: Number(body.limit) || 10 })) });
    }

    if (op === 'sync') {
      const result = await new Base44Sync().run({
        trigger: 'manual',
        entities,
        actor: caller.email || caller.id,
      });
      return ctx.json({ success: result.status !== 'failed', ...result });
    }

    if (op === 'reconcile') {
      const { reconcile } = await import('../lib/base44Reconcile.js');
      return ctx.json({ success: true, ...(await reconcile({ entities })) });
    }

    return ctx.json({ error: `Unknown op: ${op}` }, 400);
  } catch (error) {
    // The message only. A thrown source error can carry the request body, and
    // the request body carries the shared secret.
    return ctx.json({ success: false, error: error?.message || 'Sync control failed' }, 500);
  }
}
