// Public endpoint authenticated only by a route token (query `token` or the
// `X-Webhook-Token` header), SHA-256 hashed and matched against an enabled
// leadbyte InboundWebhookRoute. Reads and writes Lead directly (no RLS at the
// function layer).
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
  // LeadByte sends the literal string "null" for some empty fields.
  if (s.toLowerCase() === 'null') return null;
  // Unresolved merge field, entirely wrapped in braces e.g. {supplier_brand}.
  if (/^\{.*\}$/.test(s)) return null;
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
    returned: 'Returned',
    unsold: 'Unsold',
    rejected: 'Rejected',
  };
  return map[s.toLowerCase()] || null;
}

// Only set a key when the value is non-null, so we never clobber with null.
function setIf(out, key, value) {
  if (value !== null && value !== undefined) out[key] = value;
}

// Translation map: webhook payload key -> app canonical field name. These land
// in Lead.mapped_fields (never first-class outcome columns). Deliberate
// exclusion: contact_trustedform_url (stays only in the raw payload, never in
// mapped_fields, and never written to trustedform_valid or cert_source).
// accident_date maps to the accident_timeframe canonical field (holding the
// raw LeadByte bucket value), never to the Calculated accident_date field.
// supplier_source maps into the "Supplier Source" canonical field like any
// other mapped field and no longer feeds supplier_name.
const CANONICAL_MAP = {
  contact_first_name: 'first_name',
  contact_last_name: 'last_name',
  contact_email: 'email',
  contact_phone: 'mobile',
  contact_zip: 'zip',
  contact_phone_verified: 'phone_verified',
  contact_jornaya_token: 'jornaya_token',
  contact_optin_url: 'optin_url',
  contact_user_agent: 'user_agent',
  geo_country: 'geoip_country',
  geo_state: 'geoip_state',
  geo_city: 'geoip_city',
  geo_zip: 'geoip_zip',
  geo_ip: 'ip_address',
  geo_language: 'geo_language',
  utm_source: 'utm_source',
  utm_campaign: 'utm_campaign',
  utm_medium: 'utm_medium',
  utm_content: 'utm_content',
  utm_terms: 'utm_terms',
  utm_ad_label: 'ad_label',
  supplier_sid: 'sid',
  supplier_ssid: 'ssid',
  supplier_s1: 's1',
  supplier_s2: 's2',
  supplier_s3: 's3',
  supplier_brand: 'supplier_brand',
  supplier_source: 'Supplier Source',
  tc_id: 'tc_id',
  leadshook_id: 'leadshook_id',
  accident_state: 'accident_state',
  accident_type: 'accident_type',
  accident_details: 'accident_details',
  incident_date: 'incident_date',
  injured: 'injured',
  injury_type: 'injury_type',
  treatment: 'treatment',
  treatment_type: 'treatment_type',
  treatment_time: 'treatment_time',
  fault: 'fault',
  attorney: 'attorney',
  attorney_change: 'attorney_change',
  insurance: 'insurance',
  police_report_filed: 'police_report',
  accident_date: 'accident_timeframe',
  lead_status: 'lead_status',
  lead_revenue: 'revenue',
  lead_vertical: 'vertical',
  leadbyte_id: 'lead_id',
  date_created: 'timestamp',
};

// Build the canonical object from the payload, keeping only cleaned present
// values (clean skips null/empty/single-dash).
function buildCanonical(body) {
  const out = {};
  for (const [payloadKey, canonicalKey] of Object.entries(CANONICAL_MAP)) {
    const value = clean(body[payloadKey]);
    if (value !== null) out[canonicalKey] = value;
  }
  return out;
}

// Parse existing mapped_fields JSON to an object; null/empty/invalid -> {}.
function parseMapped(v) {
  const s = clean(v);
  if (s === null) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  const headerToken =
    (ctx.req.headers && (ctx.req.headers['x-webhook-token'] || ctx.req.headers['X-Webhook-Token'])) || '';
  const token = String((ctx.req.query && ctx.req.query.token) || headerToken || '').trim();
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
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ctx.json({ error: 'Invalid JSON' }, 400);
  }
  const rawBody = JSON.stringify(body);

  try {
    const leadbyteId = num(body.leadbyte_id);
    const finalStatus = mapFinalStatus(body.lead_status);
    const canonical = buildCanonical(body);

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
    // 1. Primary match: the LeadByte lead id.
    if (leadbyteId !== null) {
      const found = await db.entities.Lead.filter({ leadbyte_lead_id: leadbyteId });
      existing = (Array.isArray(found) ? found : [])[0] || null;
    }
    // 2. Fallback match: email, then phone. Outcome webhooks for direct-route
    //    leads carry no leadbyte_lead_id (those leads never went to LeadByte),
    //    so match them on contact identity instead of creating a phantom lead.
    if (!existing && contactEmail) {
      const found = await db.entities.Lead.filter({ email: contactEmail });
      existing = (Array.isArray(found) ? found : [])[0] || null;
    }
    if (!existing && contactPhone) {
      const found = await db.entities.Lead.filter({ mobile: contactPhone });
      existing = (Array.isArray(found) ? found : [])[0] || null;
    }

    if (existing) {
      matched = true;
      leadId = existing.id;
      const patch = { ...outcome };
      // Guard: an outcome postback must never downgrade a lead that already
      // sold at intake. If the lead is already Sold, keep it Sold and never
      // zero out its captured revenue.
      const alreadySold = String(existing.final_status || '').toLowerCase() === 'sold';
      if (alreadySold && patch.final_status && patch.final_status !== 'Sold' && !toBool(body.buyer_returned)) {
        delete patch.final_status;
      }
      // Never overwrite an existing non-zero revenue with a null/zero outcome value.
      if (patch.revenue == null || Number(patch.revenue) === 0) {
        if (Number(existing.revenue) > 0) delete patch.revenue;
      }
      // Fill contact fields only when currently empty.
      if (!clean(existing.first_name) && contactFirst) patch.first_name = contactFirst;
      if (!clean(existing.last_name) && contactLast) patch.last_name = contactLast;
      if (!clean(existing.email) && contactEmail) patch.email = contactEmail;
      if (!clean(existing.mobile) && contactPhone) patch.mobile = contactPhone;
      // Merge canonical fields into mapped_fields, filling only blanks so we
      // never overwrite an existing non-empty value.
      const mergedMapped = parseMapped(existing.mapped_fields);
      for (const [key, value] of Object.entries(canonical)) {
        if (clean(mergedMapped[key]) === null) mergedMapped[key] = value;
      }
      patch.mapped_fields = JSON.stringify(mergedMapped);
      await db.entities.Lead.update(existing.id, patch);
      resultStatus = patch.final_status || existing.final_status || null;
    } else {
      // No matching lead. This is an outcome/postback webhook: it records the
      // buyer outcome onto a lead that already exists in our system. It must
      // NEVER create a new lead, because doing so produced phantom "Processing"
      // duplicates for direct-route leads.
      //
      // But it must not vanish either. Returning a bare 200 told LeadByte the
      // outcome was accepted, so it never retried, and the Sold status was
      // dropped on the floor with nothing on screen to show for it. That is the
      // slippage: LeadByte reports a lead as Sold, this system never hears it,
      // and the counts drift apart with no trace of why.
      //
      // Record it as a resolvable error instead. It surfaces on the Settings
      // dashboard with an unresolved count, carries the whole payload so the
      // lead can be reconciled by hand, and is idempotent on repeat delivery.
      const identity = [
        leadbyteId ? `leadbyte_id=${leadbyteId}` : null,
        contactEmail ? `email=${contactEmail}` : null,
        contactPhone ? `phone=${contactPhone}` : null,
      ].filter(Boolean).join(' ') || 'no identifying fields on payload';

      try {
        // Do not pile up a new row every time LeadByte re-sends the same
        // outcome: look for an open one first.
        const priorArr = await db.entities.ErrorLog.filter({
          stage: 'leadbyte',
          resolved: false,
          message: `Unmatched outcome: ${identity}`,
        });
        const prior = (Array.isArray(priorArr) ? priorArr : [])[0] || null;
        if (!prior) {
          await db.entities.ErrorLog.create({
            stage: 'leadbyte',
            severity: 'warning',
            message: `Unmatched outcome: ${identity}`,
            supplier_name: clean(body.supplier_sid) || null,
            detail: JSON.stringify({
              reason: 'Outcome webhook arrived for a lead that is not in this system.',
              consequence: 'Status was NOT applied. This lead will read differently here than in LeadByte until reconciled.',
              lead_status: clean(body.lead_status) || null,
              lead_revenue: body.lead_revenue ?? null,
              buyer_name: clean(body.buyer_name) || null,
              received_at: new Date().toISOString(),
              payload: body,
            }),
          });
        }
      } catch {
        // Never let the audit write mask the acknowledgement below.
      }

      await db.entities.InboundWebhookRoute.update(route.id, {
        receipt_count: (Number(route.receipt_count) || 0) + 1,
        last_received_at: new Date().toISOString(),
      });
      return ctx.json({
        ok: true,
        matched: false,
        lead_id: null,
        final_status: null,
        message: 'No matching lead found; outcome recorded for reconciliation (no lead created).',
      }, 200);
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
