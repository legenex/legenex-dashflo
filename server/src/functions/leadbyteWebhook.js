// Caller model: public with key.
//
// This endpoint is unauthenticated and must be invocable without a logged-in
// user. It authenticates ONLY by a route token, read from the query param
// `token` or the `X-Webhook-Token` header, SHA-256 hashed and matched against
// an enabled leadbyte InboundWebhookRoute. It looks up the route and reads and
// writes Lead at the function layer (no RLS).
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
// Payload key -> canonical field.
//
// Each canonical field lists EVERY payload key that can carry it, because two
// payload styles are in use: the original prefixed one (contact_email,
// supplier_sid, geo_state) and the flat one (email, sid, geoip_state). A
// webhook rebuilt with flat keys previously matched nothing at all, since the
// handler could not find an email or phone to match on and silently dropped
// most of the record. First present key wins.
const CANONICAL_MAP = {
  first_name: ['contact_first_name', 'first_name', 'firstname'],
  last_name: ['contact_last_name', 'last_name', 'lastname'],
  email: ['contact_email', 'email'],
  mobile: ['contact_phone', 'mobile', 'phone', 'phone1'],
  zip: ['contact_zip', 'zip', 'postcode'],
  phone_verified: ['contact_phone_verified', 'phone_verified'],
  jornaya_token: ['contact_jornaya_token', 'jornaya_token'],
  optin_url: ['contact_optin_url', 'optin_url', 'optinurl'],
  user_agent: ['contact_user_agent', 'user_agent'],
  trustedform_url: ['contact_trustedform_url', 'trustedform_url'],
  geoip_country: ['geo_country', 'geoip_country', 'country'],
  geoip_state: ['geo_state', 'geoip_state'],
  geoip_city: ['geo_city', 'geoip_city'],
  geoip_zip: ['geo_zip', 'geoip_zip'],
  ip_address: ['geo_ip', 'ip_address', 'ipaddress'],
  geo_language: ['geo_language'],
  utm_source: ['utm_source'],
  utm_campaign: ['utm_campaign'],
  utm_medium: ['utm_medium'],
  utm_content: ['utm_content'],
  utm_terms: ['utm_terms'],
  ad_label: ['utm_ad_label', 'ad_label'],
  sid: ['supplier_sid', 'sid'],
  ssid: ['supplier_ssid', 'ssid'],
  s1: ['supplier_s1', 's1'],
  s2: ['supplier_s2', 's2'],
  s3: ['supplier_s3', 's3'],
  supplier_brand: ['supplier_brand'],
  'Supplier Source': ['supplier_source', 'source'],
  supplier_payout: ['supplier_payout'],
  tc_id: ['tc_id'],
  leadshook_id: ['leadshook_id'],
  accident_state: ['accident_state'],
  accident_type: ['accident_type'],
  accident_details: ['accident_details'],
  incident_date: ['incident_date'],
  injured: ['injured'],
  injury_type: ['injury_type'],
  treatment: ['treatment'],
  treatment_type: ['treatment_type'],
  treatment_time: ['treatment_time'],
  fault: ['fault'],
  attorney: ['attorney'],
  attorney_change: ['attorney_change'],
  insurance: ['insurance'],
  police_report: ['police_report_filed', 'police_report'],
  accident_timeframe: ['accident_date'],
  lead_status: ['lead_status'],
  revenue: ['lead_revenue', 'revenue'],
  vertical: ['lead_vertical', 'vertical'],
  lead_tier: ['lead_tier'],
  buyer_name: ['buyer_name', 'buyername'],
  buyer_id: ['buyer_id', 'buyer'],
  buyer_feedback: ['buyer_feedback'],
  returned: ['buyer_returned'],
  returned_reason: ['buyer_return_reason'],
  lead_id: ['leadbyte_id', 'lead_id', 'leadid'],
  timestamp: ['date_created', 'received', 'timestamp'],
};

// Build the canonical object from the payload, keeping only cleaned present
// values (clean skips null/empty/single-dash).
function buildCanonical(body) {
  const out = {};
  for (const [canonicalKey, payloadKeys] of Object.entries(CANONICAL_MAP)) {
    for (const k of payloadKeys) {
      const value = clean(body[k]);
      if (value !== null) { out[canonicalKey] = value; break; }
    }
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
  const token = (ctx.req.query?.token || ctx.req.headers?.['x-webhook-token'] || '').trim();
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
  // Preserve the exact raw payload for leadbyte_outcome_payload when the
  // transport captured it; otherwise reconstruct from the parsed body.
  const rawBody = typeof ctx.req?.rawBody === 'string' ? ctx.req.rawBody : JSON.stringify(body);

  try {
    const leadbyteId = num(body.leadbyte_id ?? body.lead_id ?? body.leadid);
    const finalStatus = mapFinalStatus(body.lead_status);
    const canonical = buildCanonical(body);

    // Outcome fields shared by update and create.
    //
    // Read from `canonical`, not the raw body, so both payload styles work.
    // Reading body.lead_revenue directly meant a flat-key webhook sending
    // "revenue" recorded no revenue at all.
    const outcome = {};
    setIf(outcome, 'revenue', num(canonical.revenue));
    setIf(outcome, 'supplier_payout', num(canonical.supplier_payout));
    setIf(outcome, 'buyer_id', canonical.buyer_id ?? null);
    setIf(outcome, 'buyer_name', canonical.buyer_name ?? null);
    setIf(outcome, 'buyer_conversion', clean(body.buyer_conversion));
    setIf(outcome, 'buyer_feedback', canonical.buyer_feedback ?? null);
    outcome.buyer_returned = toBool(body.buyer_returned ?? canonical.returned);
    setIf(outcome, 'buyer_return_reason', canonical.returned_reason ?? null);
    setIf(outcome, 'lead_tier', canonical.lead_tier ?? null);
    setIf(outcome, 'lead_score', num(body.lead_score));
    setIf(outcome, 'lead_vertical', canonical.vertical ?? null);
    if (finalStatus !== null) outcome.final_status = finalStatus;
    outcome.leadbyte_outcome_at = new Date().toISOString();
    outcome.leadbyte_outcome_payload = rawBody;

    // Contact fields (used to fill blanks on update, and to seed a create).
    const contactFirst = canonical.first_name || null;
    const contactLast = canonical.last_name || null;
    // Identity fields, read from the canonical object rather than the raw body
    // so both payload styles work. Reading body.contact_email directly is why a
    // flat-key webhook matched nothing.
    const contactEmail = canonical.email || null;
    const contactPhone = canonical.mobile || null;

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
      // No matching lead: CREATE it.
      //
      // Not every lead reaches this system through processLead. Inbounds and
      // other affiliates post straight into LeadByte, so the first this system
      // ever hears of those leads is this webhook. Refusing to create them, and
      // merely logging the outcome, meant real sold leads never appeared here
      // at all and the counts drifted from LeadByte permanently.
      //
      // The earlier no-create rule existed to stop phantom "Processing"
      // duplicates for leads already in flight through processLead. That is
      // handled properly now: the match above checks leadbyte id, then email,
      // then mobile before we get here, so anything reaching this branch is a
      // lead this system genuinely has not seen.
      if (!contactEmail && !contactPhone && leadbyteId === null) {
        // Nothing to identify it by, so creating would guarantee an
        // unmergeable orphan. Record for reconciliation instead.
        try {
          await db.entities.ErrorLog.create({
            stage: 'leadbyte',
            severity: 'warning',
            message: 'Unmatched outcome: no identifying fields on payload',
            supplier_name: canonical.sid || null,
            detail: JSON.stringify({
              reason: 'Outcome webhook carried no email, phone or leadbyte id, so no lead could be created or matched.',
              consequence: 'Nothing was written. Check the webhook payload mapping in LeadByte.',
              payload: body,
            }),
          });
        } catch { /* audit write must never mask the response */ }

        await db.entities.InboundWebhookRoute.update(route.id, {
          receipt_count: (Number(route.receipt_count) || 0) + 1,
          last_received_at: new Date().toISOString(),
        });
        return ctx.json({
          ok: true, matched: false, created: false, lead_id: null, final_status: null,
          message: 'No identifying fields on payload (email, phone or lead id); nothing written.',
        }, 200);
      }

      // lead_type is derived from the supplier id, matching backfillLeadType:
      // LEADFLOW and LGNX are Quiz leads, every other sid is Affiliate.
      // It lives INSIDE mapped_fields, not as a Lead column, so setting it
      // top-level would be silently dropped.
      const sidUpper = String(canonical.sid || '').trim().toUpperCase();
      const leadType = (sidUpper === 'LEADFLOW' || sidUpper === 'LGNX') ? 'Quiz' : 'Affiliate';

      // Resolve the supplier by matching the sid against the Supplier records,
      // loosely, because a sid (LEADFLOW, INBNDS-SURVEY) and a supplier name
      // (LeadFlow, Inbounds) differ in case and suffix. Falls back to the raw
      // sid so the lead is still attributed to something searchable.
      let supplierName = canonical.sid || null;
      try {
        const sups = await db.entities.Supplier.list();
        const norm = (v) => String(v ?? '').trim().toLowerCase();
        const s = norm(canonical.sid);
        const hit = (Array.isArray(sups) ? sups : []).find((x) => {
          const n = norm(x.name);
          return n && s && (n === s || s.includes(n) || n.includes(s));
        });
        if (hit?.name) supplierName = hit.name;
      } catch { /* keep the sid fallback */ }

      const created = await db.entities.Lead.create({
        ...outcome,
        archived: false,
        first_name: contactFirst || undefined,
        last_name: contactLast || undefined,
        email: contactEmail || undefined,
        mobile: contactPhone || undefined,
        supplier_name: supplierName || undefined,
        // The whole canonical payload, plus lead_type and a provenance marker so
        // a lead that arrived this way is identifiable later.
        mapped_fields: JSON.stringify({
          ...canonical,
          lead_type: leadType,
          ingest_channel: 'leadbyte_webhook',
        }),
      });

      leadId = created?.id || null;

      await db.entities.InboundWebhookRoute.update(route.id, {
        receipt_count: (Number(route.receipt_count) || 0) + 1,
        last_received_at: new Date().toISOString(),
      });

      return ctx.json({
        ok: true,
        matched: false,
        created: true,
        lead_id: leadId,
        final_status: finalStatus,
        message: 'Lead did not exist in this system and was created from the outcome payload.',
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
        last_error: err?.message || 'Unexpected processing error',
      });
    } catch {
      // Telemetry write must not mask the original error.
    }
    return ctx.json({ error: 'Processing error' }, 500);
  }
}
