// Canonical SubDelivery -> directPost cfg resolver. This is the ONE place that
// turns a persisted SubDelivery record into the outbound delivery config the
// directPost adapter consumes. Pure and testable.
//
// CREDENTIAL HARD RULE: this resolver NEVER reads or emits a secret value. It
// carries `credentialRef` (an opaque reference) and NON-secret `headers` only.
// The real secret is resolved server-side at send time by the adapter via an
// injected `resolveCredential(ref)` (see directPost). A secret must never appear
// in a snapshot object, an operator response, or anything sent to the browser.

import { toClassifyResponseMapping } from './deliveryAttempt.js';

function parseJson(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// Map [{ src/dest }] field_map config; accepts object form { dest: src } too.
function toFieldMap(fm) {
  if (Array.isArray(fm)) return fm;
  if (fm && typeof fm === 'object') return Object.entries(fm).map(([dest, src]) => ({ src, dest }));
  return [];
}

// Project a SubDelivery into a BROWSER-SAFE operator shape. The credential value
// never leaves the server, and even the opaque credential_ref is not shipped; the
// UI gets presence + last-updated + a replace affordance only. Headers are
// redacted defensively in case a secret-named header was ever mis-stored.
const HEADER_SECRET_KEYS = ['authorization', 'api_key', 'apikey', 'x-api-key', 'password', 'secret', 'token', 'bearer'];
export function projectSubDeliveryForClient(sd) {
  if (!sd) return null;
  const rawHeaders = parseJson(sd.headers) || {};
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    headers[k] = HEADER_SECRET_KEYS.some((s) => k.toLowerCase().includes(s)) ? '[redacted]' : v;
  }
  return {
    id: sd.id,
    delivery_id: sd.delivery_id,
    name: sd.name || '',
    active: sd.active !== false,
    order_index: Number(sd.order_index) || 0,
    target_url: sd.target_url || '',
    method: sd.method || 'POST',
    encoding: sd.encoding || 'json',
    headers,
    field_map: sd.field_map || '',
    transforms: sd.transforms || '',
    response_mapping: sd.response_mapping || '',
    timeout_ms: Number(sd.timeout_ms) || 10000,
    retry_policy: sd.retry_policy || '',
    // Credential: presence + last-updated only. Never the value, never the ref.
    credential_present: !!sd.credential_ref,
    credential_updated_at: sd.credential_updated_at || null,
  };
}

// A single send must never be allowed to run longer than the retry worker's
// lease can safely outlast (retryWorker.js's DEFAULT_LEASE_MS is set well
// above this bound with margin). Without a ceiling, an operator-configured
// timeout_ms could legitimately exceed any lease duration, and a second
// worker would then be able to reclaim and re-send an attempt whose first
// send is still genuinely in flight - a real double-send, not a hypothetical
// one. 20s is generous for any legitimate destination.
const MAX_SEND_TIMEOUT_MS = 20000;

// sd: a SubDelivery record (snake_case). Returns a directPost cfg fragment.
// Never includes a resolved secret; only credentialRef + non-secret headers.
export function resolveSubDeliveryCfg(sd) {
  if (!sd) return null;
  const retry = parseJson(sd.retry_policy) || {};
  return {
    subDeliveryId: sd.id,
    targetUrl: sd.target_url || '',
    method: sd.method || 'POST',
    encoding: sd.encoding === 'form' ? 'form' : 'json',
    headers: parseJson(sd.headers) || {}, // NON-secret headers only (schema forbids secrets here)
    credentialRef: sd.credential_ref || null, // opaque reference; resolved at send time
    fieldMap: toFieldMap(parseJson(sd.field_map)),
    // Authoritative over fieldMap when non-empty; see directPost.js.
    payloadTemplate: typeof sd.payload_template === 'string' ? sd.payload_template : '',
    transforms: parseJson(sd.transforms) || [],
    responseMapping: toClassifyResponseMapping(parseJson(sd.response_mapping)),
    timeoutMs: Math.min(Number(sd.timeout_ms) || 10000, MAX_SEND_TIMEOUT_MS),
    retryOpts: retry,
  };
}
