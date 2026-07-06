// Public posting-spec endpoint (/functions/spec)
// Returns the integration spec a supplier needs to post leads and get them
// accepted & sold: endpoint, headers, required + optional fields, examples.
// Keyed by the supplier's sid + a token derived from their API key, so an
// external supplier can open it without logging into the operator app.
//
// The spec is generated from the SAME system required fields + the supplier's
// mapping that processLead enforces, so it always reflects what is needed to
// accept and sell a lead.

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Deterministic spec token derived from the supplier's API key. No new storage.
async function specToken(apiKey) {
  const buf = new TextEncoder().encode(`legenex-spec:${apiKey}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export default async function spec(ctx) {
  const method = ctx.req.method;
  if (method === 'OPTIONS') return ctx.json(null, 204);
  if (method !== 'GET' && method !== 'POST') {
    return ctx.json({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const db = ctx.db;

    const q = ctx.req.query || {};
    const b = ctx.body || {};
    const sid = (q.sid || b.sid || '').toString().trim();
    const token = (q.t || q.token || b.t || b.token || '').toString().trim();

    if (!sid) {
      return ctx.json({ ok: false, error: 'Missing sid' }, 400);
    }

    // Resolve supplier by sid.
    const suppliers = await db.entities.Supplier.filter({ sid });
    const supplier = suppliers[0];
    if (!supplier) {
      return ctx.json({ ok: false, error: 'Unknown sid' }, 404);
    }

    // Resolve this supplier's API key.
    const allKeys = await db.entities.ApiKey.list();
    const key = allKeys.find((k) => k.supplier_id === supplier.id || k.supplier_name === supplier.name);
    if (!key || !key.key) {
      return ctx.json({ ok: false, error: 'No API key for this supplier' }, 404);
    }

    // Validate the token.
    const expected = await specToken(key.key);
    if (!token || token !== expected) {
      return ctx.json({ ok: false, error: 'Invalid token' }, 401);
    }

    const [appSettingsArr, customFields, campaigns, verticals, buyers] = await Promise.all([
      db.entities.AppSettings.list(),
      db.entities.CustomField.list(),
      db.entities.Campaign.list(),
      db.entities.Vertical.list(),
      db.entities.Buyer.list(),
    ]);
    const appSettings = appSettingsArr[0] || {};
    const baseUrl = (appSettings.public_base_url || 'https://api.legenex.com').replace(/\/+$/, '');

    const specResult = buildSpec({
      supplier, key, baseUrl,
      customFields, campaigns, verticals, buyers, token: expected,
    });

    return ctx.json({ ok: true, spec: specResult }, 200);
  } catch (err) {
    return ctx.json({ ok: false, error: err.message || 'Internal error' }, 500);
  }
}

// ── Spec builder (kept in sync with processLead's required-fields gate) ──────
// A field is required if CustomField.required is true (and it is not a system /
// system_role field, which are system-populated and never inbound-gated). We
// also fold in the fields the supplier's mapped campaigns / verticals / buyers
// depend on for routing (vertical, sid, brand).
function buildSpec(input) {
  const { supplier, key, baseUrl, customFields, campaigns, verticals, buyers, token } = input;

  const supplierSid = supplier.sid || supplier.name || '';
  const supplierVertical = supplier.vertical || '';

  // System-required fields (from CustomFields), excluding system-populated ones.
  const accepted = (customFields || [])
    .filter((f) => f.field_type !== 'Calculated')
    .map((f) => ({
      field_name: f.field_name,
      type: f.field_type === 'system' ? 'system' : (f.field_type || 'string'),
      required: !!f.required && f.field_type !== 'system' && !f.system_role,
      system: f.field_type === 'system' || !!f.system_role,
      example: sampleFor(f, supplierSid, supplierVertical),
    }));

  // Routing fields the supplier's mapped campaigns / verticals / buyers depend on.
  const assignedCampaignIds = parseJsonArray(supplier.campaign_ids);
  const mappedCampaigns = (campaigns || []).filter((c) => assignedCampaignIds.includes(c.id));
  const routingRequired = new Set(['sid', 'vertical']);
  // If any mapped campaign / vertical / buyer is present, brand helps routing.
  if (mappedCampaigns.length > 0 || (verticals || []).length > 0 || (buyers || []).length > 0) {
    routingRequired.add('trustedform_url');
  }

  // Ensure routing-required fields appear as required even if not flagged.
  const byName = new Map();
  for (const f of accepted) byName.set(f.field_name, f);
  for (const rf of routingRequired) {
    const existing = byName.get(rf);
    if (existing) { existing.required = true; }
    else {
      const injected = {
        field_name: rf, type: 'string', required: true, system: false,
        example: sampleFor({ field_name: rf }, supplierSid, supplierVertical),
      };
      byName.set(rf, injected);
      accepted.push(injected);
    }
  }

  const requiredFields = accepted.filter((f) => f.required && !f.system);
  const optionalFields = accepted.filter((f) => !f.required && !f.system);

  // Example request body from the required + a few common fields.
  const exampleBody = {};
  for (const f of requiredFields) exampleBody[f.field_name] = f.example;
  if (!exampleBody.sid) exampleBody.sid = supplierSid;
  if (!exampleBody.vertical) exampleBody.vertical = supplierVertical || 'mva';

  const nowIso = new Date().toISOString();

  return {
    supplier_name: supplier.name,
    sid: supplierSid,
    vertical: supplierVertical,
    endpoint: `${baseUrl}/functions/leads`,
    method: 'POST',
    content_type: 'application/json',
    headers: [
      { key: 'X-API-KEY', value: key.key, description: 'Your supplier API key' },
      { key: 'Content-Type', value: 'application/json', description: '' },
    ],
    spec_url: `${baseUrl}/functions/spec?sid=${encodeURIComponent(supplierSid)}&t=${token}`,
    required_fields: requiredFields,
    optional_fields: optionalFields,
    example_body: exampleBody,
    example_responses: buildExampleResponses(nowIso),
    generated_at: nowIso,
  };
}

function sampleFor(f, sid, vertical) {
  if (f.sample_value) return f.sample_value;
  const name = String(f.field_name || '').toLowerCase();
  const map = {
    sid, vertical: vertical || 'mva',
    first_name: 'John', last_name: 'Doe', firstname: 'John', lastname: 'Doe',
    email: 'john.doe@example.com',
    mobile: '13105551234', phone: '13105551234', phone1: '13105551234',
    zip: '90210', zipcode: '90210', state: 'CA', city: 'Los Angeles',
    trustedform_url: 'https://cert.trustedform.com/0000000000000000000000000000000000000000',
    ip_address: '203.0.113.10', optin_url: 'https://landing.example.com/offer',
    lead_status: 'Qualified',
  };
  if (map[name] !== undefined) return map[name];
  if (f.field_type === 'number') return '0';
  if (f.field_type === 'boolean') return 'true';
  if (f.field_type === 'date') return '1990-01-15';
  return 'sample';
}

// Layered envelope examples — same shape processLead returns (buildEnvelope).
function envelope(over) {
  return {
    ok: true,
    trace_id: 't_example_0001',
    received_at: '2026-01-01T12:00:00.000Z',
    acceptance: 'accepted',
    lead_id: '100234',
    lead_status: 'sold',
    sold: true,
    revenue: 42,
    currency: 'USD',
    code: 'SOLD',
    reason: null,
    message: 'Lead sold',
    Response: 'Sold',
    ...over,
  };
}

function buildExampleResponses(_nowIso) {
  return {
    accepted_sold: envelope({}),
    unsold: envelope({
      acceptance: 'accepted', lead_status: 'unsold', sold: false, revenue: null,
      code: 'UNSOLD', reason: 'No buyer match for this lead',
      message: 'No buyer match for this lead', Response: 'Unsold',
    }),
    queued: envelope({
      acceptance: 'queued', lead_status: 'queued', sold: false, revenue: null,
      code: 'MISSING_FIELDS', reason: 'Missing required fields: trustedform_url',
      message: 'Missing required fields: trustedform_url', Response: 'Queued',
    }),
  };
}
