// Shared {{token|transform}} payload template resolver.
//
// Extracted from testWebhookDelivery.js (the legacy LeadByteConnector "Send
// Test Lead" function) so the native Delivery/SubDelivery dry-run/mock-send
// path resolves tokens identically rather than carrying a second, silently
// diverging copy of the same ~130 lines. Pure refactor: behavior is
// unchanged, callers just import from here now.
//
// Moved from server/src/lib/payloadTemplate.js into the canonical isomorphic
// engine source (Stage 3): directPost.js's real native send path renders
// SubDelivery.payload_template through this exact module too, via the
// generated bundle, so preview, mock send, and the real send path can never
// resolve a token differently from one another. Re-exported from
// backend-entry.js as `applyTemplateTransform` to avoid a name collision with
// transforms.js's field-map applyTransform, which is a distinct function.

export async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function phoneUs(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return '1' + digits;
  return digits;
}

export function escapeJsonString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export function resolveTokenValue(token, d) {
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
    case 'ip_address':
      return d.ip_address || d.ipaddress || '';
    case 'email':
      return d.email || '';
    case 'first_name':
      return d.first_name || d.firstname || '';
    case 'last_name':
      return d.last_name || d.lastname || '';
    case 'zip':
      return d.zip || d.zipcode || d.zip_code || '';
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
    default: {
      const val = d[token];
      return val !== undefined && val !== null ? String(val) : '';
    }
  }
}

export async function applyTransform(value, transform) {
  switch (transform) {
    case 'sha256': return await sha256Hex(value);
    case 'lowercase': return String(value).toLowerCase();
    case 'uppercase': return String(value).toUpperCase();
    case 'trim': return String(value).trim();
    case 'phone_us': return phoneUs(value);
    default: return value;
  }
}

export async function resolveTemplate(templateStr, data) {
  const pattern = /\{\{([\w.]+(?:\|[\w]+)*)\}\}/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(templateStr)) !== null) {
    matches.push({ expr: m[1], index: m.index, length: m[0].length });
  }
  const resolved = await Promise.all(matches.map(async (match) => {
    const parts = match.expr.split('|').map((s) => s.trim());
    const token = parts[0];
    const transforms = parts.slice(1);
    let value = resolveTokenValue(token, data || {});
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

export async function buildPayloadFromTemplate(template, data) {
  if (!template) return data;
  const tmpl = typeof template === 'string' ? template : JSON.stringify(template);
  const resolved = await resolveTemplate(tmpl, data);
  try { return JSON.parse(resolved); } catch { return resolved; }
}
