import { describe, it, expect } from 'vitest';
import {
  ATTEMPT_STATUS, computeBackoffMs, nextRetryAtIso, shouldRetry, classifyResponse, buildAttemptRecord,
  toClassifyResponseMapping,
} from './deliveryAttempt.js';

describe('computeBackoffMs (bounded exponential)', () => {
  it('grows exponentially and caps', () => {
    expect(computeBackoffMs(1, { baseMs: 1000, factor: 2 })).toBe(1000);
    expect(computeBackoffMs(3, { baseMs: 1000, factor: 2 })).toBe(4000);
    expect(computeBackoffMs(99, { baseMs: 1000, factor: 2, maxMs: 60000 })).toBe(60000);
  });
});

describe('shouldRetry', () => {
  it('retries transient error/queued under the cap', () => {
    expect(shouldRetry(ATTEMPT_STATUS.ERROR, 1, 5)).toBe(true);
    expect(shouldRetry(ATTEMPT_STATUS.QUEUED, 4, 5)).toBe(true);
    expect(shouldRetry(ATTEMPT_STATUS.ERROR, 5, 5)).toBe(false); // hit cap
  });
  it('never retries settled outcomes', () => {
    for (const s of [ATTEMPT_STATUS.ACCEPTED, ATTEMPT_STATUS.REJECTED, ATTEMPT_STATUS.DUPLICATE, ATTEMPT_STATUS.DEAD_LETTER]) {
      expect(shouldRetry(s, 1, 5)).toBe(false);
    }
  });
});

describe('classifyResponse', () => {
  it('maps HTTP status codes', () => {
    expect(classifyResponse({ httpStatus: 200, body: 'ok' })).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(classifyResponse({ httpStatus: 409, body: '' })).toBe(ATTEMPT_STATUS.DUPLICATE);
    expect(classifyResponse({ httpStatus: 400, body: 'bad' })).toBe(ATTEMPT_STATUS.REJECTED);
    expect(classifyResponse({ httpStatus: 500, body: 'err' })).toBe(ATTEMPT_STATUS.ERROR);
    expect(classifyResponse({ httpStatus: 429, body: '' })).toBe(ATTEMPT_STATUS.ERROR);
    expect(classifyResponse({ error: 'timeout' })).toBe(ATTEMPT_STATUS.ERROR);
  });
  it('honors body mapping regexes over status', () => {
    expect(classifyResponse({ httpStatus: 200, body: '{"result":"duplicate"}', mapping: { duplicate: 'duplicate' } }))
      .toBe(ATTEMPT_STATUS.DUPLICATE);
    expect(classifyResponse({ httpStatus: 200, body: 'REJECT: dq', mapping: { reject: 'reject' } }))
      .toBe(ATTEMPT_STATUS.REJECTED);
  });
});

describe('buildAttemptRecord', () => {
  it('redacts secrets, minimizes PII, sets next_retry when retryable', () => {
    const rec = buildAttemptRecord({
      leadId: 'L1', destinationId: 'D1', trigger: 'on_sold', attemptNumber: 1, idempotencyKey: 'k',
      isPrimary: true, status: ATTEMPT_STATUS.ERROR,
      request: { method: 'POST', url: 'https://x', headers: { Authorization: 'Bearer secret' }, body: { email: 'a@b.com' } },
      response: { status: 500, body: 'server error' }, httpStatus: 500, latencyMs: 120, nowMs: 0,
    });
    expect(rec.is_primary).toBe(true);
    expect(rec.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(rec.next_retry_at).not.toBe(null);
    const reqMeta = JSON.parse(rec.request_meta);
    expect(reqMeta.headers.Authorization).toBe('[redacted]');
    expect(reqMeta.body_present).toBe(true); // raw PII body not stored verbatim
    expect(reqMeta.email).toBeUndefined();
  });
  it('promotes to dead_letter at the retry cap', () => {
    const rec = buildAttemptRecord({
      leadId: 'L1', destinationId: 'D1', status: ATTEMPT_STATUS.ERROR, attemptNumber: 5,
      httpStatus: 500, nowMs: 0, retryOpts: { maxAttempts: 5 },
    });
    expect(rec.status).toBe(ATTEMPT_STATUS.DEAD_LETTER);
    expect(rec.next_retry_at).toBe(null);
  });
  it('accepted primary outcome is terminal (no retry)', () => {
    const rec = buildAttemptRecord({ leadId: 'L1', destinationId: 'D1', status: ATTEMPT_STATUS.ACCEPTED, httpStatus: 200, nowMs: 0 });
    expect(rec.next_retry_at).toBe(null);
  });
});

describe('nextRetryAtIso', () => {
  it('returns an ISO timestamp offset by the backoff', () => {
    expect(nextRetryAtIso(0, 1, { baseMs: 1000, factor: 2 })).toBe('1970-01-01T00:00:01.000Z');
  });
});

// Stage 3: the one shared storage-shape -> evaluator-shape translation, used
// by deliveryResolve.js (real send path), the editor's live preview, and
// deliveryMockSend.js, so all three can never classify a response
// differently because one hand-written copy drifted from the others.
describe('toClassifyResponseMapping', () => {
  it('maps the persisted SubDelivery.response_mapping storage shape to classifyResponse\'s param shape', () => {
    const mapped = toClassifyResponseMapping({
      accepted: 'ok', rejected: 'no', duplicate: 'dup', queued: 'q',
      revenue: 'price', buyer_lead_id: 'ext_id', require_accept: true,
    });
    expect(mapped).toEqual({
      accept: 'ok', reject: 'no', duplicate: 'dup', queue: 'q',
      requireAccept: true, revenuePath: 'price', leadIdPath: 'ext_id',
    });
  });

  it('the output classifies identically through classifyResponse regardless of caller', () => {
    const mapped = toClassifyResponseMapping({ accepted: 'result.*accepted', require_accept: true });
    const status = classifyResponse({ httpStatus: 200, body: '{"result":"accepted"}', mapping: mapped });
    expect(status).toBe(ATTEMPT_STATUS.ACCEPTED);
  });

  it('a 2xx with requireAccept set but no accept-pattern match is a rejection, not a silent Sold', () => {
    const mapped = toClassifyResponseMapping({ accepted: 'result.*accepted', require_accept: true });
    const status = classifyResponse({ httpStatus: 200, body: '{"result":"pending"}', mapping: mapped });
    expect(status).toBe(ATTEMPT_STATUS.REJECTED);
  });

  it('handles missing/empty config without throwing', () => {
    expect(toClassifyResponseMapping(null)).toEqual({});
    expect(toClassifyResponseMapping(undefined)).toEqual({});
    expect(toClassifyResponseMapping({})).toEqual({
      accept: null, reject: null, duplicate: null, queue: null,
      requireAccept: false, revenuePath: null, leadIdPath: null,
    });
  });
});
