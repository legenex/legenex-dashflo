// Read an integration's configuration state without exposing its secrets.
// Task S4.
//
// The generic entity route read-denies IntegrationConfig.config outright, which
// is right for the credentials in it and wrong for the settings beside them: a
// dialog cannot prefill an account id or show "connected" without reading
// something back.
//
// This returns the non-secret settings by value and every secret as a presence
// boolean. No secret value is ever in the response.
//
// Authorization matches ENTITY_POLICY.IntegrationConfig, which is adminOnly().

import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import { parseConfig, projectConfig } from '../lib/integrationConfig.js';

const ALLOWED_ROLES = [ROLE.OWNER, ROLE.ADMIN];

export default async function integrationConfigStatus(ctx) {
  if (!ALLOWED_ROLES.includes(resolveRoleClass(ctx.user))) {
    return ctx.json({ success: false, error: 'Not permitted to read integrations' }, 403);
  }

  const body = ctx.body || {};
  const names = Array.isArray(body.names)
    ? body.names.map((n) => String(n).trim()).filter(Boolean)
    : [String(body.name || '').trim()].filter(Boolean);

  if (names.length === 0) {
    return ctx.json({ success: false, error: 'An integration name is required' }, 400);
  }

  try {
    const db = ctx.db;
    const out = {};

    for (const name of names) {
      const rows = await db.entities.IntegrationConfig.filter({ name });
      const record = rows[0] || null;
      if (!record) {
        out[name] = { exists: false, id: null, values: {}, secrets: {}, keys: [] };
        continue;
      }
      const { config, corrupt } = parseConfig(record.config);
      out[name] = {
        exists: true,
        id: record.id,
        stored_config_was_corrupt: corrupt,
        ...projectConfig(config, name),
      };
    }

    return ctx.json({ success: true, integrations: out });
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
