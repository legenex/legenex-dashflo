// Mint and rotate supplier and master API keys. Task S4.
//
// Why this exists
// ---------------
// Keys used to be generated in the browser by SettingsApiKeys.jsx using
// Math.random(), then PATCHed into ApiKey.key through the generic entity route.
// Two problems. Math.random() is not a cryptographic source, and a supplier key
// authenticates inbound leads, so a guessable key is an authentication bypass.
// And the raw value had to travel to the server to be stored, which is exactly
// what hash-only storage is supposed to avoid.
//
// Minting now happens here. The raw key is returned to the caller exactly once,
// in the response to the call that created it, and is never stored in cleartext
// or retrievable afterwards.
//
// Authorization matches ENTITY_POLICY.ApiKey, which is adminOnly(). If this
// accepted any operator it would be a way around the generic route's own rule.

import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import { mintApiKey, storedFieldsFor } from '../lib/apiKeys.js';

const ALLOWED_ROLES = [ROLE.OWNER, ROLE.ADMIN];

function requireAdmin(user) {
  return ALLOWED_ROLES.includes(resolveRoleClass(user));
}

export default async function issueApiKey(ctx) {
  if (!requireAdmin(ctx.user)) {
    return ctx.json({ success: false, error: 'Not permitted to manage API keys' }, 403);
  }

  const body = ctx.body || {};
  const op = String(body.op || 'create').trim();
  const db = ctx.db;

  try {
    if (op === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return ctx.json({ success: false, error: 'A key name is required' }, 400);

      const type = body.type === 'master' ? 'master' : 'supplier';
      const raw = mintApiKey(type);

      const record = await db.entities.ApiKey.create({
        name,
        type,
        ...storedFieldsFor(raw),
        supplier_id: body.supplier_id ? String(body.supplier_id) : undefined,
        supplier_name: body.supplier_name ? String(body.supplier_name) : undefined,
        vertical: body.vertical ? String(body.vertical) : undefined,
        allowed_ips: body.allowed_ips ? String(body.allowed_ips) : undefined,
        expose_revenue: body.expose_revenue === true,
        active: true,
        request_count: 0,
      });

      // The only time the raw value ever leaves this process.
      return ctx.json({
        success: true,
        id: record.id,
        key_prefix: record.key_prefix,
        key: raw,
        warning: 'This is the only time the full key is shown. Store it now.',
      });
    }

    if (op === 'rotate') {
      const id = String(body.id || '').trim();
      if (!id) return ctx.json({ success: false, error: 'A key id is required' }, 400);

      const existing = await db.entities.ApiKey.get(id);
      if (!existing) return ctx.json({ success: false, error: 'Unknown key' }, 404);

      const raw = mintApiKey(existing.type === 'master' ? 'master' : 'supplier');

      // Rotation clears the legacy cleartext column for this row as a side
      // effect, because the old value it held is being replaced anyway. That is
      // safe: the row's new credential is written in the same update, so there
      // is no window where the key cannot be resolved.
      await db.entities.ApiKey.update(id, {
        ...storedFieldsFor(raw),
        key: '',
        request_count: 0,
        last_used_at: null,
      });

      return ctx.json({
        success: true,
        id,
        key_prefix: storedFieldsFor(raw).key_prefix,
        key: raw,
        warning: 'This is the only time the full key is shown. Store it now.',
      });
    }

    return ctx.json({ success: false, error: `Unknown op: ${op}` }, 400);
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
