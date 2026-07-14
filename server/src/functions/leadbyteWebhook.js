import { HttpError, requireUser, json } from './_runtime.js';

// Caller model: public with key.
//
// This endpoint is unauthenticated and must be invocable without a logged-in
// user. It authenticates ONLY by a route token, read from the query param
// `token` or the `X-Webhook-Token` header, SHA-256 hashed and matched against
// an enabled leadbyte InboundWebhookRoute. It looks up the route and reads and
// writes Lead directly at the function layer (no RLS).
//
// This function only RECORDS LeadByte sold/unsold/return/conversion outcome
// data onto the matching Lead. It never calls processLead or any routing,
// delivery, connector, CAPI, or HLR logic. It never writes trustedform_valid
// or cert_source, and never overwrites the inbound pipeline fields.

// Treat a literal single dash and empty string as null. Returns a trimmed
// string, or null when the value is empty/dash/nullish.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  return s;
}

// Coerce to a number, or null when empty/dash/non-numeric.
function num(v) {
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

// Map "buyer_returned" style values to a boolean. Truthy or yes -> true,
// dash/empty/anything else -> false.
function toBool(v) {
  const s = clean(v);
  if (s === null) return false;
  const lower = s.toLowerCase();
  return lower === 'yes' || lower === 'true' || lower === '1' || lower === 'y';
}

// Map the payload lead_status to a valid Lead final_status enum value, or null
// when it is missing or does not map (leaving final_status unchanged).
function mapFinalStatus(v) {
  const s = clean(v);
  if (s === null) return null;
  const map = {
    sold: 'Sold',
    unsold: 'Unsold',
    returned: 'Returned',
    duplicate: 'Duplicate',
    disqualified: 'Disqualified',
    qualified: 'Qualified',
  };
  return map[s.toLowerCase()] || null;
}

// Only set a key when the value is non-null, so we never clobber with null.
function setIf(out, key, value) {
  if (value !== null && value !== undefined) out[key] = value;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async function leadbyteWebhook(ctx) {
  const db = ctx.db;

  // ── Auth gate: route token only, before any Lead access ─────────────────
  const query = (ctx.req && ctx.req.query) || {};
  const headers = (ctx.req && ctx.req.headers) || {};
  const headerToken = headers['x-webhook-token'] || headers['X-Webhook-Token'] || '';
  const token = String(query.token || headerToken || '').trim();
  if (!token) return ctx.json({ error: 'Unauthorized' }, 401);

  let route = null;
  try {
    const tokenHash = await sha256Hex(token);
    const routes = await db.entities.InboundWebhookRoute.filter({
      token_hash: tokenHash,
      enabled: true,
      provider: 'leadbyte',
    });
    route = (Array.isArray(routes) ? routes : [])[0] || null;
  } catch {
    route = null;
  }
  if (!route) return ctx.json({ error: 'Unauthorized' }, 401);

  // ── Parse the outcome payload ───────────────────────────────────────────
  // ctx.body is already parsed by the framework; reconstruct the raw text so
  // we can persist the exact payload the provider sent.
  let body;
  if (ctx.body && typeof ctx.body === 'object') {
    body = ctx.body;
  } else if (typeof ctx.body === 'string') {
    try {
      body = JSON.parse(ctx.body);
    } catch {
      return ctx.json({ error: 'Invalid JSON' }, 400);
    }
  } else {
    return ctx.json({ error: 'Invalid JSON' }, 400);
  }
  const rawBody = JSON.stringify(body);

  try {
    const leadbyteId = num(body.leadbyte_id);
    const finalStatus = mapFinalStatus(body.lead_status);

    // Outcome fields shared by update and create.
    const outcome = {};
    setIf(outcome, 'revenue', num(body.lead_revenue));
    setIf(outcome, 'supplier_payout', num(body.supplier_payout));
    setIf(outcome, 'buyer_id', clean(body.buyer_id));
    setIf(outcome, 'buyer_name', clean(body.buyer_name));
    setIf(outcome, 'buyer_conversion', clean(body.buyer_conversion));
    setIf(outcome, 'buyer_feedback', clean(body.buyer_feedback));
    outcome.buyer_returned = toBool(body.buyer_returned);
    setIf(outcome, 'buyer_return_reason', clean(body.buyer_return_reason));
    setIf(outcome, 'lead_tier', clean(body.lead_tier));
    setIf(outcome, 'lead_score', num(body.lead_score));
    setIf(outcome, 'lead_vertical', clean(body.lead_vertical));
    if (finalStatus !== null) outcome.final_status = finalStatus;
    outcome.leadbyte_outcome_at = new Date().toISOString();
    outcome.leadbyte_outcome_payload = rawBody;

    // Contact fields (used to fill blanks on update, and to seed a create).
    const contactFirst = clean(body.contact_first_name);
    const contactLast = clean(body.contact_last_name);
    const contactEmail = clean(body.contact_email);
    const contactPhone = clean(body.contact_phone);

    let matched = false;
    let leadId = null;
    let resultStatus = finalStatus;

    let existing = null;
    if (leadbyteId !== null) {
      const found = await db.entities.Lead.filter({ leadbyte_lead_id: leadbyteId });
      existing = (Array.isArray(found) ? found : [])[0] || null;
    }

    if (existing) {
      matched = true;
      leadId = existing.id;
      const patch = { ...outcome };
      // Fill contact fields only when currently empty.
      if (!clean(existing.first_name) && contactFirst) patch.first_name = contactFirst;
      if (!clean(existing.last_name) && contactLast) patch.last_name = contactLast;
      if (!clean(existing.email) && contactEmail) patch.email = contactEmail;
      if (!clean(existing.mobile) && contactPhone) patch.mobile = contactPhone;
      await db.entities.Lead.update(existing.id, patch);
      resultStatus = patch.final_status || existing.final_status || null;
    } else {
      const supplierName = clean(body.supplier_source) || clean(body.supplier_brand) || 'LeadByte';
      const createData = {
        ...outcome,
        supplier_name: supplierName,
        // A create must always have a final_status; default to Processing when
        // the payload lead_status did not map.
        final_status: finalStatus || 'Processing',
      };
      if (leadbyteId !== null) createData.leadbyte_lead_id = leadbyteId;
      if (contactFirst) createData.first_name = contactFirst;
      if (contactLast) createData.last_name = contactLast;
      if (contactEmail) createData.email = contactEmail;
      if (contactPhone) createData.mobile = contactPhone;
      const created = await db.entities.Lead.create(createData);
      leadId = created.id;
      resultStatus = createData.final_status;
    }

    // On success, bump receipt telemetry on the route.
    await db.entities.InboundWebhookRoute.update(route.id, {
      receipt_count: (Number(route.receipt_count) || 0) + 1,
      last_received_at: new Date().toISOString(),
    });

    return ctx.json({
      ok: true,
      matched,
      lead_id: leadId,
      final_status: resultStatus,
    }, 200);
  } catch (err) {
    try {
      await db.entities.InboundWebhookRoute.update(route.id, {
        error_count: (Number(route.error_count) || 0) + 1,
        last_error: (err && err.message) || 'Unexpected processing error',
      });
    } catch {
      // Telemetry write must not mask the original error.
    }
    return ctx.json({ error: 'Processing error' }, 500);
  }
}
