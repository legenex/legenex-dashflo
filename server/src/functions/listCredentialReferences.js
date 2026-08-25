// List the names of stored credential references a SubDelivery's
// credential_ref field can point at, so the Delivery editor can offer a real
// picker instead of a free-text field the operator has to guess at. Names
// only - never IntegrationConfig.config, which may hold a secret token.
//
// Any authenticated OPERATOR may list names (this reveals no secret and no
// setting value, only that a named credential exists and when it was last
// updated). Creating or replacing one still requires owner/admin, unchanged,
// through the existing saveIntegrationConfig function.
//
// Gated to operators specifically, not merely "any authenticated user": a
// buyer/supplier portal account is authenticated but must not enumerate the
// names of internal delivery credentials (e.g. "walker_advertising_auth"),
// which is internal integration metadata a portal account has no reason to
// see. Uses the same isOperator predicate as the sibling delivery functions
// (deliveryPayloadPreview.js, campaignDeliveryTest.js).

import { requireUser } from './_runtime.js';
import { isOperator } from './routingEngine.generated.js';

export default async function listCredentialReferences(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  const record = await db.entities.User.get(user.id).catch(() => null);
  if (!isOperator(record || user)) return ctx.json({ success: false, error: 'Forbidden' }, 403);

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
