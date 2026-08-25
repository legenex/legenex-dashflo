// Backend direct-post delivery adapter. Builds the outbound request (method,
// JSON or form encoding, headers, field mapping, transforms), enforces a host
// allowlist in test mode, persists a DeliveryAttempt BEFORE sending, sends with a
// timeout and manual redirect handling, classifies the response, extracts revenue
// and the buyer lead id, and stores a redacted, completed attempt record.
//
// Pure of ambient time and network: fetchImpl and nowMs are injected, so the same
// adapter runs in Deno (production) and in npm test against a local mock server.

import { classifyResponse, buildAttemptRecord, ATTEMPT_STATUS } from './deliveryAttempt.js';
import { applyTransform } from './transforms.js';
import { buildPayloadFromTemplate } from './payloadTemplate.js';

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function isLocalhost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// Map lead fields into the outbound payload using a field map + optional transforms.
// fieldMap: [{ src, dest, transform }]; conditional fields dropped when empty.
function buildPayload(leadData, fieldMap) {
  const out = {};
  for (const f of fieldMap || []) {
    let v = leadData[f.src];
    if (f.transform) v = applyTransform(v, f.transform);
    if (f.required && (v == null || v === '')) continue; // conditional/required-empty dropped
    if (v !== undefined) out[f.dest || f.src] = v;
  }
  return out;
}

// cfg: { destinationId, routeMemberId, targetUrl, method, encoding, headers, fieldMap, payloadTemplate, timeoutMs,
//        responseMapping:{accept,reject,duplicate,queue,requireAccept,revenuePath,leadIdPath},
//        idempotencyKey, leadData, leadId, attemptNumber, isPrimary, trigger, retryOpts }
// payloadTemplate, when a non-empty string, is authoritative over fieldMap.
// ctx: { store, nowMs, fetchImpl, testMode, allowlistHosts, validateTarget }
// validateTarget(url) -> Promise<{ok, reason?}>, injected by the server (see
// server/src/lib/ssrfGuard.js) so this isomorphic module never imports a
// Node-only DNS API directly. Only applied for a REAL (non-test-mode) send;
// testMode already enforces its own localhost-only allowlist below.
export async function deliverDirectPost(cfg, ctx) {
  const nowMs = ctx.nowMs ?? 0;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const attemptNumber = cfg.attemptNumber || 1;
  const method = String(cfg.method || 'POST').toUpperCase();

  let url;
  try { url = new URL(cfg.targetUrl); } catch { return failClosed(ctx, cfg, nowMs, 'invalid_url', 'INVALID_URL'); }

  // Test-mode host allowlist: only localhost is permitted so no test can reach a
  // real buyer or arbitrary host.
  if (ctx.testMode) {
    const allowed = ctx.allowlistHosts || [];
    if (!isLocalhost(url.hostname) && !allowed.includes(url.hostname)) {
      return failClosed(ctx, cfg, nowMs, 'host_not_allowed', 'HOST_NOT_ALLOWED');
    }
  } else if (typeof ctx.validateTarget === 'function') {
    // SSRF guard for a real send: an operator-configured target_url must
    // resolve only to a public address. Never validates the literal string
    // and stops there - the injected validator re-resolves DNS at send time,
    // so a hostname crafted to resolve to a private/metadata address is
    // caught even when the string itself looks public. Redirects are never
    // followed (fetch is called with redirect:'manual' below and the
    // response is never re-dispatched), so there is no separate
    // validate-then-redirect-into-private-network path to close.
    const check = await ctx.validateTarget(url);
    if (!check || check.ok !== true) {
      return failClosed(ctx, cfg, nowMs, check && check.reason ? check.reason : 'target_not_allowed', 'SSRF_BLOCKED');
    }
  }

  // Query parameters: resolved the same way as payload_template (same
  // {{token|transform}} renderer), appended to the target URL rather than the
  // body. Honored for any method (harmless alongside a body), but this is the
  // ONLY outbound mechanism for GET/DELETE-without-body, which never send one.
  // finalUrl only diverges from the operator-configured cfg.targetUrl string
  // when a query parameter is actually appended - the URL object's own
  // serialization lowercases the hostname and can otherwise reformat a URL
  // that had nothing wrong with it, a needless behavior change for the common
  // case (no query_params configured) that a byte-identical passthrough avoids.
  let finalUrl = cfg.targetUrl;
  if (cfg.queryParamsTemplate && String(cfg.queryParamsTemplate).trim() !== '') {
    let renderedParams;
    try {
      renderedParams = await buildPayloadFromTemplate(cfg.queryParamsTemplate, cfg.leadData || {});
    } catch {
      return failClosed(ctx, cfg, nowMs, 'invalid_query_params_template', 'INVALID_QUERY_PARAMS_TEMPLATE');
    }
    if (renderedParams === null || typeof renderedParams !== 'object' || Array.isArray(renderedParams)) {
      return failClosed(ctx, cfg, nowMs, 'invalid_query_params_template', 'INVALID_QUERY_PARAMS_TEMPLATE');
    }
    let appended = false;
    for (const [k, v] of Object.entries(renderedParams)) {
      if (v != null) { url.searchParams.set(k, String(v)); appended = true; }
    }
    if (appended) finalUrl = url.toString();
  }

  // A GET never sends a body. A DELETE only sends one when the SubDelivery
  // explicitly opted in via delete_with_body - otherwise it behaves like GET.
  // POST/PUT/PATCH always send one. Method changes the wire request, not just
  // which editor section the operator sees.
  const sendsBody = method !== 'GET' && !(method === 'DELETE' && !cfg.deleteWithBody);

  // Payload: SubDelivery.payload_template is authoritative when configured
  // (same generic {{token|transform}} renderer as Dry Run and Mock Send, via
  // payloadTemplate.js), otherwise fall back to the structured field_map, for
  // backward compatibility with SubDeliveries that only ever configured that.
  // Skipped entirely when the method sends no body (GET, or DELETE without
  // delete_with_body): there is nothing to render or fail closed on.
  let payload;
  if (sendsBody) {
    if (cfg.payloadTemplate && String(cfg.payloadTemplate).trim() !== '') {
      let rendered;
      try {
        rendered = await buildPayloadFromTemplate(cfg.payloadTemplate, cfg.leadData || {});
      } catch {
        return failClosed(ctx, cfg, nowMs, 'invalid_payload_template', 'INVALID_PAYLOAD_TEMPLATE');
      }
      // buildPayloadFromTemplate falls back to the raw resolved STRING when the
      // rendered text is not valid JSON (useful for a preview showing the
      // operator what broke). The real send path must never silently POST that
      // string as if it were the payload: fail closed instead.
      if (rendered === null || typeof rendered !== 'object' || Array.isArray(rendered)) {
        return failClosed(ctx, cfg, nowMs, 'invalid_payload_template', 'INVALID_PAYLOAD_TEMPLATE');
      }
      payload = rendered;
    } else {
      payload = buildPayload(cfg.leadData || {}, cfg.fieldMap);
    }
  }
  const encoding = cfg.encoding === 'form' ? 'form' : 'json';
  const headers = { ...(cfg.headers || {}) }; // NON-secret headers only (never carries a stored key)
  // CREDENTIAL HARD RULE: resolve the opaque credential_ref to real secret headers
  // HERE, server-side, at send time. The secret never lives in the SubDelivery
  // JSON, the snapshot, or any browser-facing shape. It exists only in this local
  // request header object for the duration of the send.
  if (cfg.credentialRef && typeof ctx.resolveCredential === 'function') {
    const resolved = await ctx.resolveCredential(cfg.credentialRef);
    if (resolved && typeof resolved === 'object') {
      for (const [k, v] of Object.entries(resolved)) { if (v != null) headers[k] = v; }
    }
  }
  headers['Idempotency-Key'] = cfg.idempotencyKey;
  let body;
  if (sendsBody) {
    if (encoding === 'form') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
      body = new URLSearchParams(payload).toString();
    } else {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(payload);
    }
  }

  // Persist the attempt BEFORE sending (durable record for crash recovery).
  const pending = await ctx.store.createAttempt({
    lead_id: cfg.leadId, sub_delivery_id: cfg.subDeliveryId || null, destination_id: cfg.destinationId,
    route_member_id: cfg.routeMemberId || null, trigger: cfg.trigger || 'primary',
    attempt_number: attemptNumber, idempotency_key: cfg.idempotencyKey,
    run_idempotency_key: cfg.runIdempotencyKey || null, is_primary: !!cfg.isPrimary,
    status: ATTEMPT_STATUS.PENDING, started_at: new Date(nowMs).toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 10000);
  let httpStatus = null; let bodyText = ''; let errorClass = null;
  const t0 = nowMs;
  try {
    const resp = await fetchImpl(finalUrl, {
      method, headers, body, redirect: 'manual', signal: controller.signal,
    });
    httpStatus = resp.status;
    bodyText = await resp.text();
  } catch (e) {
    errorClass = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message.slice(0, 60) : 'network_error');
  } finally {
    clearTimeout(timer);
  }

  // cfg.responseMapping already arrives in classifyResponse's own shape
  // (accept/reject/duplicate/queue/requireAccept/revenuePath/leadIdPath):
  // deliveryResolve.js's resolveSubDeliveryCfg produces it via the same
  // toClassifyResponseMapping the editor preview and Mock Send use, so there
  // is no second, call-site-local translation left to drift from those.
  const mapping = cfg.responseMapping || {};
  const status = errorClass
    ? ATTEMPT_STATUS.ERROR
    : classifyResponse({ httpStatus, body: bodyText, mapping });

  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
  const revenue = status === ATTEMPT_STATUS.ACCEPTED && parsed ? Number(getPath(parsed, mapping.revenuePath)) || 0 : 0;
  const buyerLeadId = parsed ? getPath(parsed, mapping.leadIdPath) ?? null : null;

  const record = buildAttemptRecord({
    leadId: cfg.leadId, destinationId: cfg.destinationId, trigger: cfg.trigger, attemptNumber,
    idempotencyKey: cfg.idempotencyKey, isPrimary: cfg.isPrimary, status,
    request: { method, url: finalUrl, headers, body: body ?? null },
    response: { status: httpStatus, body: bodyText }, httpStatus,
    latencyMs: (ctx.nowMs ?? 0) - t0, errorClass, nowMs, retryOpts: cfg.retryOpts,
  });
  await ctx.store.updateAttempt(pending.id, record);

  return {
    attemptId: pending.id, status: record.status, httpStatus, revenue, buyerLeadId,
    retryable: record.next_retry_at != null, nextRetryAt: record.next_retry_at, errorClass,
  };
}

async function failClosed(ctx, cfg, nowMs, errorClass, code) {
  const rec = await ctx.store.createAttempt({
    lead_id: cfg.leadId, destination_id: cfg.destinationId, route_member_id: cfg.routeMemberId || null,
    attempt_number: cfg.attemptNumber || 1,
    idempotency_key: cfg.idempotencyKey, run_idempotency_key: cfg.runIdempotencyKey || null, is_primary: !!cfg.isPrimary,
    status: ATTEMPT_STATUS.ERROR, error_class: errorClass, code,
    started_at: new Date(nowMs).toISOString(), completed_at: new Date(nowMs).toISOString(),
  });
  return { attemptId: rec.id, status: ATTEMPT_STATUS.ERROR, code, errorClass, retryable: false, revenue: 0, buyerLeadId: null };
}
