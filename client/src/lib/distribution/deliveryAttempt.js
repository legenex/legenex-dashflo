// Delivery attempt state machine + retry policy. Pure: `nowMs` passed in.
// A secondary failure must never overwrite a valid primary Sold/Unsold outcome,
// so the caller keeps primary and secondary attempts separate; this module only
// classifies responses, computes backoff, and builds redacted attempt records.

import { redact } from './engine.js';

export const ATTEMPT_STATUS = {
  PENDING: 'pending', SENT: 'sent', ACCEPTED: 'accepted', REJECTED: 'rejected',
  DUPLICATE: 'duplicate', QUEUED: 'queued', ERROR: 'error', DEAD_LETTER: 'dead_letter',
};

// Statuses that represent a settled outcome (never retried).
const TERMINAL = new Set([
  ATTEMPT_STATUS.ACCEPTED, ATTEMPT_STATUS.REJECTED, ATTEMPT_STATUS.DUPLICATE, ATTEMPT_STATUS.DEAD_LETTER,
]);

// Bounded exponential backoff (deterministic, no ambient time/jitter).
export function computeBackoffMs(attemptNumber, opts = {}) {
  const base = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 60 * 60 * 1000; // 1h cap
  const n = Math.max(1, attemptNumber);
  return Math.min(max, base * Math.pow(factor, n - 1));
}

export function nextRetryAtIso(nowMs, attemptNumber, opts = {}) {
  return new Date(nowMs + computeBackoffMs(attemptNumber, opts)).toISOString();
}

// Retry only transient failures, up to maxAttempts. Settled outcomes never retry.
export function shouldRetry(status, attemptNumber, maxAttempts = 5) {
  if (TERMINAL.has(status)) return false;
  if (status === ATTEMPT_STATUS.ACCEPTED) return false;
  const retryable = status === ATTEMPT_STATUS.ERROR || status === ATTEMPT_STATUS.QUEUED;
  return retryable && attemptNumber < maxAttempts;
}

// Response text is bounded before any operator-supplied regex runs against
// it. mapping.duplicate/reject/queue/accept are free-text patterns an
// operator enters in the delivery editor, matched with new RegExp(re, 'i')
// against the destination's response body. This bound protects against a
// large-but-otherwise-safe body making even a normal pattern slow to match
// (linear-time cost against a multi-megabyte string). It is NOT a complete
// defense against a deliberately pathological pattern (nested-quantifier
// catastrophic backtracking, e.g. (a+)+b): that class of pattern is
// exponential in the length of the matched run, so even this bound's 10,000
// characters is nowhere near small enough to guarantee fast completion
// against one. Full protection needs either a hard execution timeout on the
// match (not available for a synchronous RegExp in plain Node without a
// worker thread) or static rejection of dangerous pattern shapes at the
// point an operator saves a response_mapping - neither is implemented here;
// this bound is a real but partial mitigation, not a guarantee.
const MAX_CLASSIFY_TEXT_LENGTH = 10000;

// Classify a destination response into an attempt status. `mapping` optionally
// supplies regexes for duplicate/reject/queue detection in the body text.
export function classifyResponse({ httpStatus, body, error, mapping = {} } = {}) {
  if (error) return ATTEMPT_STATUS.ERROR;
  const fullText = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const text = fullText.length > MAX_CLASSIFY_TEXT_LENGTH ? fullText.slice(0, MAX_CLASSIFY_TEXT_LENGTH) : fullText;
  const test = (re) => { try { return re && new RegExp(re, 'i').test(text); } catch { return false; } };

  if (mapping.duplicate && test(mapping.duplicate)) return ATTEMPT_STATUS.DUPLICATE;
  if (mapping.reject && test(mapping.reject)) return ATTEMPT_STATUS.REJECTED;
  if (mapping.queue && test(mapping.queue)) return ATTEMPT_STATUS.QUEUED;
  if (mapping.accept && test(mapping.accept)) return ATTEMPT_STATUS.ACCEPTED;

  if (httpStatus == null) return ATTEMPT_STATUS.ERROR;
  if (httpStatus >= 200 && httpStatus < 300) {
    // When acceptance is authoritative (requireAccept) and the accept pattern did
    // not match above, a 2xx is NOT a sale: the buyer echoed OK but did not
    // confirm acceptance, so treat it as a rejection rather than a false Sold.
    if (mapping.requireAccept && mapping.accept) return ATTEMPT_STATUS.REJECTED;
    return ATTEMPT_STATUS.ACCEPTED;
  }
  if (httpStatus === 409) return ATTEMPT_STATUS.DUPLICATE;
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return ATTEMPT_STATUS.ERROR;
  if (httpStatus >= 400) return ATTEMPT_STATUS.REJECTED;
  return ATTEMPT_STATUS.ERROR;
}

// Normalizes a persisted SubDelivery.response_mapping object (the generic
// editor's storage shape: accepted/rejected/duplicate/queued/revenue/
// buyer_lead_id/require_accept) into the exact shape classifyResponse reads,
// plus the two JSON dot-paths callers extract separately (revenuePath,
// leadIdPath - classifyResponse itself ignores these, they are extracted by
// the caller via getPath against the parsed response body).
//
// This is the ONE place the storage shape becomes the evaluator shape.
// Before Stage 3 this translation was inlined three times (directPost.js via
// deliveryResolve.js's toResponseMapping, the editor's live preview, and
// deliveryMockSend.js), each hand-written and free to drift from the others
// even though they currently agreed. Centralizing it here removes that risk:
// Dry Run, Mock Send, and the real native send path all call this same
// function, reached through the generated bundle server-side.
export function toClassifyResponseMapping(rm) {
  if (!rm || typeof rm !== 'object') return {};
  return {
    accept: rm.accepted || null,
    reject: rm.rejected || null,
    duplicate: rm.duplicate || null,
    queue: rm.queued || null,
    requireAccept: rm.require_accept === true,
    revenuePath: rm.revenue || null,
    leadIdPath: rm.buyer_lead_id || null,
  };
}

// Build a persisted attempt record with secrets redacted and PII minimized.
export function buildAttemptRecord({
  leadId, destinationId, trigger, attemptNumber = 1, idempotencyKey, isPrimary = false,
  status, request = {}, response = {}, httpStatus = null, latencyMs = null, errorClass = null,
  nowMs = 0, retryOpts = {},
}) {
  const willRetry = shouldRetry(status, attemptNumber, retryOpts.maxAttempts ?? 5);
  const finalStatus = (!willRetry && (status === ATTEMPT_STATUS.ERROR || status === ATTEMPT_STATUS.QUEUED)
    && attemptNumber >= (retryOpts.maxAttempts ?? 5)) ? ATTEMPT_STATUS.DEAD_LETTER : status;
  return {
    lead_id: leadId,
    destination_id: destinationId,
    trigger: trigger ?? null,
    attempt_number: attemptNumber,
    idempotency_key: idempotencyKey ?? null,
    is_primary: !!isPrimary,
    status: finalStatus,
    request_meta: JSON.stringify(redact(minimizeRequest(request))),
    response_meta: JSON.stringify(minimizeResponse(response)),
    http_status: httpStatus,
    latency_ms: latencyMs,
    error_class: errorClass,
    next_retry_at: willRetry ? nextRetryAtIso(nowMs, attemptNumber, retryOpts) : null,
    completed_at: new Date(nowMs).toISOString(),
  };
}

function minimizeRequest(req) {
  // keep method/url/headers (redacted downstream) but never the raw PII body verbatim
  return { method: req.method, url: req.url, headers: req.headers, body_present: req.body != null };
}
function minimizeResponse(res) {
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
  return { status: res.status ?? null, body_excerpt: text.slice(0, 500) };
}
