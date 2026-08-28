// Server-side lead resend / resubmit. Task: final engineering cleanup.
//
// The Leads UI used to do this itself: ApiKey.filter({ id: lead.supplier_key_id })
// through the generic entity route, then read .key off the result. That field
// is hash-only at rest and stripped from every generic-route response
// (entityPolicy.js READ_DENY_FIELDS, Task S4) - the raw value was always
// undefined, so every resend silently failed with "supplier key not found".
// Even if the field were readable, the client has no business holding a raw
// supplier posting key at all.
//
// This function resolves the lead's CURRENT supplier credential server-side
// and replays intake through the same processLead pipeline every inbound
// lead uses (see leads.js for the identical in-process call shape), so a
// resend gets exactly the same duplicate handling, routing and dispatch
// behavior a fresh post would. The raw key never leaves the server: it is
// looked up by id/name, not asked for, and only the resolved ApiKey record's
// id and non-secret metadata ever appear in the response.

import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import { getFunction } from './index.js';

const ALLOWED_ROLES = [ROLE.OWNER, ROLE.ADMIN];

function requireAdmin(user) {
  return ALLOWED_ROLES.includes(resolveRoleClass(user));
}

// Resolve the ApiKey that should authenticate this lead's supplier today.
//
// supplier_key_id is trusted as-is when it still resolves to a live, active
// key - that is the strongest signal of which credential this lead actually
// belongs to, and matches the identical staleness fallback
// generateBillingRun.js already uses for supplier billing runs. Only when the
// id is absent or stale (resolves to no current key at all) do we fall back
// to the established Supplier record rather than trusting the obsolete id or
// guessing from a bare name match: a rename or a duplicate supplier name
// fails loudly here instead of silently guessing which supplier this is.
export async function resolveSupplierCredential(db, lead) {
  if (lead.supplier_key_id) {
    const direct = await db.entities.ApiKey.get(String(lead.supplier_key_id)).catch(() => null);
    if (direct && direct.active !== false) {
      return { ok: true, apiKey: direct, resolution: 'supplier_key_id' };
    }
  }

  const supplierName = String(lead.supplier_name || '').trim();
  if (!supplierName) {
    return {
      ok: false,
      code: 'NO_SUPPLIER_IDENTITY',
      reason: 'This lead has no currently-resolvable supplier_key_id and no supplier_name to fall back on.',
    };
  }

  const suppliers = await db.entities.Supplier.filter({ name: supplierName });
  if (suppliers.length === 0) {
    return {
      ok: false,
      code: 'SUPPLIER_NOT_FOUND',
      reason: `No Supplier record matches "${supplierName}". Cannot resolve current credentials for resend.`,
    };
  }
  if (suppliers.length > 1) {
    return {
      ok: false,
      code: 'SUPPLIER_AMBIGUOUS',
      reason: `${suppliers.length} Supplier records match "${supplierName}". Resend cannot determine which one this lead belongs to.`,
    };
  }

  const supplier = suppliers[0];
  const keys = await db.entities.ApiKey.filter({ supplier_id: supplier.id });
  const activeKeys = keys.filter((k) => k.active !== false);
  if (activeKeys.length === 0) {
    return {
      ok: false,
      code: 'NO_ACTIVE_KEY',
      reason: `Supplier "${supplier.name}" (${supplier.id}) has no active API key. Issue one before resubmitting.`,
    };
  }
  if (activeKeys.length > 1) {
    return {
      ok: false,
      code: 'KEY_AMBIGUOUS',
      reason: `Supplier "${supplier.name}" has ${activeKeys.length} active API keys. Resend cannot determine which one to use.`,
    };
  }

  return { ok: true, apiKey: activeKeys[0], resolution: 'supplier_name_fallback', supplier };
}

async function resubmitOne(ctx, id) {
  const lead = await ctx.db.entities.Lead.get(String(id)).catch(() => null);
  if (!lead) return { id, ok: false, code: 'LEAD_NOT_FOUND', reason: 'Lead not found.' };

  let payload;
  try {
    payload = JSON.parse(lead.raw_payload || '{}');
  } catch {
    return {
      id, ok: false, code: 'BAD_RAW_PAYLOAD',
      reason: 'Stored raw_payload is not valid JSON and cannot be replayed.',
    };
  }

  const resolved = await resolveSupplierCredential(ctx.db, lead);
  if (!resolved.ok) return { id, ok: false, code: resolved.code, reason: resolved.reason };

  const processLead = getFunction('processLead');
  if (!processLead) {
    return { id, ok: false, code: 'PIPELINE_UNAVAILABLE', reason: 'Lead processing is not available.' };
  }

  // __resolvedApiKey travels on ctx, never on body. routes/functions.js
  // builds ctx from named fields only and never spreads req.body into it, so
  // no externally posted payload can set this - only this in-process call
  // can. processLead trusts it exactly the way it already trusts a
  // hash-matched key (see processLead.js's AUTH section).
  const innerCtx = { ...ctx, body: payload, __resolvedApiKey: resolved.apiKey };
  let result;
  try {
    result = await processLead(innerCtx);
  } catch (err) {
    return { id, ok: false, code: 'PIPELINE_ERROR', reason: err?.message || 'processLead threw an error.' };
  }
  const body = (result && result.__httpResponse) ? result.body : result;

  return {
    id,
    ok: body?.ok === true,
    code: body?.code || body?.acceptance || null,
    reason: body?.ok === true ? null : (body?.reason || body?.message || 'Rejected by intake pipeline.'),
    resolution: resolved.resolution,
    supplier_name: resolved.apiKey.supplier_name || resolved.supplier?.name || null,
    acceptance: body?.acceptance ?? null,
    lead_status: body?.lead_status ?? null,
  };
}

// op: 'resubmit'. body: { id } for one lead, or { ids: [...] } for bulk.
// Every id is processed independently - one lead's failure (stale key,
// ambiguous supplier, bad payload) never blocks the others in the batch.
export default async function resubmitLead(ctx) {
  if (!requireAdmin(ctx.user)) {
    return ctx.json({ success: false, error: 'Not permitted to resubmit leads' }, 403);
  }

  const body = ctx.body || {};
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(String).filter(Boolean))]
    : (body.id ? [String(body.id)] : []);

  if (ids.length === 0) {
    return ctx.json({ success: false, error: 'Provide a lead id or a non-empty array of ids' }, 400);
  }

  const results = [];
  for (const id of ids) {
    // Sequential by design: this replays intake, which can dispatch to a
    // live buyer/supplier destination when one is active. Bulk resubmit must
    // not fan out concurrently against a real external endpoint just because
    // the batch happens to be large.
    // eslint-disable-next-line no-await-in-loop
    results.push(await resubmitOne(ctx, id));
  }

  const succeeded = results.filter((r) => r.ok).length;
  return ctx.json({
    success: true,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}
