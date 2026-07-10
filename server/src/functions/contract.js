// Read-only, machine-readable intake contract per Campaign. Lets external
// landers, quizzes, and AI intake builders discover exactly which fields to
// collect for a given campaign, without ever leaking revenue, buyers, delivery
// endpoints, connector config, filters, or private fields.
//
// GET /functions/contract
//   - no ?campaign  => list of campaigns the key may read
//   - ?campaign=<id or exact name> => the full contract object for that campaign
//
// Auth: required X-API-KEY header, resolved against the ApiKey entity.
//   master key   => any campaign where contract_enabled is true
//   supplier key => only campaigns whose supplier_ids contains that supplier id
//   No/unknown/inactive key => 401.

const RULES_ENGINE_VERSION = '1.0.0';
const LEADS_ENDPOINT = 'https://api.legenex.com/functions/leads';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-API-KEY, If-None-Match, Content-Type',
  'Access-Control-Expose-Headers': 'ETag',
};

// Best-effort header setter. The standalone runtime exposes the Express request
// on ctx.req; its response object (when present) lets us attach CORS/ETag/cache
// headers without ever crashing the handler if it is unavailable.
function setHeaders(ctx, headers) {
  const res = ctx && ctx.req && ctx.req.res;
  if (!res || typeof res.set !== 'function') return;
  try {
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
  } catch {
    /* never let header plumbing mask the response */
  }
}

// Parse a JSON-in-string field, falling back to the given default on malformed
// input so a bad string never 500s the endpoint.
function safeParse(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val !== 'string') return val;
  try {
    const p = JSON.parse(val);
    return p === null || p === undefined ? fallback : p;
  } catch {
    return fallback;
  }
}

function safeArray(val) {
  const p = safeParse(val, []);
  return Array.isArray(p) ? p : [];
}

async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Which campaigns may this key read? Only contract_enabled campaigns, and for
// supplier keys only those whose supplier_ids array contains the supplier id.
function readableCampaigns(campaigns, apiKey) {
  const enabled = campaigns.filter((c) => c.contract_enabled === true);
  if (apiKey.type === 'master') return enabled;
  const supplierId = apiKey.supplier_id || '';
  if (!supplierId) return [];
  return enabled.filter((c) => safeArray(c.supplier_ids).includes(supplierId));
}

// Build the "collect" array from CustomField rows for this campaign.
function buildCollect(customFields, campaign) {
  const verticalCode = campaign.vertical || '';
  const requiredNames = safeArray(campaign.required_field_names);
  const optionalNames = safeArray(campaign.optional_field_names);
  const hasExplicitLists = requiredNames.length > 0 || optionalNames.length > 0;
  const requiredSet = new Set(requiredNames);

  const passes = (f) => {
    if (f.public === false) return false;
    if (f.source !== 'inbound') return false;
    if (f.field_type === 'Calculated' || f.field_type === 'system') return false;
    const vcodes = safeArray(f.vertical_codes);
    if (vcodes.length > 0 && !vcodes.includes(verticalCode)) return false;
    if (hasExplicitLists) {
      const inLists = requiredSet.has(f.field_name) || optionalNames.includes(f.field_name);
      if (!inLists) return false;
    }
    return true;
  };

  return customFields
    .filter(passes)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((f) => ({
      key: f.field_name,
      label: f.label ?? f.field_name,
      type: f.field_type,
      required: requiredSet.has(f.field_name) ? true : f.required === true,
      required_when: safeParse(f.required_when, null),
      question: f.question_text ?? null,
      enum: safeArray(f.options).length > 0 ? safeArray(f.options) : null,
      validation: safeParse(f.validation, null),
      example: f.sample_value ?? null,
      aliases: safeArray(f.aliases),
    }));
}

// Build the "derived" array: server-side enriched / calculated fields that must
// not be collected by the lander.
function buildDerived(customFields, calculations) {
  const derivedSources = new Set(['hlr', 'leadbyte', 'calculated', 'system']);
  const calcByToken = {};
  for (const c of calculations) {
    if (c.output_token) calcByToken[c.output_token] = c;
  }
  return customFields
    .filter((f) => {
      if (f.public === false) return false;
      return f.field_type === 'Calculated' || derivedSources.has(f.source);
    })
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((f) => {
      const calc = calcByToken[f.field_name];
      return {
        key: f.field_name,
        label: f.label ?? f.field_name,
        inputs: calc && calc.input_field ? [calc.input_field] : [],
        transform: calc && calc.transform_type ? calc.transform_type : f.source,
        note: 'derived server side, do not collect',
      };
    });
}

// Build the "gates" array: required-fields gate always, plus a trustedform gate
// when the campaign requires a valid cert.
function buildGates(collect, campaign) {
  const gates = [];
  const requiredKeys = collect.filter((c) => c.required).map((c) => c.key);
  gates.push({
    type: 'required_fields',
    keys: requiredKeys,
    message: requiredKeys.length
      ? 'Leads missing any required field are Queued and not forwarded.'
      : 'No required fields configured for this campaign.',
  });
  if (campaign.trustedform_required === true) {
    gates.push({
      type: 'trustedform',
      message: 'A lead without a valid TrustedForm cert is Queued and never forwarded.',
    });
  }
  return gates;
}

function buildContract(campaign, customFields, calculations) {
  const collect = buildCollect(customFields, campaign);
  const derived = buildDerived(customFields, calculations);
  const gates = buildGates(collect, campaign);

  return {
    contract_version: campaign.contract_version ?? null,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      vertical: campaign.vertical ?? null,
      send_mode: campaign.send_mode ?? null,
    },
    endpoint: {
      url: LEADS_ENDPOINT,
      method: 'POST',
      auth_header: 'X-API-KEY',
      content_type: 'application/json',
    },
    collect,
    derived,
    gates,
    qualification: safeParse(campaign.qualification_rules, null),
    consent: {
      trustedform_required: campaign.trustedform_required === true,
      tcpa_disclosure_text: campaign.tcpa_disclosure_text ?? null,
    },
    intake_notes: campaign.intake_notes ?? null,
    response_shape: {
      Response: 'Sold | Unsold | Disqualified | Queued | Duplicate | Error',
      reason: 'string',
    },
    rules_engine_version: RULES_ENGINE_VERSION,
  };
}

export default async function contract(ctx) {
  const db = ctx.db;
  const method = ctx.req.method;

  // Advertise CORS on every response, matching the original endpoint.
  setHeaders(ctx, CORS_HEADERS);

  if (method === 'OPTIONS') {
    return ctx.json(null, 204);
  }

  try {
    // ── AUTH ──────────────────────────────────────────────────────────────
    const headers = ctx.req.headers || {};
    const rawKey =
      headers['x-api-key'] ||
      headers['X-API-KEY'] ||
      (ctx.req.get && (ctx.req.get('X-API-KEY') || ctx.req.get('x-api-key'))) ||
      null;
    let apiKey = null;
    if (rawKey) {
      const keys = await db.entities.ApiKey.filter({ key: rawKey });
      if (keys.length > 0 && keys[0].active) apiKey = keys[0];
    }
    if (!apiKey) {
      return ctx.json({ error: 'unauthorized' }, 401);
    }

    const campaignParam = ctx.req.query ? ctx.req.query.campaign : undefined;

    const campaigns = await db.entities.Campaign.list('-created_date', 500);
    const readable = readableCampaigns(campaigns, apiKey);

    // ── LIST MODE ─────────────────────────────────────────────────────────
    if (!campaignParam) {
      const list = readable.map((c) => ({
        id: c.id,
        name: c.name,
        vertical: c.vertical ?? null,
        send_mode: c.send_mode ?? null,
        contract_version: c.contract_version ?? null,
      }));
      return ctx.json({ campaigns: list }, 200);
    }

    // ── CONTRACT MODE ───────────────────────────────────────────────────
    // Match by id or exact name, but only within the readable set so we never
    // leak the existence of campaigns this key cannot read.
    const campaign = readable.find((c) => c.id === campaignParam || c.name === campaignParam);
    if (!campaign) {
      return ctx.json({ error: 'not_found' }, 404);
    }

    const [customFields, calculations] = await Promise.all([
      db.entities.CustomField.list('sort_order', 1000),
      db.entities.CustomCalculation.list('sort_order', 1000),
    ]);

    const built = buildContract(campaign, customFields, calculations);
    const serialized = JSON.stringify(built);
    const etag = `"${await sha256Hex(serialized)}"`;

    const ifNoneMatch = headers['if-none-match'] || headers['If-None-Match'] ||
      (ctx.req.get && (ctx.req.get('If-None-Match') || ctx.req.get('if-none-match')));
    if (ifNoneMatch && ifNoneMatch === etag) {
      setHeaders(ctx, { ETag: etag, 'Cache-Control': 'private, max-age=60' });
      return ctx.json(null, 304);
    }

    setHeaders(ctx, { ETag: etag, 'Cache-Control': 'private, max-age=60' });
    return ctx.json(built, 200);
  } catch (error) {
    try {
      await db.entities.ErrorLog.create({
        stage: 'system',
        severity: 'error',
        message: 'contract build failed',
        detail: JSON.stringify({ error: error.message }),
        supplier_name: 'Contract',
      });
    } catch { /* never let logging failure mask the response */ }
    return ctx.json({ error: 'contract_build_failed' }, 500);
  }
}
