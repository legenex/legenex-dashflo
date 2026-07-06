// Core lead-processing pipeline. Ported to Node ESM.
//
// Accepts an inbound lead from a supplier, authenticates the API key, creates
// the Lead record, runs HLR phone verification, email validation, TrustedForm
// gating, custom calculations, fires conversion-event connectors (Facebook
// CAPI / webhooks) and delivery destinations, forwards qualified leads to
// LeadByte, then maps the LeadByte response back to a layered supplier envelope.

// Resolve phone_verified value from HLR result based on configured source
function resolvePhoneVerified(hlrResult, source) {
  if (!hlrResult) return '';
  if (source === 'lh_hlr_response') return hlrResult.lh_hlr_response || '';
  if (source === 'summary_score') return String(hlrResult.summary_score ?? '');
  if (source === 'boolean') return hlrResult.lh_hlr_response === 'Exact Match' ? 'true' : 'false';
  return hlrResult.lh_hlr_response || '';
}

function formatTimestamp(date, fmt) {
  const pad = (n) => String(n).padStart(2, '0');
  return (fmt || 'MM/DD/YYYY HH:MM:SS')
    .replace('YYYY', date.getUTCFullYear())
    .replace('MM', pad(date.getUTCMonth() + 1))
    .replace('DD', pad(date.getUTCDate()))
    .replace('HH', pad(date.getUTCHours()))
    .replace('MM', pad(date.getUTCMinutes()))
    .replace('SS', pad(date.getUTCSeconds()));
}

// Evaluate a single conditional condition against the full lead context.
// All string comparisons are case-insensitive and trimmed.
function evalConditionalCondition(ctx, cond) {
  const raw = ctx[cond.field];
  const actual = String(raw ?? '').trim().toLowerCase();
  const expected = String(cond.value ?? '').trim().toLowerCase();
  switch (cond.operator) {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'contains': return actual.includes(expected);
    case 'not_contains': return !actual.includes(expected);
    case 'in': return expected.split(',').map(s => s.trim()).some(item => item !== '' && item === actual);
    case 'not_in': return !expected.split(',').map(s => s.trim()).some(item => item !== '' && item === actual);
    case 'exists': return raw !== null && raw !== undefined && String(raw).trim() !== '';
    case 'not_exists': return raw === null || raw === undefined || String(raw).trim() === '';
    default: return false;
  }
}

function runCalculations(calcs, leadData, hlrResult, phoneVerifiedSource, phoneVerifiedFieldName, supplierType) {
  const enriched = { ...leadData };
  enriched[phoneVerifiedFieldName || 'phone_verified'] = resolvePhoneVerified(hlrResult, phoneVerifiedSource);
  const sorted = [...calcs].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const calc of sorted) {
    if (!calc.enabled) continue;
    let cfg = {};
    try { cfg = JSON.parse(calc.config || '{}'); } catch {}
    const inputValue = enriched[calc.input_field] ?? '';
    // Full-lead context: every enriched field, plus supplier_type from the
    // supplier record, plus lead_status / final_status when already set (they
    // may be empty during enrichment, which is expected).
    const ctx = {
      ...enriched,
      supplier_type: supplierType || enriched.supplier_type || '',
      lead_status: enriched.lead_status ?? '',
      final_status: enriched.final_status ?? '',
    };
    try {
      if (calc.transform_type === 'date_age_bucket') {
        const fmt = cfg.date_format || 'MM/DD/YYYY';
        let parsed = null;
        if (fmt === 'MM/DD/YYYY') {
          const parts = String(inputValue).split('/');
          if (parts.length === 3) parsed = new Date(`${parts[2]}-${parts[0]}-${parts[1]}T00:00:00Z`);
        } else if (fmt === 'YYYY-MM-DD') {
          parsed = new Date(inputValue + 'T00:00:00Z');
        } else {
          parsed = new Date(inputValue);
        }
        if (parsed && !isNaN(parsed)) {
          const ageDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
          const buckets = (cfg.buckets || []).slice().sort((a, b) => a.max_days - b.max_days);
          let matched = cfg.fallback || '';
          for (const b of buckets) { if (ageDays <= b.max_days) { matched = b.label; break; } }
          enriched[calc.output_token] = matched;
        } else { enriched[calc.output_token] = cfg.fallback || ''; }
      } else if (calc.transform_type === 'value_map') {
        const map = cfg.map || {};
        const normalized = String(inputValue).trim().toLowerCase();
        if (map[inputValue] !== undefined) { enriched[calc.output_token] = map[inputValue]; }
        else {
          const matchKey = Object.keys(map).find(k => k.trim().toLowerCase() === normalized);
          enriched[calc.output_token] = matchKey !== undefined ? map[matchKey] : inputValue;
        }
      } else if (calc.transform_type === 'conditional') {
        const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
        let output = cfg.fallback ?? '';
        for (const rule of rules) {
          const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
          const allMatch = conditions.every(cond => evalConditionalCondition(ctx, cond));
          if (allMatch) { output = rule.output ?? ''; break; }
        }
        enriched[calc.output_token] = output;
      } else if (calc.transform_type === 'clone') {
        enriched[calc.output_token] = inputValue;
      } else if (calc.transform_type === 'script') {
        enriched[calc.output_token] = inputValue;
      }
    } catch { enriched[calc.output_token] = inputValue; }
  }
  return enriched;
}

async function buildPayloadFromTemplate(template, data) {
  if (!template) return data;
  const tmpl = typeof template === 'string' ? template : JSON.stringify(template);
  const resolved = await resolveTemplate(tmpl, data, null);
  try { return JSON.parse(resolved); } catch { return resolved; }
}

// ── CAPI helpers ──────────────────────────────────────────────────────────

async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Atomically increment the lead_id counter and return the next unique value.
// Uses optimistic locking: read current value, conditional-write next value,
// retry if another request changed it first.
async function nextLeadId(db) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const counters = await db.entities.Counter.filter({ name: 'lead_id' });
    let counter = counters[0];
    if (!counter) {
      try {
        counter = await db.entities.Counter.create({ name: 'lead_id', value: 0, updated_at: new Date().toISOString() });
      } catch { continue; }
    }
    const nextValue = (counter.value || 0) + 1;
    const result = await db.entities.Counter.updateMany(
      { name: 'lead_id', value: counter.value },
      { $set: { value: nextValue, updated_at: new Date().toISOString() } }
    );
    if (result.updated > 0) return nextValue;
  }
  throw new Error('Failed to acquire lead_id after retries');
}

function normalizeStr(s) { return String(s || '').trim().toLowerCase(); }

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits;
}

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Build Facebook CAPI user_data object from lead data. Uses pre-hashed values
// from inbound if available, otherwise computes SHA-256.
async function buildCapiUserData(d) {
  const ud = {};
  if (d.email_hash) ud.em = [d.email_hash];
  else if (d.email) ud.em = [await sha256Hex(normalizeStr(d.email))];
  if (d.phone_hash) ud.ph = [d.phone_hash];
  else if (d.mobile) ud.ph = [await sha256Hex(normalizePhone(d.mobile))];
  if (d.first_name_hash) ud.fn = [d.first_name_hash];
  else if (d.first_name) ud.fn = [await sha256Hex(normalizeStr(d.first_name))];
  if (d.last_name_hash) ud.ln = [d.last_name_hash];
  else if (d.last_name) ud.ln = [await sha256Hex(normalizeStr(d.last_name))];
  if (d.city_hash) ud.ct = [d.city_hash];
  else if (d.city) ud.ct = [await sha256Hex(normalizeStr(d.city))];
  if (d.state_hash) ud.st = [d.state_hash];
  else if (d.state) ud.st = [await sha256Hex(normalizeStr(d.state))];
  if (d.zip_hash) ud.zp = [d.zip_hash];
  else if (d.zip) ud.zp = [await sha256Hex(normalizeStr(d.zip))];
  if (d.country_hash) ud.country = [d.country_hash];
  else if (d.country) ud.country = [await sha256Hex(normalizeStr(d.country))];
  if (d.ip_address || d.ipaddress) ud.client_ip_address = d.ip_address || d.ipaddress;
  if (d.user_agent) ud.client_user_agent = d.user_agent;
  if (d.fbc) ud.fbc = d.fbc;
  if (d.fbp) ud.fbp = d.fbp;
  if (d.external_id_hash) ud.external_id = d.external_id_hash;
  else if (d.external_id) ud.external_id = await sha256Hex(normalizeStr(d.external_id));
  else if (d.lead_id != null) ud.external_id = await sha256Hex(String(d.lead_id));
  return ud;
}

// Default Facebook CAPI payload template using unified {{token}} syntax.
// Auto-hash (auto_hash_capi=true) handles SHA-256 of user_data fields automatically.
const DEFAULT_CAPI_TEMPLATE = JSON.stringify({
  data: [{
    event_name: "{{lead_event}}",
    event_time: "{{event_time}}",
    action_source: "website",
    event_id: "{{event_id}}",
    event_source_url: "{{optin_url}}",
    user_data: {
      client_user_agent: "{{user_agent}}",
      client_ip_address: "{{ip_address}}",
      fbc: "{{fbc}}",
      fbp: "{{fbp}}",
      em: "{{email}}",
      ph: "{{mobile}}",
      fn: "{{first_name}}",
      ln: "{{last_name}}",
      ct: "{{geoip_city}}",
      st: "{{geoip_state}}",
      zp: "{{zip}}",
      country: "{{geoip_country}}",
      external_id: "{{lead_id}}"
    },
    custom_data: {
      content_name: "{{content_name}}",
      content_category: "{{content_category}}",
      vertical: "{{vertical}}",
      brand: "{{brand}}",
      funnel_name: "{{funnel_name}}",
      qualification_status: "{{qualification_status}}",
      event_category: "{{event_category}}",
      lead_event_type: "{{lead_event_type}}",
      value: "{{value}}"
    }
  }]
}, null, 2);

// Normalize a US phone to 1XXXXXXXXXX: strip non-digits, remove leading 1, prepend 1 + 10 digits.
function phoneUs(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return '1' + digits;
  return digits;
}

// Escape a string for safe insertion into a JSON string value position.
function escapeJsonString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

// Unified token resolver - same engine for LeadByte and CAPI templates.
// Resolves {{token}} and {{token|transform}} against the lead data object.
function resolveTokenValue(token, d, leadId) {
  switch (token) {
    case '_c_eventtime':
    case 'event_time':
      return String(Math.floor(Date.now() / 1000));
    case '_c_eventurl':
    case 'optin_url':
      return d.optin_url || d.optinurl || d.landing_page_url || d.landingpage_url || '';
    case '_device_userAgent':
    case 'user_agent':
      return d.user_agent || d.useragent || '';
    case '_tracking__fbc':
    case 'fbc':
      return d.fbc || d._tracking__fbc || '';
    case '_tracking__fbp':
    case 'fbp':
      return d.fbp || d._tracking__fbp || '';
    case '_geoip_city':
    case 'geoip_city':
    case 'city':
      return d.geoip_city || d.city || d._geoip_city || '';
    case '_geoip_regionName':
    case 'geoip_state':
    case 'state':
      return d.geoip_state || d.state || d._geoip_regionName || '';
    case '_geoip_countryName':
    case 'geoip_country':
    case 'country':
      return d.geoip_country || d.country || d._geoip_countryName || '';
    case 'mobile_raw':
    case 'mobile':
      return d.mobile || d.phone1 || d.phone || d.phone_number || '';
    case 'conv_value':
      return d.conv_value != null ? String(d.conv_value) : '';
    case 'event_id':
      return d.event_id || d.eventId || (leadId ? String(leadId) : '');
    case 'ip_address':
      return d.ip_address || d.ipaddress || '';
    case 'lead_id':
      return d.lead_id != null ? String(d.lead_id) : '';
    case 'email':
      return d.email || '';
    case 'first_name':
      return d.first_name || d.firstname || '';
    case 'last_name':
      return d.last_name || d.lastname || '';
    case 'zip':
      return d.zip || d.zipcode || '';
    case 'lead_event':
      return d.lead_event || '';
    case 'accident_state':
      return d.accident_state || d.state || '';
    case 'trustedform_url':
      return d.trustedform_url || d.trustedform_cert_url || d.trustedform_cert || '';
    case 'jornaya_token':
      return d.jornaya_token || d.leadid_token || d.jornayaid || '';
    case 'fault':
      return d.fault || d.at_fault || d.atfault || '';
    case 'treatment':
      return d.treatment || d.physical_injury || d.injury || '';
    case 'attorney':
      return d.attorney || d.with_lawyer || d.has_attorney || d.lawyer || '';
    case 'incident_date_2':
      return d.incident_date_2 || d.incident_date || d.accident_date || '';
    case 'incident_date_3':
      return d.incident_date_3 || d.incident_date || d.accident_date || '';
    case 'accident_details':
      return d.accident_details || d.case_description || d.accident_description || '';
    default:
      const val = d[token];
      return val !== undefined && val !== null ? String(val) : '';
  }
}

// Apply a single pipe transform to a string value.
async function applyTransform(value, transform) {
  switch (transform) {
    case 'sha256': return await sha256Hex(value);
    case 'lowercase': return String(value).toLowerCase();
    case 'uppercase': return String(value).toUpperCase();
    case 'trim': return String(value).trim();
    case 'phone_us': return phoneUs(value);
    default: return value;
  }
}

// Resolve all {{token|transform}} placeholders in a template string.
async function resolveTemplate(templateStr, data, leadId) {
  const pattern = /\{\{([\w.]+(?:\|[\w]+)*)\}\}/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(templateStr)) !== null) {
    matches.push({ expr: m[1], index: m.index, length: m[0].length });
  }
  const resolved = await Promise.all(matches.map(async (match) => {
    const parts = match.expr.split('|').map(s => s.trim());
    const token = parts[0];
    const transforms = parts.slice(1);
    let value = resolveTokenValue(token, data || {}, leadId);
    for (const t of transforms) {
      value = await applyTransform(value, t);
    }
    return escapeJsonString(value);
  }));
  let result = templateStr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    result = result.slice(0, match.index) + resolved[i] + result.slice(match.index + match.length);
  }
  return result;
}

// Auto-hash Meta-required user_data fields after normalization.
// Skips fields whose template token already includes |sha256 (manual override).
const AUTO_HASH_KEYS = new Set(['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id', 'db', 'ge']);

function normalizeForHashing(key, value) {
  const v = String(value || '');
  if (key === 'ph') return phoneUs(v);
  return v.trim().toLowerCase();
}

async function applyAutoHash(body, templateStr) {
  if (!body.data || !Array.isArray(body.data)) return body;
  const manuallyHashed = new Set();
  try {
    const tmplObj = JSON.parse(templateStr);
    for (let i = 0; i < (tmplObj.data || []).length; i++) {
      const ud = tmplObj.data[i]?.user_data;
      if (!ud) continue;
      for (const key of Object.keys(ud)) {
        if (String(ud[key] || '').includes('|sha256')) manuallyHashed.add(`${i}.${key}`);
      }
    }
  } catch {}
  for (let i = 0; i < body.data.length; i++) {
    const ud = body.data[i]?.user_data;
    if (!ud) continue;
    for (const key of Object.keys(ud)) {
      if (!AUTO_HASH_KEYS.has(key)) continue;
      if (manuallyHashed.has(`${i}.${key}`)) continue;
      const val = String(ud[key] || '');
      if (!val) continue;
      ud[key] = await sha256Hex(normalizeForHashing(key, val));
    }
  }
  return body;
}

// Send a single Facebook CAPI event using the connector's payload template.
async function sendCapiEvent(conn, leadData, leadId, eventName, trigger) {
  const apiVer = conn.fb_api_version || 'v21.0';
  const pixel = conn.fb_pixel_id;
  const token = conn.fb_access_token;
  const url = `https://graph.facebook.com/${apiVer}/${pixel}/events?access_token=${token}`;

  const templateStr = (conn.payload_template && conn.payload_template.trim() && conn.payload_template.trim() !== '{}')
    ? conn.payload_template
    : DEFAULT_CAPI_TEMPLATE;

  const ctx = { ...leadData, lead_event: eventName };

  // Resolve per-trigger custom_data overrides first and expose them as tokens
  // (e.g. {{content_name}}, {{value}}) so the template pulls them dynamically.
  const ctxWithOverrides = { ...ctx };
  if (trigger && conn.trigger_data_overrides) {
    try {
      const overrides = JSON.parse(conn.trigger_data_overrides);
      const ov = overrides[trigger];
      if (ov && typeof ov === 'object') {
        for (const k of Object.keys(ov)) {
          if (!ov[k]) continue;
          const resolved = await resolveTemplate(String(ov[k]), ctx, leadId);
          const trimmed = resolved.trim();
          try { ctxWithOverrides[k] = JSON.parse(trimmed); }
          catch { ctxWithOverrides[k] = resolved; }
        }
      }
    } catch {}
  }

  let body;
  try {
    const resolved = await resolveTemplate(templateStr, ctxWithOverrides, leadId);
    body = JSON.parse(resolved);
  } catch (err) {
    return {
      connector: conn.name, event_name: eventName, pixel,
      http_status: null, fbtrace_id: '', success: false,
      error: `Template resolution failed: ${err.message}`, value: '', payload: null,
    };
  }

  if (conn.auto_hash_capi !== false) {
    body = await applyAutoHash(body, templateStr);
  }

  if (body.data && body.data[0]) {
    body.data[0].event_name = eventName;
  }

  // Apply per-trigger custom_data overrides (merge into data[0].custom_data).
  if (trigger && conn.trigger_data_overrides && body.data && body.data[0]) {
    try {
      const overrides = JSON.parse(conn.trigger_data_overrides);
      const ov = overrides[trigger];
      if (ov && typeof ov === 'object') {
        if (!body.data[0].custom_data) body.data[0].custom_data = {};
        for (const k of Object.keys(ov)) {
          if (!ov[k]) continue;
          const resolved = await resolveTemplate(String(ov[k]), ctx, leadId);
          const trimmed = resolved.trim();
          try { body.data[0].custom_data[k] = JSON.parse(trimmed); }
          catch { body.data[0].custom_data[k] = resolved; }
        }
      }
    } catch {}
  }

  if (conn.fb_test_event_code) body.test_event_code = conn.fb_test_event_code;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let fbResult;
    try { fbResult = JSON.parse(text); } catch { fbResult = { raw: text }; }
    const eventsReceived = fbResult.events_received;
    // A 200 with events_received:0 (or an error object) is a real failure.
    const fbOk = resp.ok && !fbResult.error && (eventsReceived == null || eventsReceived >= 1);
    const sentValue = body?.data?.[0]?.custom_data?.value ?? '';
    const errMsg = fbResult.error
      ? (typeof fbResult.error === 'object' ? JSON.stringify(fbResult.error) : String(fbResult.error))
      : (eventsReceived === 0 ? 'events_received: 0' : '');
    return {
      connector: conn.name, event_name: eventName, pixel,
      http_status: resp.status, fbtrace_id: fbResult.fbtrace_id || '',
      success: fbOk, value: sentValue, fb_response: fbResult, error: errMsg,
      payload: body || null,
    };
  } catch (err) {
    return {
      connector: conn.name, event_name: eventName, pixel,
      http_status: null, fbtrace_id: '', success: false, error: err.message,
      value: body?.data?.[0]?.custom_data?.value ?? '', payload: body || null,
    };
  }
}

// Send a webhook/generic_http event.
async function sendHttpEvent(conn, leadData, leadId, eventName) {
  const ctx = { ...leadData };
  if (ctx.lead_id == null) ctx.lead_id = leadId;
  if (eventName) ctx.lead_event = eventName;
  const payload = await buildPayloadFromTemplate(conn.payload_template, ctx);
  const headerRows = parseJsonArray(conn.headers);
  const hdrs = {};
  for (const r of headerRows) { if (r.key) hdrs[r.key] = r.value; }
  const ct = conn.content_type || 'application/json';
  hdrs['Content-Type'] = ct;
  let bodyStr;
  if (ct === 'application/x-www-form-urlencoded') {
    bodyStr = new URLSearchParams(typeof payload === 'object' ? payload : {}).toString();
  } else {
    bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  try {
    const resp = await fetch(conn.target_url, { method: conn.http_method || 'POST', headers: hdrs, body: bodyStr });
    return { connector: conn.name, http_status: resp.status, success: resp.ok };
  } catch (err) {
    return { connector: conn.name, http_status: null, success: false, error: err.message };
  }
}

// Send to a delivery destination and capture the payload + full response body.
// Used by the pre-classified (Disqualified / custom) bypass path, which must
// await sends (so logs populate) and return the actual endpoint response.
async function sendDestinationAwait(dest, leadData, leadId, trigger) {
  const ctx = { ...leadData };
  if (ctx.lead_id == null) ctx.lead_id = leadId;
  const payload = await buildPayloadFromTemplate(dest.payload_template, ctx);
  const headerRows = parseJsonArray(dest.headers);
  const hdrs = {};
  for (const r of headerRows) { if (r.key) hdrs[r.key] = r.value; }
  const ct = dest.content_type || 'application/json';
  hdrs['Content-Type'] = ct;
  let bodyStr;
  if (ct === 'application/x-www-form-urlencoded') {
    bodyStr = new URLSearchParams(typeof payload === 'object' ? payload : {}).toString();
  } else {
    bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  try {
    const resp = await fetch(dest.target_url, { method: dest.http_method || 'POST', headers: hdrs, body: bodyStr });
    const text = await resp.text();
    return { connector: dest.api_name, trigger, http_status: resp.status, success: resp.ok, error: '', payload: bodyStr, response: text };
  } catch (err) {
    return { connector: dest.api_name, trigger, http_status: null, success: false, error: err.message, payload: bodyStr, response: '' };
  }
}

// Built-in lead statuses that fire via lifecycle triggers. Any other lead_status
// value (e.g. "24m Lead") fires via the custom-status trigger point after enrichment.
const BUILTIN_LEAD_STATUSES = ['Qualified', 'Disqualified', 'Sold', 'Unsold', 'Rejected', 'Duplicates', 'Queued'];
function triggerKeyForStatus(statusLabel) {
  const map = { Qualified: 'on_received', Sold: 'on_sold', Unsold: 'on_unsold', Disqualified: 'on_dq', Queued: 'on_queued', Rejected: 'on_rejected', Duplicates: 'on_duplicates' };
  if (map[statusLabel]) return map[statusLabel];
  const slug = String(statusLabel || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `on_${slug || 'status'}`;
}

// Check if a connector's filters match the current lead.
function connectorMatchesFilters(conn, leadData, supplierAttribution, supplierRecord) {
  const verticals = parseJsonArray(conn.filter_verticals);
  if (verticals.length > 0) {
    const lv = leadData.vertical || '';
    if (!verticals.includes(lv)) return false;
  }
  const brands = parseJsonArray(conn.filter_brands);
  if (brands.length > 0) {
    const lb = leadData.supplier_brand || leadData.brand || '';
    if (!brands.includes(lb)) return false;
  }
  const suppliers = parseJsonArray(conn.filter_suppliers);
  if (suppliers.length > 0) {
    const sn = supplierAttribution || '';
    const sid = leadData.sid || leadData.supplier_sid || '';
    if (!suppliers.includes(sn) && !suppliers.includes(sid)) return false;
  }
  const types = parseJsonArray(conn.filter_supplier_types);
  if (types.length > 0) {
    const st = supplierRecord?.supplier_type || '';
    if (!types.includes(st)) return false;
  }
  const routes = parseJsonArray(conn.filter_routes);
  if (routes.length > 0) {
    const lr = String(leadData.lead_route || 'standard').trim().toLowerCase();
    const ri = {
      direct: lr.includes('direct'),
      data: lr.includes('data'),
      event: lr.includes('event'),
      queue: lr.includes('queue'),
    };
    ri.standard = !ri.direct && !ri.data && !ri.event && !ri.queue;
    if (!routes.some(r => ri[r])) return false;
  }
  return true;
}

// Check if a connector's field conditions match the enriched lead data.
// Uses the same applyOperator used for response mapping.
function connectorMatchesConditions(conn, leadData) {
  const conditions = parseJsonArray(conn.filter_conditions);
  if (conditions.length === 0) return true;
  for (const cond of conditions) {
    const actual = leadData[cond.field];
    if (!applyOperator(actual, cond.operator, cond.value || '')) return false;
  }
  return true;
}

// Does the current lead_route match a verification settings' route filter?
// Empty filter defaults to the original HLR/email routes (standard, direct, data).
function routeMatchesFilter(settings, routeIs) {
  if (!settings) return routeIs.standard || routeIs.direct || routeIs.data;
  const routes = parseJsonArray(settings.filter_routes);
  if (routes.length === 0) return routeIs.standard || routeIs.direct || routeIs.data;
  return routes.some(r => routeIs[r]);
}

// Does the current supplier match a verification settings' supplier filter?
function supplierMatchesFilter(settings, supplierAttribution, supplierRecord) {
  if (!settings) return true;
  const suppliers = parseJsonArray(settings.filter_suppliers);
  if (suppliers.length > 0) {
    const sn = supplierAttribution || '';
    const sid = supplierRecord?.sid || '';
    if (!suppliers.includes(sn) && !suppliers.includes(sid)) return false;
  }
  const types = parseJsonArray(settings.filter_supplier_types);
  if (types.length > 0) {
    const st = supplierRecord?.supplier_type || '';
    if (!types.includes(st)) return false;
  }
  return true;
}

// Resolve the event name for a given trigger from the connector's per-trigger fields.
// on_received: received_event_name || lead_event_name || 'Lead'
// on_unsold: unsold_event_name || 'Lead'
// on_queued: queued_event_name || 'Lead'
// on_sold: sold_event_name (no fallback - blank means skip)
// on_dq: dq_event_name (no fallback - blank means skip)
function getTriggerEventName(conn, trigger) {
  switch (trigger) {
    case 'on_received': return conn.received_event_name || conn.lead_event_name || 'Lead';
    case 'on_unsold': return conn.unsold_event_name || 'Lead';
    case 'on_queued': return conn.queued_event_name || 'Lead';
    case 'on_sold': return conn.sold_event_name || '';
    case 'on_dq': return conn.dq_event_name || '';
    case 'on_rejected': return conn.rejected_event_name || 'Lead';
    case 'on_duplicates': return conn.duplicates_event_name || 'Lead';
    default: return '';
  }
}

// Fire all matching connectors for a given trigger. Fire-and-forget: returns
// immediately, results handled in background.
function fireConnectors(db, connectors, trigger, leadData, leadId, supplierAttribution, supplierRecord) {
  for (const conn of connectors) {
    if (!conn.enabled) continue;
    const triggers = parseJsonArray(conn.triggers);
    // No triggers selected = fire on every lead (gated only by filters). Only fire once - at intake (on_received).
    if (triggers.length > 0 && !triggers.includes(trigger)) continue;
    if (triggers.length === 0 && trigger !== 'on_received') continue;
    if (!connectorMatchesFilters(conn, leadData, supplierAttribution, supplierRecord)) continue;
    if (!connectorMatchesConditions(conn, leadData)) continue;

    const eventName = getTriggerEventName(conn, trigger);
    // Sold and DQ have no fallback - skip if blank
    if (!eventName && (trigger === 'on_sold' || trigger === 'on_dq')) continue;

    if (conn.kind === 'facebook_capi') {
      sendCapiEvent(conn, leadData, leadId, eventName, trigger)
        .then(async (result) => {
          await appendCapiLog(db, leadId, result);
          if (!result.success) {
            await db.entities.ErrorLog.create({
              lead_id: leadId, stage: 'leadbyte', severity: 'warning',
              message: `CAPI failure: ${conn.name} (${eventName})`,
              detail: JSON.stringify(result), supplier_name: supplierAttribution,
            }).catch(() => {});
            await evaluateNotifications(db, ['capi_failure', 'api_error'], { id: leadId }, supplierAttribution,
              { message: `CAPI failure: ${conn.name} (${eventName}) - ${result.error || result.http_status}` }).catch(() => {});
          }
        })
        .catch(async (err) => {
          await appendCapiLog(db, leadId, { connector: conn.name, event_name: eventName, pixel: conn.fb_pixel_id, http_status: null, fbtrace_id: '', success: false, error: err.message });
          await db.entities.ErrorLog.create({
            lead_id: leadId, stage: 'leadbyte', severity: 'warning',
            message: `CAPI error: ${conn.name} (${eventName})`,
            detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution,
          }).catch(() => {});
        });
    } else {
      // webhook or generic_http
      sendHttpEvent(conn, leadData, leadId, eventName)
        .then(async (result) => {
          if (!result.success) {
            await db.entities.ErrorLog.create({
              lead_id: leadId, stage: 'leadbyte', severity: 'warning',
              message: `API error: ${conn.name}`,
              detail: JSON.stringify(result), supplier_name: supplierAttribution,
            }).catch(() => {});
            await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution,
              { message: `API error: ${conn.name} - ${result.error || result.http_status}` }).catch(() => {});
          }
        })
        .catch(async (err) => {
          await db.entities.ErrorLog.create({
            lead_id: leadId, stage: 'leadbyte', severity: 'warning',
            message: `API error: ${conn.name}`,
            detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution,
          }).catch(() => {});
        });
    }
  }
}

// Fire matching Deliveries destinations (non-default LeadByteConnector records).
// Same filter/condition/trigger logic as Conversion Events connectors.
function fireDeliveries(db, destinations, trigger, leadData, leadId, supplierAttribution, supplierRecord) {
  for (const dest of destinations) {
    if (!dest.enabled) continue;
    if (dest.is_default) continue;
    const triggers = parseJsonArray(dest.triggers);
    // No triggers selected = fire on every lead (gated only by filters). Only fire once - at intake (on_received).
    if (triggers.length > 0 && !triggers.includes(trigger)) continue;
    if (triggers.length === 0 && trigger !== 'on_received') continue;
    if (!connectorMatchesFilters(dest, leadData, supplierAttribution, supplierRecord)) continue;
    if (!connectorMatchesConditions(dest, leadData)) continue;

    const conn = { ...dest, name: dest.api_name };
    sendHttpEvent(conn, leadData, leadId, '')
      .then(async (result) => {
        await appendDeliveryLog(db, leadId, {
          connector: dest.api_name, trigger, http_status: result.http_status,
          success: !!result.success, error: result.error || '',
          timestamp: new Date().toISOString(),
        });
        if (!result.success) {
          await db.entities.ErrorLog.create({
            lead_id: leadId, stage: 'leadbyte', severity: 'warning',
            message: `Delivery failure: ${dest.api_name}`,
            detail: JSON.stringify(result), supplier_name: supplierAttribution,
          }).catch(() => {});
          await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution,
            { message: `Delivery failure: ${dest.api_name} - ${result.error || result.http_status}` }).catch(() => {});
        }
      })
      .catch(async (err) => {
        await appendDeliveryLog(db, leadId, {
          connector: dest.api_name, trigger, http_status: null,
          success: false, error: err.message || '',
          timestamp: new Date().toISOString(),
        });
        await db.entities.ErrorLog.create({
          lead_id: leadId, stage: 'leadbyte', severity: 'warning',
          message: `Delivery error: ${dest.api_name}`,
          detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution,
        }).catch(() => {});
      });
  }
}

// Append a CAPI result to the lead's capi_log field.
async function appendCapiLog(db, leadId, result) {
  try {
    const leads = await db.entities.Lead.filter({ id: leadId });
    const lead = leads[0];
    if (!lead) return;
    let log = [];
    try { log = JSON.parse(lead.capi_log || '[]'); } catch {}
    log.push({
      connector: result.connector, event_name: result.event_name, pixel: result.pixel,
      http_status: result.http_status, fbtrace_id: result.fbtrace_id,
      value: result.value ?? '', events_received: result.fb_response?.events_received,
      fb_response: result.fb_response, payload: result.payload || null,
      success: !!result.success, error: result.error || '', timestamp: new Date().toISOString(),
    });
    await db.entities.Lead.update(leadId, { capi_log: JSON.stringify(log) });
  } catch {}
}

// Append a Delivery result to the lead's delivery_log field.
async function appendDeliveryLog(db, leadId, entry) {
  try {
    const leads = await db.entities.Lead.filter({ id: leadId });
    const lead = leads[0];
    if (!lead) return;
    let log = [];
    try { log = JSON.parse(lead.delivery_log || '[]'); } catch {}
    log.push(entry);
    await db.entities.Lead.update(leadId, { delivery_log: JSON.stringify(log) });
  } catch {}
}

// Evaluate notification rules matching the given condition types.
async function evaluateNotifications(db, conditionTypes, lead, supplierAttribution, context = {}) {
  try {
    const rules = await db.entities.NotificationRule.filter({ enabled: true });
    for (const rule of rules) {
      if (!conditionTypes.includes(rule.condition_type)) continue;
      let summary = '';
      if (rule.condition_type === 'capi_failure' || rule.condition_type === 'api_error') {
        summary = `${rule.name}: ${context.message || 'API connector failure'}`;
      } else if (rule.condition_type === 'lead_queued') {
        summary = `${rule.name}: Lead queued - ${context.queue_reason || lead.queue_reason || 'unknown'}`;
      } else if (rule.condition_type === 'missing_fields') {
        summary = `${rule.name}: Missing required fields - ${context.queue_reason || ''}`;
      } else {
        continue;
      }
      const channels = parseJsonArray(rule.channels);
      const recipients = parseJsonArray(rule.recipients);
      await db.entities.NotificationEvent.create({
        rule_id: rule.id, triggered_at: new Date().toISOString(),
        summary, channel: channels.join(',') || 'email', delivered: false,
      }).catch(() => {});
      if (channels.includes('email') && recipients.length > 0) {
        try {
          await db.integrations.Core.SendEmail({
            to: recipients[0],
            subject: `Legenex Alert: ${rule.name}`,
            body: `${summary}\n\nLead ID: ${lead.id}\nSupplier: ${supplierAttribution}`,
          });
        } catch {}
      }
    }
  } catch {}
}

// ── Response Mapping ──────────────────────────────────────────────────────

function getPathValue(obj, path) {
  if (!path) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function applyOperator(actual, operator, expected) {
  let act = actual == null ? '' : actual;
  if (typeof act === 'object') act = JSON.stringify(act);
  else act = String(act);
  const exp = expected || '';
  switch (operator) {
    case 'equals': return act === exp;
    case 'not_equals': return act !== exp;
    case 'contains': return act.includes(exp);
    case 'not_contains': return !act.includes(exp);
    case 'starts_with': return act.startsWith(exp);
    case 'ends_with': return act.endsWith(exp);
    case 'is_empty': return act === '';
    case 'is_not_empty': return act !== '';
    case 'gt': return parseFloat(act) > parseFloat(exp);
    case 'lt': return parseFloat(act) < parseFloat(exp);
    default: return act.includes(exp);
  }
}

async function resolveResponseMapping(db, lbResult, fallbackResponse, fallbackStatus) {
  try {
    const mappings = await db.entities.ResponseMapping.list('sort_order', 50);
    const incomingReason = fallbackResponse?.reason || fallbackResponse?.message || '';
    if (mappings.length === 0) return { response: fallbackResponse, status: fallbackStatus };
    const sorted = mappings.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    for (const m of sorted) {
      if (m.is_fallback) continue;
      const actual = getPathValue(lbResult, m.field_path || 'records[0].status');
      if (applyOperator(actual, m.operator || 'contains', m.lb_status)) {
        const resp = { Response: m.response_label };
        if (incomingReason) resp.reason = incomingReason;
        return { response: resp, status: m.final_status };
      }
    }
    const fb = sorted.find(m => m.is_fallback);
    if (fb) {
      const resp = { Response: fb.response_label };
      if (incomingReason) resp.reason = incomingReason;
      return { response: resp, status: fb.final_status };
    }
    return { response: fallbackResponse, status: fallbackStatus };
  } catch {
    return { response: fallbackResponse, status: fallbackStatus };
  }
}

// ── TrustedForm validation ────────────────────────────────────────────────

const TRUSTEDFORM_RE = /^https?:\/\/cert\.trustedform\.com\/[0-9a-fA-F]{40}(\?.*)?$/;

function isValidTrustedForm(url) {
  if (!url || typeof url !== 'string') return false;
  return TRUSTEDFORM_RE.test(url.trim());
}

// Check required custom fields against the lead payload.
function checkRequiredFields(customFields, leadData) {
  const missing = [];
  for (const f of customFields) {
    if (!f.required) continue;
    if (f.field_type === 'system') continue; // system fields are system-populated, not gated
    if (f.system_role) continue; // HLR/email-derived fields (phone_verified, email_valid) are enriched, not inbound-gated
    const val = leadData[f.field_name];
    if (val === undefined || val === null || String(val).trim() === '') {
      missing.push(f.field_name);
    }
  }
  return missing;
}

// Patterns that indicate a LeadByte rejection is due to missing/invalid fields
const QUEUE_REJECTION_PATTERNS = ['missing', 'required', 'invalid', 'not provided'];

function isQueueableRejection(reasonText) {
  const lower = String(reasonText || '').toLowerCase();
  return QUEUE_REJECTION_PATTERNS.some(p => lower.includes(p));
}

// ── Response envelope ──────────────────────────────────────────────────────
// Builds the layered response returned to suppliers. Keeps the legacy `Response`
// field as a mirror so existing suppliers keep working. The `Response` value is
// whatever the legacy flow returns today (Sold/Unsold/Queued/Duplicate/Error).
function buildEnvelope(traceId, {
  ok, acceptance, lead_id = null, lead_status, sold = false,
  revenue = null, code, reason = null, message, Response,
}) {
  return {
    ok,
    trace_id: traceId,
    received_at: new Date().toISOString(),
    acceptance,
    lead_id: lead_id != null ? String(lead_id) : null,
    lead_status,
    sold,
    revenue: revenue != null && !isNaN(revenue) ? Number(revenue) : null,
    currency: 'USD',
    code,
    reason: reason || null,
    message,
    Response,
  };
}

// Map an inbound-status-bypass final_status to the envelope lead_status.
function bypassLeadStatus(finalForBypass) {
  const map = { Disqualified: 'disqualified', Returned: 'returned', Sold: 'sold' };
  return map[finalForBypass] || 'sold';
}

// ── Main handler ──────────────────────────────────────────────────────────

export default async function processLead(ctx) {
  const db = ctx.db;
  const method = ctx.req?.method || 'POST';

  // Case-insensitive header lookup (Express lowercases header keys).
  const getHeader = (name) => {
    const h = ctx.req?.headers || {};
    const v = h[name.toLowerCase()];
    return v == null ? '' : String(v);
  };

  if (method === 'GET') return ctx.json({ status: 'ok' }, 200);

  const traceId = (globalThis.crypto?.randomUUID?.() || `t_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  if (method !== 'POST') {
    return ctx.json(buildEnvelope(traceId, {
      ok: false, acceptance: 'rejected', lead_status: 'rejected',
      code: 'METHOD_NOT_ALLOWED', reason: 'Method not allowed',
      message: 'Method not allowed', Response: 'Error',
    }), 405);
  }

  const startTime = Date.now();
  let leadId = null;
  let capturedRevenue = null;

  try {
    const body = ctx.body || {};
    const payload = body.payload || body;

    let supplierKeyRaw =
      getHeader('X-API-KEY') ||
      getHeader('X_KEY') ||
      getHeader('x-api-key') ||
      getHeader('x_key') ||
      payload['X-API-KEY'] ||
      payload['X_KEY'] ||
      payload._supplier_key ||
      null;
    if (!supplierKeyRaw) {
      const authHeader = getHeader('Authorization') || '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        supplierKeyRaw = decoded.split(':')[0] || null;
      }
    }

    const leadPayload = { ...payload };
    const inboundPhoneVerified = String(payload.phone_verified || '').trim();
    delete leadPayload['X-API-KEY'];
    delete leadPayload._supplier_key;
    delete leadPayload.phone_verified;

    // ── a. AUTH ──────────────────────────────────────────────────────────
    let apiKeyRecord = null;
    if (supplierKeyRaw) {
      const keys = await db.entities.ApiKey.filter({ key: supplierKeyRaw });
      if (keys.length > 0 && keys[0].active) apiKeyRecord = keys[0];
    }
    if (!apiKeyRecord) {
      await db.entities.ErrorLog.create({
        stage: 'auth', severity: 'error',
        message: 'Invalid or missing API key',
        detail: JSON.stringify({ key_provided: supplierKeyRaw ? 'yes' : 'no' }),
        supplier_name: 'Unknown',
      });
      return ctx.json(buildEnvelope(traceId, {
        ok: false, acceptance: 'unauthorized', lead_status: 'rejected',
        code: 'BAD_KEY', reason: 'Invalid or missing API key',
        message: 'Invalid or missing API key', Response: 'Error',
      }), 401);
    }

    const supplierAttribution = apiKeyRecord.type === 'master'
      ? 'Master' : (apiKeyRecord.supplier_name || 'Unknown');

    await db.entities.ApiKey.update(apiKeyRecord.id, {
      last_used_at: new Date().toISOString(),
      request_count: (apiKeyRecord.request_count || 0) + 1,
    });

    // ── a. CREATE LEAD ────────────────────────────────────────────────────
    const now = new Date();
    const appSettingsArr = await db.entities.AppSettings.list();
    const appSettings = appSettingsArr[0] || {};
    const tsFmt = appSettings.timestamp_format || 'MM/DD/YYYY HH:MM:SS';
    leadPayload.timestamp = formatTimestamp(now, tsFmt);

    const lead = await db.entities.Lead.create({
      supplier_name: supplierAttribution,
      supplier_key_id: apiKeyRecord.id,
      raw_payload: JSON.stringify(leadPayload),
      final_status: 'Processing',
    });
    leadId = lead.id;

    // Assign unique numeric lead_id before any CAPI event or response
    const systemLeadId = await nextLeadId(db);
    leadPayload.lead_id = systemLeadId;
    await db.entities.Lead.update(leadId, { lead_id: systemLeadId });

    // Load all config in parallel
    const [hlrSettingsArr, emailSettingsArr, allDestinations, calcs, customFields, apiConnectors, responseMappings] = await Promise.all([
      db.entities.HlrSettings.list(),
      db.entities.EmailValidationSettings.list(),
      db.entities.LeadByteConnector.filter({ enabled: true }),
      db.entities.CustomCalculation.list(),
      db.entities.CustomField.list(),
      db.entities.ApiConnector.filter({ enabled: true }),
      db.entities.ResponseMapping.list('sort_order', 50),
    ]);
    const hlrSettings = hlrSettingsArr[0] || null;
    const emailSettings = emailSettingsArr[0] || null;
    const emailValidField = customFields.find(f => f.system_role === 'email_valid');
    const phoneVerifiedField = customFields.find(f => f.system_role === 'phone_verified');
    const emailValidFieldName = emailValidField?.field_name || 'email_valid';
    const phoneVerifiedFieldName = phoneVerifiedField?.field_name || 'phone_verified';
    const leadByteConnector = allDestinations.find(d => d.is_default) || null;

    // Look up supplier record for type-based filtering
    let supplierRecord = null;
    if (apiKeyRecord.supplier_id) {
      const ss = await db.entities.Supplier.filter({ id: apiKeyRecord.supplier_id });
      if (ss.length > 0) supplierRecord = ss[0];
    } else if (supplierAttribution !== 'Master') {
      const ss = await db.entities.Supplier.filter({ name: supplierAttribution });
      if (ss.length > 0) supplierRecord = ss[0];
    }

    // ── Normalize field aliases ──────────────────────────────────────────
    const mobile = leadPayload.mobile || leadPayload.phone1 || leadPayload.phone || leadPayload.phone_number || '';
    const firstName = leadPayload.first_name || leadPayload.firstname || '';
    const lastName = leadPayload.last_name || leadPayload.lastname || '';
    const email = leadPayload.email || '';

    if (!leadPayload.first_name && firstName) leadPayload.first_name = firstName;
    if (!leadPayload.last_name && lastName) leadPayload.last_name = lastName;
    if (!leadPayload.mobile && mobile) leadPayload.mobile = mobile;
    if (!leadPayload.ip_address && leadPayload.ipaddress) leadPayload.ip_address = leadPayload.ipaddress;
    if (!leadPayload.optin_url && leadPayload.optinurl) leadPayload.optin_url = leadPayload.optinurl;
    if (!leadPayload.trustedform_url && leadPayload.trustedform_cert) leadPayload.trustedform_url = leadPayload.trustedform_cert;
    if (!leadPayload.jornaya_token && leadPayload.jornaya_leadid) leadPayload.jornaya_token = leadPayload.jornaya_leadid;
    if (!leadPayload.supplier_brand && leadPayload.brand) leadPayload.supplier_brand = leadPayload.brand;
    if (!leadPayload.ad_label && leadPayload.utm_ad_label) leadPayload.ad_label = leadPayload.utm_ad_label;

    await db.entities.Lead.update(leadId, {
      mapped_fields: JSON.stringify(leadPayload),
      first_name: firstName, last_name: lastName, mobile: mobile, email: email,
    });

    // ── UNKNOWN INBOUND FIELDS ─────────────────────────────────────────
    // Fields not defined as CustomFields are NOT auto-created. The lead still
    // processes normally: every inbound key is preserved in raw_payload and
    // mapped_fields, and forwarding pulls from those. Unknown fields simply
    // aren't persisted as CustomField records (no auto-detection).

    // ── ROUTE: lead_route (case-insensitive contains) ────────────────────
    const leadRouteRaw = String(leadPayload.lead_route || 'standard').trim().toLowerCase();
    const routeIs = {
      direct: leadRouteRaw.includes('direct'),
      data: leadRouteRaw.includes('data'),
      event: leadRouteRaw.includes('event'),
      queue: leadRouteRaw.includes('queue'),
      test: leadRouteRaw.includes('test'),
    };
    routeIs.standard = !routeIs.direct && !routeIs.data && !routeIs.event && !routeIs.queue && !routeIs.test;

    // TEST route: save only - no processing, no triggers
    if (routeIs.test) {
      const testResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'accepted', lead_id: systemLeadId, lead_status: 'queued',
        code: 'TEST_ROUTE', reason: 'Test route - lead saved for testing only',
        message: 'Test route - lead saved for testing only', Response: 'Queued',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Queued',
        queue_reason: 'Test route - no downstream processing',
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(testResponse),
      });
      return ctx.json(testResponse, 200);
    }

    // QUEUE route: hold for manual processing - fire on_queued, skip LeadByte
    if (routeIs.queue) {
      fireConnectors(db, apiConnectors, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      if (!routeIs.event) fireDeliveries(db, allDestinations, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      await evaluateNotifications(db, ['lead_queued'], { id: leadId, queue_reason: 'Queue route - held for manual processing' }, supplierAttribution, { queue_reason: 'Queue route' });
      const queueResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'queued', lead_id: systemLeadId, lead_status: 'queued',
        code: 'QUEUE_ROUTE', reason: 'Queue route - held for manual processing',
        message: 'Queue route - held for manual processing', Response: 'Queued',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Queued',
        queue_reason: 'Queue route - held for manual processing',
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(queueResponse),
      });
      return ctx.json(queueResponse, 200);
    }

    // ── PRE-CLASSIFIED LEADS: bypass the entire LeadByte system ────────
    // A Disqualified lead is NOT an Unsold lead (Unsold = a Qualified lead
    // that didn't sell). Disqualified leads and custom (non-builtin) lead
    // statuses (e.g. "24m Lead") are pre-classified - they skip HLR/phone
    // verification, email validation, TrustedForm, the payload delay, and
    // LeadByte. They fire their matching trigger (on_dq / on_<custom>),
    // AWAIT every send so CAPI + delivery logs populate, and return the
    // actual response from the destination endpoint. The inbound
    // lead_status is preserved as-is.
    const inboundLeadStatus = String(leadPayload.lead_status || '').trim();
    const isBuiltinStatus = BUILTIN_LEAD_STATUSES.includes(inboundLeadStatus);
    if (inboundLeadStatus && inboundLeadStatus !== 'Qualified' && (inboundLeadStatus === 'Disqualified' || !isBuiltinStatus)) {
      const bypassTrigger = triggerKeyForStatus(inboundLeadStatus);

      // CAPI / webhook connectors - awaited so logs populate before return.
      for (const conn of apiConnectors) {
        if (!conn.enabled) continue;
        const trig = parseJsonArray(conn.triggers);
        if (trig.length > 0 && !trig.includes(bypassTrigger)) continue;
        if (trig.length === 0 && bypassTrigger !== 'on_received') continue;
        if (!connectorMatchesFilters(conn, leadPayload, supplierAttribution, supplierRecord)) continue;
        if (!connectorMatchesConditions(conn, leadPayload)) continue;
        const eventName = getTriggerEventName(conn, bypassTrigger);
        if (!eventName && (bypassTrigger === 'on_sold' || bypassTrigger === 'on_dq')) continue;
        if (conn.kind === 'facebook_capi') {
          try {
            const result = await sendCapiEvent(conn, leadPayload, leadId, eventName, bypassTrigger);
            await appendCapiLog(db, leadId, result);
            if (!result.success) {
              await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `CAPI failure: ${conn.name} (${eventName})`, detail: JSON.stringify(result), supplier_name: supplierAttribution }).catch(() => {});
              await evaluateNotifications(db, ['capi_failure', 'api_error'], { id: leadId }, supplierAttribution, { message: `CAPI failure: ${conn.name} (${eventName}) - ${result.error || result.http_status}` }).catch(() => {});
            }
          } catch (err) {
            await appendCapiLog(db, leadId, { connector: conn.name, event_name: eventName, pixel: conn.fb_pixel_id, http_status: null, fbtrace_id: '', success: false, error: err.message, value: '', payload: null });
            await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `CAPI error: ${conn.name} (${eventName})`, detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution }).catch(() => {});
          }
        } else {
          try {
            const result = await sendHttpEvent(conn, leadPayload, leadId, eventName);
            if (!result.success) {
              await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `API error: ${conn.name}`, detail: JSON.stringify(result), supplier_name: supplierAttribution }).catch(() => {});
              await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution, { message: `API error: ${conn.name} - ${result.error || result.http_status}` }).catch(() => {});
            }
          } catch (err) {
            await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `API error: ${conn.name}`, detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution }).catch(() => {});
          }
        }
      }

      // Delivery destinations - awaited, capture payload + response body.
      const deliveryResults = [];
      if (!routeIs.event) {
        for (const dest of allDestinations) {
          if (!dest.enabled) continue;
          if (dest.is_default) continue;
          const trig = parseJsonArray(dest.triggers);
          if (trig.length > 0 && !trig.includes(bypassTrigger)) continue;
          if (trig.length === 0 && bypassTrigger !== 'on_received') continue;
          if (!connectorMatchesFilters(dest, leadPayload, supplierAttribution, supplierRecord)) continue;
          if (!connectorMatchesConditions(dest, leadPayload)) continue;
          try {
            const result = await sendDestinationAwait(dest, leadPayload, leadId, bypassTrigger);
            await appendDeliveryLog(db, leadId, {
              connector: dest.api_name, trigger: bypassTrigger,
              http_status: result.http_status, success: !!result.success,
              error: result.error || '', payload: result.payload, response: result.response,
              timestamp: new Date().toISOString(),
            });
            deliveryResults.push(result);
            if (!result.success) {
              await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `Delivery failure: ${dest.api_name}`, detail: JSON.stringify(result), supplier_name: supplierAttribution }).catch(() => {});
              await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution, { message: `Delivery failure: ${dest.api_name} - ${result.error || result.http_status}` }).catch(() => {});
            }
          } catch (err) {
            await appendDeliveryLog(db, leadId, { connector: dest.api_name, trigger: bypassTrigger, http_status: null, success: false, error: err.message, payload: '', response: '', timestamp: new Date().toISOString() });
            await db.entities.ErrorLog.create({ lead_id: leadId, stage: 'leadbyte', severity: 'warning', message: `Delivery error: ${dest.api_name}`, detail: JSON.stringify({ error: err.message }), supplier_name: supplierAttribution }).catch(() => {});
          }
        }
      }

      // Build the supplier response from the actual destination response.
      let responseLabel;
      let bypassReason;
      if (deliveryResults.length > 0) {
        const primary = deliveryResults[0];
        const respBody = (primary.response || '').trim();
        responseLabel = primary.success ? 'Sent' : 'Error';
        if (respBody) {
          try { const j = JSON.parse(respBody); responseLabel = j.Response || j.response || j.status || j.message || respBody; }
          catch { responseLabel = respBody; }
        }
        bypassReason = `${inboundLeadStatus} lead - delivered to ${primary.connector} (HTTP ${primary.http_status || 'n/a'})`;
      } else {
        responseLabel = 'Sent';
        bypassReason = `${inboundLeadStatus} lead - no matching delivery destination`;
      }
      const finalForBypass = inboundLeadStatus === 'Disqualified' ? 'Disqualified' : (inboundLeadStatus === 'Returned' ? 'Returned' : 'Sold');
      const bypassResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'accepted', lead_id: systemLeadId,
        lead_status: bypassLeadStatus(finalForBypass), code: 'INBOUND_STATUS_BYPASS',
        reason: bypassReason, message: bypassReason, Response: responseLabel,
      });
      await db.entities.Lead.update(leadId, {
        final_status: finalForBypass,
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(bypassResponse),
      });
      return ctx.json(bypassResponse, 200);
    }

    // ── b. FIRE ON RECEIVED (route-aware, fire-and-forget) ─────────────
    fireConnectors(db, apiConnectors, 'on_received', leadPayload, leadId, supplierAttribution, supplierRecord);
    // Event route: conversion events only - skip deliveries
    if (!routeIs.event) {
      fireDeliveries(db, allDestinations, 'on_received', leadPayload, leadId, supplierAttribution, supplierRecord);
    }

    // ── c. HLR LOOKUP ────────────────────────────────────────────────────
    let hlrResult = null;
    let hlrRequestBody = {};

    const hlrRouteAllowed = routeMatchesFilter(hlrSettings, routeIs);
    const hlrSupplierAllowed = supplierMatchesFilter(hlrSettings, supplierAttribution, supplierRecord);
    if (hlrSettings && hlrSettings.enabled && hlrRouteAllowed && hlrSupplierAllowed && !inboundPhoneVerified) {
      const reqFieldMap = typeof hlrSettings.request_field_map === 'string'
        ? JSON.parse(hlrSettings.request_field_map || '{}')
        : (hlrSettings.request_field_map || {});
      const mobileField = reqFieldMap.mobile || 'phone';
      const firstField = reqFieldMap.first_name || 'firstname';
      const lastField = reqFieldMap.last_name || 'lastname';

      hlrRequestBody = {
        mobile: leadPayload[mobileField] || mobile,
        first_name: leadPayload[firstField] || firstName,
        last_name: leadPayload[lastField] || lastName,
      };
      const failMode = hlrSettings.fail_mode || 'fail_open';
      const timeoutMs = hlrSettings.timeout_ms || 8000;

      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs);
        const hlrResp = await fetch(hlrSettings.endpoint_url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hlrRequestBody), signal: controller.signal,
        });
        clearTimeout(tid);
        if (!hlrResp.ok) throw new Error(`HLR returned HTTP ${hlrResp.status}`);
        hlrResult = await hlrResp.json();
        await db.entities.Lead.update(leadId, {
          hlr_request: JSON.stringify(hlrRequestBody),
          hlr_response: JSON.stringify(hlrResult),
          hlr_status: hlrResult.lh_hlr_response || '',
          hlr_summary_score: hlrResult.summary_score ?? null,
        });
      } catch (err) {
        const hlrError = err.message || 'HLR lookup failed';
        await db.entities.Lead.update(leadId, {
          hlr_error: hlrError, hlr_request: JSON.stringify(hlrRequestBody),
        });
        await db.entities.ErrorLog.create({
          lead_id: leadId, stage: 'hlr', severity: 'error',
          message: hlrError, detail: JSON.stringify({ fail_mode: failMode }),
          supplier_name: supplierAttribution,
        });
        if (failMode === 'fail_closed') {
          const hlrFailResponse = buildEnvelope(traceId, {
            ok: false, acceptance: 'error', lead_id: systemLeadId, lead_status: 'error',
            code: 'HLR_FAILED', reason: 'HLR lookup failed',
            message: 'HLR lookup failed', Response: 'Error',
          });
          await db.entities.Lead.update(leadId, {
            final_status: 'Error', error_stage: 'hlr',
            processed_at: new Date().toISOString(),
            process_time_ms: Date.now() - startTime,
            response_returned: JSON.stringify(hlrFailResponse),
          });
          return ctx.json(hlrFailResponse, 200);
        }
      }
    }

    // ── c2. EMAIL VALIDATION (configurable routes/suppliers) ─────────────
    const emailEnabled = emailSettings ? emailSettings.enabled !== false : true;
    const emailRouteAllowed = routeMatchesFilter(emailSettings, routeIs);
    const emailSupplierAllowed = supplierMatchesFilter(emailSettings, supplierAttribution, supplierRecord);
    let emailValidResult = null;
    if (emailEnabled && emailRouteAllowed && emailSupplierAllowed && email) {
      try {
        const ev = String(email).trim().toLowerCase();
        const formatOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ev);
        let mxOk = false;
        if (formatOk) {
          const domain = ev.split('@')[1];
          try {
            const dns = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`);
            const ddata = await dns.json();
            mxOk = Array.isArray(ddata.Answer) && ddata.Answer.some(a => a.type === 15);
          } catch {}
        }
        emailValidResult = (formatOk && mxOk) ? 'Yes' : 'No';
        await db.entities.Lead.update(leadId, { email_valid: emailValidResult });
      } catch {
        emailValidResult = 'No';
        await db.entities.Lead.update(leadId, { email_valid: 'No' });
      }
    }

    // ── Run custom calculations ──────────────────────────────────────────
    const phoneVerifiedSource = hlrSettings?.phone_verified_source || 'lh_hlr_response';
    const enrichedData = runCalculations(calcs, leadPayload, hlrResult, phoneVerifiedSource, phoneVerifiedFieldName, supplierRecord?.supplier_type);
    if (hlrResult) {
      enrichedData.hlr_status = hlrResult.lh_hlr_response || '';
      enrichedData.hlr_score = hlrResult.summary_score != null ? String(hlrResult.summary_score) : '';
      enrichedData.country_code = hlrResult.country_code || '';
    }
    // Precedence: HLR result (already set by runCalculations) > inbound phone_verified > configured static fallback.
    if (!hlrResult) {
      if (inboundPhoneVerified) {
        enrichedData[phoneVerifiedFieldName] = inboundPhoneVerified;
      } else if (String(enrichedData[phoneVerifiedFieldName] ?? '').trim() === '') {
        enrichedData[phoneVerifiedFieldName] = hlrSettings?.phone_verified_fallback ?? 'Not Verified';
      }
    }
    if (emailValidResult !== null) {
      enrichedData[emailValidFieldName] = emailValidResult;
    }

    // ── d. GATE: TrustedForm cert (hard enforce) ─────────────────────────
    const requireCert = appSettings.require_trustedform_cert !== false;
    const trustedformUrl = leadPayload.trustedform_url || leadPayload.trustedform_cert || '';
    const tfValid = isValidTrustedForm(trustedformUrl);
    const missingFields = checkRequiredFields(customFields, leadPayload);

    // When require_trustedform_cert is true, no lead reaches LeadByte without a valid cert.
    if (requireCert && !tfValid) {
      const queueReason = 'Missing or invalid TrustedForm cert';

      fireConnectors(db, apiConnectors, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      fireDeliveries(db, allDestinations, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      await evaluateNotifications(db, ['lead_queued'], { id: leadId, queue_reason: queueReason }, supplierAttribution, { queue_reason: queueReason });

      const mapped = await resolveResponseMapping(db, {}, { Response: 'Queued', reason: queueReason }, 'Queued');
      const queueResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'queued', lead_id: systemLeadId, lead_status: 'queued',
        code: 'MISSING_CERT', reason: mapped.response?.reason || queueReason,
        message: queueReason, Response: mapped.response?.Response || 'Queued',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Queued',
        queue_reason: queueReason,
        trustedform_valid: false,
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(queueResponse),
      });
      return ctx.json(queueResponse, 200);
    }

    // ── d2. GATE: Required custom fields ─────────────────────────────────
    if (missingFields.length > 0) {
      const queueReason = `Missing required fields: ${missingFields.join(', ')}`;
      fireConnectors(db, apiConnectors, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      fireDeliveries(db, allDestinations, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
      await evaluateNotifications(db, ['lead_queued', 'missing_fields'], { id: leadId, queue_reason: queueReason }, supplierAttribution, { queue_reason: queueReason });

      const mapped = await resolveResponseMapping(db, {}, { Response: 'Queued', reason: queueReason }, 'Queued');
      const queueResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'queued', lead_id: systemLeadId, lead_status: 'queued',
        code: 'MISSING_FIELDS', reason: mapped.response?.reason || queueReason,
        message: queueReason, Response: mapped.response?.Response || 'Queued',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Queued',
        queue_reason: queueReason,
        trustedform_valid: tfValid,
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(queueResponse),
      });
      return ctx.json(queueResponse, 200);
    }

    await db.entities.Lead.update(leadId, { trustedform_valid: tfValid });

    // ── Fire custom lead_status triggers (e.g. "24m Lead") ─────────────
    // Any lead_status value that isn't a built-in lifecycle status fires its own
    // trigger here (after enrichment + gates), so destinations keyed to that status
    // receive the lead. Empty-trigger destinations skip this (they fire at intake).
    const leadStatusVal = enrichedData.lead_status || '';
    if (leadStatusVal && !BUILTIN_LEAD_STATUSES.includes(leadStatusVal)) {
      const customTrigger = triggerKeyForStatus(leadStatusVal);
      fireConnectors(db, apiConnectors, customTrigger, enrichedData, leadId, supplierAttribution, supplierRecord);
      if (!routeIs.event) fireDeliveries(db, allDestinations, customTrigger, enrichedData, leadId, supplierAttribution, supplierRecord);
    }

    // ── e. ROUTE: direct / event bypass LeadByte ────────────────────────
    if (!routeIs.standard) {
      // Inject revenue (0 for direct/event routes) so {{revenue}} resolves in CAPI custom_data.
      const soldData = { ...leadPayload, revenue: 0 };
      fireConnectors(db, apiConnectors, 'on_sold', soldData, leadId, supplierAttribution, supplierRecord);
      if (!routeIs.event) {
        fireDeliveries(db, allDestinations, 'on_sold', soldData, leadId, supplierAttribution, supplierRecord);
      }
      const soldResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'accepted', lead_id: systemLeadId, lead_status: 'sold',
        sold: true, revenue: 0, code: 'SOLD', reason: null,
        message: 'Lead sold', Response: 'Sold',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Sold',
        revenue: 0,
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(soldResponse),
      });
      return ctx.json(soldResponse, 200);
    }

    // ── e. FORWARD TO LEADBYTE (standard route) ────────────────────────
    if (!leadByteConnector) {
      const noConnResponse = buildEnvelope(traceId, {
        ok: false, acceptance: 'error', lead_id: systemLeadId, lead_status: 'error',
        code: 'LB_ERROR', reason: 'No active LeadByte connector configured',
        message: 'No active LeadByte connector configured', Response: 'Error',
      });
      await db.entities.Lead.update(leadId, {
        final_status: 'Error', error_stage: 'leadbyte',
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(noConnResponse),
      });
      await db.entities.ErrorLog.create({
        lead_id: leadId, stage: 'leadbyte', severity: 'critical',
        message: 'No active LeadByte connector configured',
        supplier_name: supplierAttribution,
      });
      return ctx.json(noConnResponse, 200);
    }

    // ── GATE: LeadByte connector triggers ─────────────────────────────
    // Only forward to LeadByte if the lead's effective trigger (derived from
    // lead_status) matches the default connector's triggers. Empty triggers =
    // fire on every lead. A pre-classified non-Qualified lead (e.g. Disqualified)
    // is never sent to LeadByte - it fires the matching trigger instead.
    {
      const lbTriggers = parseJsonArray(leadByteConnector.triggers);
      const effStatus = String(enrichedData.lead_status || leadPayload.lead_status || '').trim();
      const effTrigger = effStatus ? triggerKeyForStatus(effStatus) : 'on_received';
      const allowLeadByte = lbTriggers.length === 0 || lbTriggers.includes(effTrigger);
      if (!allowLeadByte) {
        const notEligibleReason = `Lead status "${effStatus}" not eligible for LeadByte`;
        const skipResponse = buildEnvelope(traceId, {
          ok: true, acceptance: 'accepted', lead_id: systemLeadId, lead_status: 'unsold',
          code: 'NOT_ELIGIBLE', reason: notEligibleReason,
          message: notEligibleReason, Response: 'Unsold',
        });
        if (effTrigger !== 'on_received') {
          fireConnectors(db, apiConnectors, effTrigger, enrichedData, leadId, supplierAttribution, supplierRecord);
          if (!routeIs.event) fireDeliveries(db, allDestinations, effTrigger, enrichedData, leadId, supplierAttribution, supplierRecord);
        }
        const finalForStatus = {
          Disqualified: 'Disqualified', Sold: 'Sold', Unsold: 'Unsold',
          Rejected: 'Unsold', Duplicates: 'Duplicate', Queued: 'Queued',
        }[effStatus] || 'Unsold';
        await db.entities.Lead.update(leadId, {
          final_status: finalForStatus,
          queue_reason: finalForStatus === 'Queued' ? notEligibleReason : '',
          processed_at: new Date().toISOString(),
          process_time_ms: Date.now() - startTime,
          response_returned: JSON.stringify(skipResponse),
        });
        return ctx.json(skipResponse, 200);
      }
    }

    // Check LeadByte connector filters - route to DQ destinations instead of dropping
    if (!connectorMatchesFilters(leadByteConnector, enrichedData, supplierAttribution, supplierRecord) ||
        !connectorMatchesConditions(leadByteConnector, enrichedData)) {
      const filterDqReason = 'Did not match LeadByte filters - routed to DQ destinations';
      const skipResponse = buildEnvelope(traceId, {
        ok: true, acceptance: 'accepted', lead_id: systemLeadId, lead_status: 'disqualified',
        code: 'FILTER_DQ', reason: filterDqReason,
        message: filterDqReason, Response: 'Unsold',
      });
      // Fire Disqualified then Unsold triggers so these leads still reach their destinations
      fireConnectors(db, apiConnectors, 'on_dq', enrichedData, leadId, supplierAttribution, supplierRecord);
      fireDeliveries(db, allDestinations, 'on_dq', enrichedData, leadId, supplierAttribution, supplierRecord);
      fireConnectors(db, apiConnectors, 'on_unsold', enrichedData, leadId, supplierAttribution, supplierRecord);
      fireDeliveries(db, allDestinations, 'on_unsold', enrichedData, leadId, supplierAttribution, supplierRecord);
      await db.entities.Lead.update(leadId, {
        final_status: 'Disqualified',
        queue_reason: 'Did not match LeadByte filters - routed to DQ destinations',
        processed_at: new Date().toISOString(),
        process_time_ms: Date.now() - startTime,
        response_returned: JSON.stringify(skipResponse),
      });
      return ctx.json(skipResponse, 200);
    }

    const leadBytePayload = await buildPayloadFromTemplate(leadByteConnector.payload_template, enrichedData);
    await db.entities.Lead.update(leadId, { leadbyte_request: JSON.stringify(leadBytePayload) });

    const headerRowsParsed = parseJsonArray(leadByteConnector.headers);
    const lbHeaders = {};
    if (Array.isArray(headerRowsParsed)) {
      headerRowsParsed.forEach(row => { if (row.key) lbHeaders[row.key] = row.value; });
    } else {
      Object.assign(lbHeaders, headerRowsParsed);
    }
    const contentType = leadByteConnector.content_type || 'application/json';
    lbHeaders['Content-Type'] = contentType;

    let lbBodyStr;
    if (contentType === 'application/x-www-form-urlencoded') {
      lbBodyStr = new URLSearchParams(typeof leadBytePayload === 'object' ? leadBytePayload : {}).toString();
    } else {
      lbBodyStr = typeof leadBytePayload === 'string' ? leadBytePayload : JSON.stringify(leadBytePayload);
    }

    const lbResp = await fetch(leadByteConnector.target_url, {
      method: leadByteConnector.http_method || 'POST',
      headers: lbHeaders, body: lbBodyStr,
    });
    const lbText = await lbResp.text();
    let lbResult;
    try { lbResult = JSON.parse(lbText); } catch { lbResult = { raw: lbText }; }
    await db.entities.Lead.update(leadId, { leadbyte_response: JSON.stringify(lbResult) });

    // ── f. PARSE LEADBYTE RESPONSE ──────────────────────────────────────
    let finalStatus = 'Error';
    let supplierResponse = { Response: 'Error', reason: 'Unexpected LeadByte response' };
    // Envelope metadata tracked alongside the legacy supplierResponse.
    let envAcceptance = 'error';
    let envLeadStatus = 'error';
    let envCode = 'LB_ERROR';
    let envSold = false;

    if (lbResult.status === 'Success' && lbResult.records && lbResult.records.length > 0) {
      const record = lbResult.records[0];
      const recordStatus = record.status;
      const recordResponse = record.response || {};
      await db.entities.Lead.update(leadId, {
        leadbyte_queue_id: record.queueId || '',
        leadbyte_record_status: recordStatus || '',
        leadbyte_lead_id: recordResponse.leadId || null,
        leadbyte_rejection_id: recordResponse.rejectionId ? String(recordResponse.rejectionId) : '',
        leadbyte_process_time: recordResponse.processTime || null,
      });

      if (recordStatus === 'Approved') {
        // ── f. Approved => Sold + FIRE ON SOLD ──────────────────────────
        finalStatus = 'Sold';
        supplierResponse = { Response: 'Sold' };
        envAcceptance = 'accepted'; envLeadStatus = 'sold'; envCode = 'SOLD'; envSold = true;

        // Capture revenue from LeadByte response: sum across ALL buyers with status "Sold"
        const buyers = recordResponse.buyers || record.buyers || lbResult.buyers || [];
        let revenueSum = 0;
        let foundSoldBuyer = false;
        for (const b of buyers) {
          if (b && typeof b.status === 'string' && b.status.toLowerCase() === 'sold') {
            foundSoldBuyer = true;
            revenueSum += Number(b.revenue) || 0;
          }
        }
        if (foundSoldBuyer) {
          capturedRevenue = revenueSum;
        } else if (lbResult.revenue != null) {
          capturedRevenue = Number(lbResult.revenue);
        } else {
          capturedRevenue = 0;
        }
        if (capturedRevenue != null && !isNaN(capturedRevenue)) {
          await db.entities.Lead.update(leadId, { revenue: capturedRevenue });
        }

        // Fire on_sold connectors (fire-and-forget). Inject captured revenue so
        // {{revenue}} resolves in CAPI custom_data for the Sold event.
        const soldData = { ...leadPayload, revenue: capturedRevenue != null ? capturedRevenue : 0 };
        fireConnectors(db, apiConnectors, 'on_sold', soldData, leadId, supplierAttribution, supplierRecord);
        fireDeliveries(db, allDestinations, 'on_sold', soldData, leadId, supplierAttribution, supplierRecord);
      } else if (recordStatus === 'Rejected') {
        // ── f. Rejected => check for queueable patterns ─────────────────
        const rejectionReason = recordResponse.message || recordResponse.reason || recordResponse.error || record.error || record.response_message || '';
        if (isQueueableRejection(rejectionReason)) {
          finalStatus = 'Queued';
          const queueReason = `LeadByte rejection (possible missing/invalid field): ${rejectionReason}`;
          await db.entities.Lead.update(leadId, { queue_reason: queueReason });
          supplierResponse = { Response: 'Unsold', reason: rejectionReason };
          envAcceptance = 'queued'; envLeadStatus = 'queued'; envCode = 'MISSING_FIELDS';
          // Fire on_queued connectors + evaluate rules
          fireConnectors(db, apiConnectors, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
          fireDeliveries(db, allDestinations, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
          await evaluateNotifications(db, ['lead_queued', 'missing_fields'], { id: leadId, queue_reason: queueReason }, supplierAttribution, { queue_reason: queueReason });
        } else {
          finalStatus = 'Unsold';
          supplierResponse = { Response: 'Unsold', reason: rejectionReason };
          envAcceptance = 'accepted'; envLeadStatus = 'unsold'; envCode = 'UNSOLD';
          // Fire on_unsold + on_dq connectors
          fireConnectors(db, apiConnectors, 'on_unsold', leadPayload, leadId, supplierAttribution, supplierRecord);
          fireDeliveries(db, allDestinations, 'on_unsold', leadPayload, leadId, supplierAttribution, supplierRecord);
          fireConnectors(db, apiConnectors, 'on_dq', enrichedData, leadId, supplierAttribution, supplierRecord);
          fireDeliveries(db, allDestinations, 'on_dq', enrichedData, leadId, supplierAttribution, supplierRecord);
          fireConnectors(db, apiConnectors, 'on_rejected', leadPayload, leadId, supplierAttribution, supplierRecord);
          fireDeliveries(db, allDestinations, 'on_rejected', leadPayload, leadId, supplierAttribution, supplierRecord);
        }
      } else {
        finalStatus = 'Error';
        supplierResponse = { Response: 'Error', reason: `LeadByte record status: ${recordStatus}` };
        envAcceptance = 'error'; envLeadStatus = 'error'; envCode = 'LB_ERROR';
        await db.entities.ErrorLog.create({
          lead_id: leadId, stage: 'leadbyte', severity: 'error',
          message: `Unexpected LeadByte record status: ${recordStatus}`,
          detail: JSON.stringify(lbResult), supplier_name: supplierAttribution,
        });
        await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution,
          { message: `Unexpected LeadByte status: ${recordStatus}` }).catch(() => {});
      }
    } else {
      // ── f. Top-level non-success: handle errors[] shape ──────────────
      const topStatus = lbResult.status || '';
      const errors = lbResult.errors || [];
      const firstError = errors.length > 0 ? String(errors[0]?.message || errors[0]?.error || errors[0] || '') : '';
      const lowerErr = firstError.toLowerCase();

      if (/duplicate/i.test(firstError)) {
        finalStatus = 'Duplicate';
        supplierResponse = { Response: 'Duplicate', reason: firstError };
        envAcceptance = 'duplicate'; envLeadStatus = 'duplicate'; envCode = 'DUPLICATE';
        await db.entities.Lead.update(leadId, { queue_reason: `Duplicate: ${firstError}` });
        fireConnectors(db, apiConnectors, 'on_duplicates', leadPayload, leadId, supplierAttribution, supplierRecord);
        fireDeliveries(db, allDestinations, 'on_duplicates', leadPayload, leadId, supplierAttribution, supplierRecord);
      } else if (isQueueableRejection(firstError)) {
        finalStatus = 'Queued';
        const queueReason = `LeadByte error (missing/invalid field): ${firstError || topStatus}`;
        await db.entities.Lead.update(leadId, { queue_reason: queueReason });
        supplierResponse = { Response: 'Unsold', reason: firstError || topStatus };
        envAcceptance = 'queued'; envLeadStatus = 'queued'; envCode = 'MISSING_FIELDS';
        fireConnectors(db, apiConnectors, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
        fireDeliveries(db, allDestinations, 'on_queued', leadPayload, leadId, supplierAttribution, supplierRecord);
        await evaluateNotifications(db, ['lead_queued', 'missing_fields'], { id: leadId, queue_reason: queueReason }, supplierAttribution, { queue_reason: queueReason });
      } else {
        finalStatus = 'Error';
        supplierResponse = { Response: 'Error', reason: firstError || lbResult.message || 'LeadByte returned non-success' };
        envAcceptance = 'error'; envLeadStatus = 'error'; envCode = 'LB_ERROR';
        await db.entities.ErrorLog.create({
          lead_id: leadId, stage: 'leadbyte', severity: 'error',
          message: firstError || lbResult.message || 'LeadByte returned non-success',
          detail: JSON.stringify(lbResult), supplier_name: supplierAttribution,
        });
        await evaluateNotifications(db, ['api_error'], { id: leadId }, supplierAttribution,
          { message: firstError || lbResult.message || 'LeadByte returned non-success' }).catch(() => {});
      }
    }

    // ── g. RESOLVE SUPPLIER RESPONSE VIA RESPONSEMAPPING ─────────────────
    if (finalStatus !== 'Queued' && finalStatus !== 'Duplicate') {
      const mapped = await resolveResponseMapping(db, lbResult, supplierResponse, finalStatus);
      supplierResponse = mapped.response;
      if (mapped.status && mapped.status !== finalStatus && finalStatus === 'Error') {
        finalStatus = mapped.status;
      }
    }

    // Include revenue in the supplier response for master keys, Internal suppliers,
    // or any submitting API key with expose_revenue enabled (per-key override).
    const exposeRevenue = apiKeyRecord.type === 'master' ||
      (apiKeyRecord.type === 'supplier' && supplierRecord?.supplier_type === 'Internal') ||
      apiKeyRecord.expose_revenue === true;
    if (exposeRevenue && capturedRevenue != null && !isNaN(capturedRevenue)) {
      supplierResponse = { ...supplierResponse, revenue: capturedRevenue.toFixed(2) };
    }

    // ── Build the layered envelope from the resolved legacy response ──────
    // resolveResponseMapping may have changed the Response label and, for an
    // Error, the finalStatus. Keep envelope lead_status/acceptance in sync.
    if (finalStatus === 'Sold') { envLeadStatus = 'sold'; envAcceptance = 'accepted'; envSold = true; envCode = 'SOLD'; }
    else if (finalStatus === 'Unsold') { envLeadStatus = 'unsold'; envAcceptance = 'accepted'; if (envCode === 'LB_ERROR') envCode = 'UNSOLD'; }
    else if (finalStatus === 'Duplicate') { envLeadStatus = 'duplicate'; envAcceptance = 'duplicate'; envCode = 'DUPLICATE'; }
    else if (finalStatus === 'Queued') { envLeadStatus = 'queued'; envAcceptance = 'queued'; }
    else if (finalStatus === 'Error') { envLeadStatus = 'error'; envAcceptance = 'error'; envCode = 'LB_ERROR'; }

    const finalEnvelope = buildEnvelope(traceId, {
      ok: envAcceptance === 'accepted' || envAcceptance === 'queued' || envAcceptance === 'duplicate',
      acceptance: envAcceptance,
      lead_id: systemLeadId,
      lead_status: envLeadStatus,
      sold: envSold,
      revenue: envSold ? capturedRevenue : null,
      code: envCode,
      reason: supplierResponse.reason || null,
      message: supplierResponse.reason || supplierResponse.Response || finalStatus,
      Response: supplierResponse.Response,
    });
    // Preserve the exposed revenue string on the envelope when present.
    if (supplierResponse.revenue != null) finalEnvelope.revenue_exposed = supplierResponse.revenue;

    // ── FINALIZE ─────────────────────────────────────────────────────────
    await db.entities.Lead.update(leadId, {
      final_status: finalStatus,
      processed_at: new Date().toISOString(),
      process_time_ms: Date.now() - startTime,
      response_returned: JSON.stringify(finalEnvelope),
    });

    // Fire outbound webhooks async (non-blocking)
    try {
      const webhooks = await db.entities.Webhook.filter({ enabled: true });
      const eventName = `lead.${finalStatus.toLowerCase()}`;
      webhooks.forEach(wh => {
        const events = parseJsonArray(wh.events);
        if (events.includes(eventName)) {
          const whHeaders = typeof wh.headers === 'string' ? JSON.parse(wh.headers || '{}') : (wh.headers || {});
          whHeaders['Content-Type'] = 'application/json';
          fetch(wh.url, {
            method: 'POST', headers: whHeaders,
            body: JSON.stringify({ event: eventName, lead_id: leadId, status: finalStatus, supplier: supplierAttribution }),
          }).catch(() => {});
        }
      });
    } catch {}

    return ctx.json(finalEnvelope, 200);

  } catch (err) {
    console.error('processLead uncaught error:', err);
    const errorEnvelope = buildEnvelope(traceId, {
      ok: false, acceptance: 'error', lead_id: null, lead_status: 'error',
      code: 'INTERNAL_ERROR', reason: 'Internal processing error',
      message: 'Internal processing error', Response: 'Error',
    });
    if (leadId) {
      try {
        await db.entities.Lead.update(leadId, {
          final_status: 'Error', error_stage: 'system',
          processed_at: new Date().toISOString(),
          process_time_ms: Date.now() - startTime,
          response_returned: JSON.stringify(errorEnvelope),
        });
      } catch {}
    }
    try {
      await db.entities.ErrorLog.create({
        lead_id: leadId, stage: 'system', severity: 'critical',
        message: err.message || 'Unknown error',
        detail: JSON.stringify({ stack: err.stack }),
        supplier_name: 'Unknown',
      });
    } catch {}
    return ctx.json(errorEnvelope, 200);
  }
}
