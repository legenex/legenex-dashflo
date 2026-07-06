import crypto from 'node:crypto';
import { requireUser } from './_runtime.js';

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

    // Ensure an ApiKey linked to the selected supplier.
    if (!source.api_key_id && source.supplier_name) {
      let supplierId = '';
      const sup = await db.entities.Supplier.filter({ name: source.supplier_name });
      if (sup[0]) supplierId = sup[0].id;
      const fullKey = genKey('lk_');
      const apiKey = await db.entities.ApiKey.create({
        name: `Source: ${source.name}`,
        type: 'supplier',
        supplier_name: source.supplier_name,
        supplier_id: supplierId,
        key: fullKey,
        key_prefix: fullKey.slice(0, 16),
        active: true,
      });
      updates.api_key_id = apiKey.id;
    }

    // Generate a webhook key for call sources.
    if ((source.kind === 'ringba' || source.kind === 'truecall') && !source.webhook_key) {
      updates.webhook_key = genKey('cw_');
    }

    if (Object.keys(updates).length > 0) {
      await db.entities.LeadSource.update(source.id, updates);
    }

    return ctx.json({ ok: true, ...updates }, 200);
  } catch (error) {
    if (error?.status && error?.body) return ctx.json(error.body, error.status);
    return ctx.json({ error: error.message }, 500);
  }
}
