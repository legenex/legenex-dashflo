// Write an integration's credentials and settings. Task S4.
//
// This is the only supported way to change IntegrationConfig.config now that
// the field is write-denied on the generic entity route. It reads the stored
// blob server-side, merges the operator's partial update over it, and writes
// the result back, so a form that only knows about two of five stored fields
// can no longer destroy the other three.
//
// The response never contains a secret value. See lib/integrationConfig.js.
//
// Authorization matches ENTITY_POLICY.IntegrationConfig, which is adminOnly().

import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import { parseConfig, mergeConfig, projectConfig } from '../lib/integrationConfig.js';

const ALLOWED_ROLES = [ROLE.OWNER, ROLE.ADMIN];

export default async function saveIntegrationConfig(ctx) {
  if (!ALLOWED_ROLES.includes(resolveRoleClass(ctx.user))) {
    return ctx.json({ success: false, error: 'Not permitted to manage integrations' }, 403);
  }

  const body = ctx.body || {};
  const name = String(body.name || '').trim();
  if (!name) return ctx.json({ success: false, error: 'An integration name is required' }, 400);

  const values = body.values;
  if (values !== undefined && (typeof values !== 'object' || values === null || Array.isArray(values))) {
    return ctx.json({ success: false, error: 'values must be an object' }, 400);
  }

  const clear = Array.isArray(body.clear) ? body.clear.map(String) : [];
  const omitBlank = body.omit_blank !== false;

  try {
    const db = ctx.db;
    const rows = await db.entities.IntegrationConfig.filter({ name });
    const record = rows[0] || null;

    const { config: stored, corrupt } = parseConfig(record?.config);
    const next = mergeConfig(stored, values || {}, { clear, omitBlank });
    const payload = JSON.stringify(next);

    let id;
    if (record) {
      await db.entities.IntegrationConfig.update(record.id, { config: payload });
      id = record.id;
    } else {
      const created = await db.entities.IntegrationConfig.create({ name, config: payload });
      id = created.id;
    }

    const projected = projectConfig(next, name);
    return ctx.json({
      success: true,
      id,
      name,
      // A corrupt stored blob is reported rather than hidden. It means the
      // merge base was empty, so previously stored fields were not preserved.
      stored_config_was_corrupt: corrupt,
      ...projected,
    });
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
