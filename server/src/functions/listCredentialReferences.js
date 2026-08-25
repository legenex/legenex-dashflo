// List the names of stored credential references a SubDelivery's
// credential_ref field can point at, so the Delivery editor can offer a real
// picker instead of a free-text field the operator has to guess at. Names
// only - never IntegrationConfig.config, which may hold a secret token.
//
// Any authenticated operator may list names (this reveals no secret and no
// setting value, only that a named credential exists and when it was last
// updated). Creating or replacing one still requires owner/admin, unchanged,
// through the existing saveIntegrationConfig function.

import { requireUser } from './_runtime.js';

export default async function listCredentialReferences(ctx) {
  requireUser(ctx);

  try {
    const rows = await ctx.db.entities.IntegrationConfig.list();
    const credentials = (rows || [])
      .map((r) => ({ name: r.name, updated_date: r.updated_date || null }))
      .filter((r) => !!r.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return ctx.json({ success: true, credentials });
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
