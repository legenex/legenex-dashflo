import { describe, it, expect } from 'vitest';
import { runRetryWorker, manualRetry, backoffWithJitter } from './retryWorker.js';
import { makeInMemoryAttemptStore } from './deliveryStore.js';
import { makeInMemoryHealthStore, nextHealth, isBlocked, CIRCUIT } from './destinationHealth.js';
import { ATTEMPT_STATUS } from './deliveryAttempt.js';

function seedDue(store, n, over = {}) {
  const past = new Date(0).toISOString();
  return Promise.all(Array.from({ length: n }, (_, i) => store.createAttempt({
    lead_id: 'L' + i, destination_id: 'd1', status: ATTEMPT_STATUS.ERROR,
    attempt_number: 1, next_retry_at: past, ...over,
  })));
}

describe('retry worker (atomic lease, no double-send)', () => {
  it('two concurrent workers never send the same attempt', async () => {
    const store = makeInMemoryAttemptStore();
    await seedDue(store, 8);
    const sends = new Map(); // attemptId -> [workers]
    const deliverFn = async (a) => {
      sends.set(a.id, [...(sends.get(a.id) || []), a._w]);
      return { status: ATTEMPT_STATUS.ACCEPTED, retryable: false };
    };
    // wrap deliverFn to tag the worker
    const mk = (w) => (a) => deliverFn({ ...a, _w: w });
    const [ra, rb] = await Promise.all([
      runRetryWorker(store, mk('A'), { nowMs: 1000, workerId: 'A' }),
      runRetryWorker(store, mk('B'), { nowMs: 1000, workerId: 'B' }),
    ]);
    // every attempt sent exactly once, by exactly one worker
    for (const [, workers] of sends) expect(workers).toHaveLength(1);
    expect(sends.size).toBe(8);
    expect(ra.length + rb.length).toBe(8);
  });

  it('recovers an attempt whose lease has expired', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await seedDue(store, 1);
    // simulate a dead worker holding an expired lease
    await store.updateAttempt(a.id, { lease_until: new Date(500).toISOString(), leased_by: 'dead', lease_version: 1 });
    const res = await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ACCEPTED }), { nowMs: 1000, workerId: 'B' });
    expect(res).toHaveLength(1); // claimed despite the stale lease
  });

  it('promotes to dead-letter at the attempt cap', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await seedDue(store, 1, { attempt_number: 4 });
    await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ERROR }), { nowMs: 1000, workerId: 'A', maxAttempts: 5 });
    expect((await store.getAttempt(a.id)).status).toBe(ATTEMPT_STATUS.DEAD_LETTER);
  });

  it('persists the incremented attempt_number on a successful retry, not just on dead-letter/reschedule', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await seedDue(store, 1, { attempt_number: 2 });
    await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ACCEPTED }), { nowMs: 1000, workerId: 'A' });
    expect((await store.getAttempt(a.id)).attempt_number).toBe(3);
  });

  it('persists the incremented attempt_number on a rejected/duplicate retry too', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await seedDue(store, 1, { attempt_number: 1 });
    await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.REJECTED }), { nowMs: 1000, workerId: 'A' });
    expect((await store.getAttempt(a.id)).attempt_number).toBe(2);
  });

  it('reschedules a transient error with a future next_retry_at', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await seedDue(store, 1, { attempt_number: 1 });
    await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ERROR }), { nowMs: 1000, workerId: 'A', maxAttempts: 5 });
    const row = await store.getAttempt(a.id);
    expect(row.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(Date.parse(row.next_retry_at)).toBeGreaterThan(1000);
    expect(row.lease_until).toBe(null);
  });

  it('manual retry sends and records the outcome', async () => {
    const store = makeInMemoryAttemptStore();
    const [a] = await store.createAttempt ? [await store.createAttempt({ lead_id: 'L', destination_id: 'd1', status: ATTEMPT_STATUS.DEAD_LETTER, attempt_number: 5 })] : [];
    const health = makeInMemoryHealthStore();
    const out = await manualRetry(store, a.id, async () => ({ status: ATTEMPT_STATUS.ACCEPTED }), { nowMs: 2000, healthStore: health });
    expect(out.ok).toBe(true);
    expect(out.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    const row = await store.getAttempt(a.id);
    expect(row.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(row.attempt_number).toBe(6); // was 5, manualRetry increments and persists it
  });

  it('updates the circuit breaker on repeated failures', async () => {
    const store = makeInMemoryAttemptStore();
    const health = makeInMemoryHealthStore();
    for (let i = 0; i < 5; i++) {
      await seedDue(store, 1);
      await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ERROR }),
        { nowMs: 1000, workerId: 'A', healthStore: health, healthOpts: { failureThreshold: 5 }, maxAttempts: 99 });
    }
    const h = await health.get('d1');
    expect(h.state).toBe(CIRCUIT.OPEN);
    expect(isBlocked(h, 1000)).toBe(true);
  });
});

describe('runRetryWorker: fresh per-attempt clock (ctx.now)', () => {
  // Regression (adversarial review): a single ctx.nowMs read at the top of
  // the pass was reused for EVERY claimLease call in the whole batch, so a
  // slow send earlier in the SAME sequential pass silently ate into later
  // attempts' lease safety margin - the margin the 90s DEFAULT_LEASE_MS
  // exists to guarantee. ctx.now(), when supplied, is read fresh before
  // every claim instead.
  it('without ctx.now, every claim uses the same static nowMs (unchanged prior behavior)', async () => {
    const store = makeInMemoryAttemptStore();
    await seedDue(store, 2);
    const claimTimes = [];
    const realClaimLease = store.claimLease.bind(store);
    store.claimLease = (id, workerId, nowMs, leaseMs, requiredStatus) => {
      claimTimes.push(nowMs);
      return realClaimLease(id, workerId, nowMs, leaseMs, requiredStatus);
    };
    await runRetryWorker(store, async () => ({ status: ATTEMPT_STATUS.ACCEPTED }), { nowMs: 1000, workerId: 'A' });
    expect(claimTimes).toEqual([1000, 1000]);
  });

  it('with ctx.now supplied, each claim reads a fresh timestamp, advancing across a slow batch', async () => {
    const store = makeInMemoryAttemptStore();
    await seedDue(store, 3);
    const claimTimes = [];
    const realClaimLease = store.claimLease.bind(store);
    store.claimLease = (id, workerId, nowMs, leaseMs, requiredStatus) => {
      claimTimes.push(nowMs);
      return realClaimLease(id, workerId, nowMs, leaseMs, requiredStatus);
    };
    let clock = 1000;
    const deliverFn = async () => { clock += 20000; return { status: ATTEMPT_STATUS.ACCEPTED }; }; // a "slow" 20s send
    await runRetryWorker(store, deliverFn, { nowMs: 1000, workerId: 'A', now: () => clock });
    // Each successive claim reflects the time already spent on prior sends
    // in the SAME pass, not the stale batch-start value.
    expect(claimTimes[0]).toBe(1000);
    expect(claimTimes[1]).toBeGreaterThan(claimTimes[0]);
    expect(claimTimes[2]).toBeGreaterThan(claimTimes[1]);
  });
});

describe('circuit breaker + jitter', () => {
  it('opens after threshold consecutive failures, closes on success', () => {
    let h = null;
    for (let i = 0; i < 5; i++) h = nextHealth(h, false, 1000, { failureThreshold: 5 });
    expect(h.state).toBe(CIRCUIT.OPEN);
    h = nextHealth(h, true, 2000);
    expect(h.state).toBe(CIRCUIT.CLOSED);
    expect(h.consecutive_failures).toBe(0);
  });

  it('backoff with jitter stays within [0.5x, 1x] of the exponential base', () => {
    for (let n = 1; n <= 6; n++) {
      const base = 1000 * Math.pow(2, n - 1);
      const j = backoffWithJitter(n, 'a1', { baseMs: 1000, factor: 2, maxMs: 1e9 });
      expect(j).toBeGreaterThanOrEqual(Math.round(base * 0.5));
      expect(j).toBeLessThanOrEqual(base);
    }
  });
});
