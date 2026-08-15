import crypto from 'node:crypto';
import { requireUser } from './_runtime.js';
import { mintApiKey, storedFieldsFor } from '../lib/apiKeys.js';

// Provision the credentials a LeadSource needs to ingest through processLead:
// - ensures a supplier ApiKey exists (creates one linked to the chosen supplier)
// - generates a webhook_key for call sources
// Called from the Data Sources UI when saving a source. Admin only.
//
// Payload: { source_id }

function genKey(prefix) {
  const rand = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  return `${prefix}${rand}`.slice(0, 40);
}

export default async function provisionLeadSource(ctx) {
  try {
    const user = requireUser(ctx);
    if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);
    const db = ctx.db;

    const body = ctx.body || {};
    const sources = await db.entities.LeadSource.filter({ id: body.source_id });
    const source = sources[0];
    if (!source) return ctx.json({ error: 'Source not found' }, 404);

    const updates = {};
    let issuedKey = null;

    // Ensure an ApiKey linked to the selected supplier.
    if (!source.api_key_id && source.supplier_name) {
      let supplierId = '';
      const sup = await db.entities.Supplier.filter({ name: source.supplier_name });
      if (sup[0]) supplierId = sup[0].id;
      // Task S4. The key is stored hash-only. The raw value is returned to the
      // caller once, in this response, and is not recoverable afterwards.
      const fullKey = mintApiKey('supplier');
      const apiKey = await db.entities.ApiKey.create({
        name: `Source: ${source.name}`,
        type: 'supplier',
        supplier_name: source.supplier_name,
        supplier_id: supplierId,
        ...storedFieldsFor(fullKey),
        active: true,
      });
      updates.api_key_id = apiKey.id;
      issuedKey = fullKey;
    }

    // Generate a webhook key for call sources.
    if ((source.kind === 'ringba' || source.kind === 'truecall') && !source.webhook_key) {
      updates.webhook_key = genKey('cw_');
    }

    if (Object.keys(updates).length > 0) {
      await db.entities.LeadSource.update(source.id, updates);
    }

    // The raw key is included only when one was just minted. It cannot be
    // retrieved again after this response.
    return ctx.json({
      ok: true,
      ...updates,
      ...(issuedKey ? { api_key: issuedKey, api_key_notice: 'Shown once. Store it now.' } : {}),
    }, 200);
  } catch (error) {
    if (error?.status && error?.body) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
