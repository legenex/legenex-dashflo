import { HttpError } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

// Operator authorization: admins and operators holding a management permission
// are allowed; portal (buyer or supplier) accounts are rejected.
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string'
      ? JSON.parse(caller.permissions || '{}')
      : (caller.permissions || {});
  } catch {
    permissions = {};
  }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. Stores the Meta app's App ID and App Secret in
// IntegrationConfig(name='meta_app') so the OAuth functions can read them
// without environment variables. The secret is write-only from the UI's point
// of view: this returns only the App ID and the last 4 of the secret. Passing a
// blank App ID or Secret keeps the currently stored value, so the App ID can be
// updated without re-entering the secret.
export default async function saveMetaAppCredentials(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const body = ctx.body || {};
    const appId = String(body.app_id || '').trim();
    const appSecret = String(body.app_secret || '').trim();

    const db = ctx.db;
    const list = await db.entities.IntegrationConfig.filter({ name: 'meta_app' });
    const record = list[0] || null;
    let existing = {};
    try { existing = JSON.parse(record?.config || '{}'); } catch { existing = {}; }

    const finalId = appId || String(existing.app_id || '');
    const finalSecret = appSecret || String(existing.app_secret || '');
    if (!finalId) return ctx.json({ success: false, error: 'App ID is required' });
    if (!finalSecret) return ctx.json({ success: false, error: 'App Secret is required' });

    const payload = JSON.stringify({ app_id: finalId, app_secret: finalSecret });
    if (record) await db.entities.IntegrationConfig.update(record.id, { config: payload });
    else await db.entities.IntegrationConfig.create({ name: 'meta_app', config: payload });

    return ctx.json({ success: true, app_id: finalId, secret_last4: finalSecret.slice(-4), configured: true });
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 200);
  }
}
