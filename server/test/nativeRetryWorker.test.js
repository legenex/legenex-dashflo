import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import nativeRetryWorker from '../src/functions/nativeRetryWorker.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeCtx({ user = OPERATOR, distributionMode = 'legacy_only' } = {}) {
  const db = {
    entities: {
      User: { get: async () => user },
      AppSettings: { list: async () => [{ distribution_mode: distributionMode }] },
    },
  };
  return { user, db, body: {}, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('nativeRetryWorker: safe no-op by default', () => {
  const original = process.env.NATIVE_RETRY_WORKER_ENABLED;
  beforeEach(() => { delete process.env.NATIVE_RETRY_WORKER_ENABLED; });
  afterEach(() => { if (original === undefined) delete process.env.NATIVE_RETRY_WORKER_ENABLED; else process.env.NATIVE_RETRY_WORKER_ENABLED = original; });

  it('does not run when NATIVE_RETRY_WORKER_ENABLED is unset, regardless of distribution_mode', async () => {
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'new_only' }));
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/NATIVE_RETRY_WORKER_ENABLED/);
  });

  it('does not run while distribution_mode is legacy_only, even with the env flag on', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'legacy_only' }));
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/legacy_only/);
  });

  it('runs (against an empty, in-memory attempt store - no network reachable) only when both gates are open', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'shadow' }));
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBeTruthy();
  });

  it('403s a non-operator caller before checking either gate', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const buyerUser = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };
    const res = await nativeRetryWorker(makeCtx({ user: buyerUser, distributionMode: 'new_only' }));
    expect(res.__status).toBe(403);
  });
});

// Stage 3: production-readiness bug fixes. The tests above never exercise
// deliverFn (the store is always empty), so these three real defects were
// invisible to the existing suite: engine.makeDbAttemptStore does not exist
// (the real export is makeEntityAttemptStore, so this would throw against
// any real database), the attempt_number was incremented a second time on
// top of runRetryWorker's own increment (skipping a number on every retry),
// and the health store was a fresh in-memory Map per invocation (so the
// breaker could never accumulate failures across scheduler ticks) while
// leadData was hardcoded to {} (so a payload_template or field_map retry
// would render empty). Both worker gates are open by construction here
// (that is what the code under test requires to reach deliverFn at all) -
// this does not change distribution_mode or NATIVE_RETRY_WORKER_ENABLED in
// any real environment; it is table-driven-safe local test state.
describe('nativeRetryWorker: deliverFn against a real due attempt (both gates open)', () => {
  let server; let base; let requestLog;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestLog.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'accepted' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => { requestLog = []; process.env.NATIVE_RETRY_WORKER_ENABLED = 'true'; });
  afterEach(() => { delete process.env.NATIVE_RETRY_WORKER_ENABLED; });

  function makeFullDb({ dueAttempt }) {
    const attempts = [{ ...dueAttempt }];
    const health = [];
    return {
      entities: {
        User: { get: async () => OPERATOR },
        AppSettings: { list: async () => [{ distribution_mode: 'new_only' }] },
        DeliveryAttempt: {
          async create(rec) { const row = { ...rec, id: 'a' + (attempts.length + 1) }; attempts.push(row); return row; },
          async update(id, patch) { const a = attempts.find((x) => x.id === id); Object.assign(a, patch); return a; },
          async filter(q) {
            return attempts.filter((a) => Object.entries(q).every(([k, v]) => a[k] === v));
          },
          async updateMany(query, { $set }) {
            const matches = attempts.filter((a) => Object.entries(query).every(([k, v]) => a[k] === v));
            for (const a of matches) Object.assign(a, $set);
            return { updated: matches.length };
          },
        },
        SubDelivery: {
          async get(id) {
            if (id !== 'sd1') return null;
            return {
              id: 'sd1', delivery_id: 'del1', target_url: `${base}/post`, method: 'POST', encoding: 'json',
              field_map: JSON.stringify([{ src: 'email', dest: 'email' }]),
              response_mapping: JSON.stringify({ accepted: 'accepted' }),
            };
          },
        },
        Lead: {
          async get(id) {
            if (id !== 'lead-1') return null;
            return { id: 'lead-1', email: 'retry-lead@example.com' };
          },
        },
        DestinationHealth: {
          async filter(q) { return health.filter((h) => Object.entries(q).every(([k, v]) => h[k] === v)); },
          async create(rec) { const row = { id: 'h' + (health.length + 1), ...rec }; health.push(row); return row; },
          async update(id, patch) { const h = health.find((x) => x.id === id); Object.assign(h, patch); return h; },
        },
        IntegrationConfig: { async filter() { return []; } },
      },
      _debug: { attempts, health },
    };
  }

  it('retries the due attempt using its already-incremented attempt_number exactly once (no skip)', async () => {
    const nowIso = new Date(0).toISOString();
    const db = makeFullDb({
      dueAttempt: {
        id: 'a1', lead_id: 'lead-1', sub_delivery_id: 'sd1', destination_id: null,
        status: 'error', attempt_number: 2, idempotency_key: 'idem-1',
        next_retry_at: nowIso, lease_until: null, lease_version: 0,
      },
    });
    const res = await nativeRetryWorker({ user: OPERATOR, db, body: {}, json: (d, s = 200) => ({ __status: s, ...d }) });
    expect(res.ran).toBe(true);
    expect(res.outcome).toHaveLength(1);
    // runRetryWorker computed nextAttemptNum = (2||1)+1 = 3 and handed the
    // worker an attempt object already carrying attempt_number: 3. Fixed
    // deliverFn must send attempt 3, not double-increment to 4.
    expect(db._debug.attempts[0].attempt_number).toBe(3);
    expect(db._debug.attempts[0].status).toBe('accepted');
  });

  it('sends the real lead data on retry, not an empty payload', async () => {
    const nowIso = new Date(0).toISOString();
    const db = makeFullDb({
      dueAttempt: {
        id: 'a1', lead_id: 'lead-1', sub_delivery_id: 'sd1', destination_id: null,
        status: 'error', attempt_number: 1, idempotency_key: 'idem-2',
        next_retry_at: nowIso, lease_until: null, lease_version: 0,
      },
    });
    await nativeRetryWorker({ user: OPERATOR, db, body: {}, json: (d, s = 200) => ({ __status: s, ...d }) });
    expect(requestLog).toHaveLength(1);
    expect(JSON.parse(requestLog[0].body)).toEqual({ email: 'retry-lead@example.com' });
  });

  it('persists circuit breaker state through the real DestinationHealth entity, not a throwaway in-memory store', async () => {
    const nowIso = new Date(0).toISOString();
    const db = makeFullDb({
      dueAttempt: {
        id: 'a1', lead_id: 'lead-1', sub_delivery_id: 'sd1', destination_id: null,
        status: 'error', attempt_number: 1, idempotency_key: 'idem-3',
        next_retry_at: nowIso, lease_until: null, lease_version: 0,
      },
    });
    await nativeRetryWorker({ user: OPERATOR, db, body: {}, json: (d, s = 200) => ({ __status: s, ...d }) });
    expect(db._debug.health).toHaveLength(1);
    expect(db._debug.health[0].sub_delivery_id).toBe('sd1');
    expect(db._debug.health[0].state).toBe('closed'); // accepted -> success
  });
});
