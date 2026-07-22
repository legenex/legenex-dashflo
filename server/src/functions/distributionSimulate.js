// Caller model: OPERATOR-ONLY. Route simulator against the REAL published config.
// Loads the actual snapshot through the same loader as production, runs the ONE
// canonical engine, and returns a redacted trace marked simulated. Performs ZERO
// writes and ZERO sends (reads only). Authorization runs BEFORE any service-role
// read. Rejected for supplier/buyer/portal accounts and callers without an
// operator permission.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

async function assertOperator(db, user) {
  const record = await db.entities.User.get(user.id).catch(() => null);
  const caller = record || user;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {});
  } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

export default async function distributionSimulate(ctx) {
  try {
    const db = ctx.db;
    const user = ctx.user || null;
    if (!user) return ctx.json({ error: 'Unauthorized' }, 401);
    if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const campaignId = body.campaign_id || null;
    const leadData = body.lead || {};
    if (!campaignId) return ctx.json({ error: 'campaign_id is required' }, 400);

    const engine = await import('./routingEngine.generated.js');
    // The snapshot loader pre-loads real cap counts internally (read-only).
    const result = await engine.runSimulation(db, { campaignId, leadData, nowMs: Date.now() });
    return ctx.json(result);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
