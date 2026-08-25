// Retry worker. Claims due delivery attempts with an atomic CAS lease so two
// concurrent workers never send the same attempt, re-delivers via the injected
// deliverFn, applies bounded backoff with jitter, promotes to dead-letter at the
// attempt cap, and updates the destination circuit breaker. Also exposes a manual
// (operator-authorized) retry entry point. Pure of ambient time and randomness:
// nowMs and rng are injected.

import { computeBackoffMs, ATTEMPT_STATUS } from './deliveryAttempt.js';

// Deterministic default jitter derived from the attempt id, so tests are stable.
function seededUnit(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 1000) / 1000;
}

// Full-jitter within [0.5x, 1.0x] of the exponential backoff, capped at maxMs.
export function backoffWithJitter(attemptNumber, seed, opts = {}) {
  const base = computeBackoffMs(attemptNumber, opts);
  const u = opts.rng ? opts.rng() : seededUnit(`${seed}:${attemptNumber}`);
  return Math.min(opts.maxMs ?? 3600000, Math.round(base * (0.5 + 0.5 * u)));
}

// Default lease duration. Kept comfortably larger than the hard maximum any
// single send can take (deliveryResolve.js clamps SubDelivery.timeout_ms to
// MAX_SEND_TIMEOUT_MS, well under this), so a lease can never legitimately
// expire while a send from the SAME worker is still in flight - the actual
// double-send risk a shorter lease created. See deliveryResolve.js for the
// paired timeout clamp.
const DEFAULT_LEASE_MS = 90000;

// Process one worker pass over the due queue. deliverFn(attempt) -> { status,
// retryable } re-sends using the stored attempt (the caller wires directPost).
// ctx.isLeadSold(leadId) -> Promise<boolean>, when supplied, is checked for
// every due attempt BEFORE deliverFn is ever called: if a different
// destination already won this lead (a prior tick's retry, or the original
// primary run's own eventual winner), this attempt is terminalized without
// ever sending its PII again. This is the belt to reserveAndDeliver's own
// braces (distributeRun.js's per-lead winner claim, which the injected
// deliverFn reaches on the real send path): a genuine two-attempt-at-once
// race is still resolved correctly there even when this pre-check is beaten
// by timing, but the common case never sends at all.
//
// ctx.now(), when supplied, is called fresh before EVERY claim/lease and
// again after every send, instead of reusing the single ctx.nowMs read at
// the top of the pass for the whole batch. This closes a real margin-erosion
// bug: listDue's batch can hold up to 100 attempts, processed strictly
// sequentially, and each send can legitimately take up to
// MAX_SEND_TIMEOUT_MS (deliveryResolve.js). Anchoring every lease_until to a
// stale batch-start timestamp shrinks the DEFAULT_LEASE_MS safety margin by
// however much processing already happened earlier in the SAME pass, and
// can make a later attempt's lease already appear expired to a CONCURRENT
// worker the moment it is claimed - reopening the exact "lease expires
// while a send is still in flight" double-send risk the margin exists to
// close, precisely when a backlog makes it matter most. Tests omit ctx.now
// and get the prior deterministic behavior (every lease anchored to the one
// injected nowMs) unchanged; nativeRetryRunner.js's real caller supplies
// `now: () => Date.now()`.
export async function runRetryWorker(store, deliverFn, ctx) {
  const { nowMs, workerId, leaseMs = DEFAULT_LEASE_MS, healthStore, maxAttempts = 5, retryOpts = {}, isLeadSold, now } = ctx;
  const clock = typeof now === 'function' ? now : () => nowMs;
  const due = await store.listDue(nowMs);
  const processed = [];
  for (const a of due) {
    const claimNowMs = clock();
    const won = await store.claimLease(a.id, workerId, claimNowMs, leaseMs, 'error');
    if (!won) continue; // another worker owns this attempt, or it was already settled

    if (typeof isLeadSold === 'function' && await isLeadSold(a.lead_id)) {
      await store.updateAttempt(a.id, { status: ATTEMPT_STATUS.SUPERSEDED, next_retry_at: null, lease_until: null });
      processed.push({ id: a.id, worker: workerId, status: ATTEMPT_STATUS.SUPERSEDED });
      continue;
    }

    const nextAttemptNum = (a.attempt_number || 1) + 1;
    const res = await deliverFn({ ...a, attempt_number: nextAttemptNum });
    const success = res.status === ATTEMPT_STATUS.ACCEPTED;
    const settleNowMs = clock();
    if (healthStore) {
      await healthStore.recordResult(
        { subDeliveryId: a.sub_delivery_id || null, destinationId: a.destination_id || null },
        success, settleNowMs, ctx.healthOpts,
      );
    }

    if (success || res.status === ATTEMPT_STATUS.REJECTED || res.status === ATTEMPT_STATUS.DUPLICATE
      || res.status === ATTEMPT_STATUS.SUPERSEDED) {
      await store.updateAttempt(a.id, { status: res.status, next_retry_at: null, lease_until: null, attempt_number: nextAttemptNum });
    } else if (nextAttemptNum >= maxAttempts || res.retryable === false) {
      // res.retryable === false is an EXPLICIT, attempt-count-independent
      // permanent signal (missing/disabled destination, invalid target url,
      // invalid payload template - see directPost.js's failClosed and
      // nativeRetryRunner.js's own destination-liveness check). Dead-letter
      // immediately rather than burning the full backoff schedule against a
      // failure no amount of waiting will fix.
      await store.updateAttempt(a.id, { status: ATTEMPT_STATUS.DEAD_LETTER, next_retry_at: null, lease_until: null, attempt_number: nextAttemptNum });
    } else {
      const delay = backoffWithJitter(nextAttemptNum, a.id, retryOpts);
      await store.updateAttempt(a.id, {
        status: ATTEMPT_STATUS.ERROR, attempt_number: nextAttemptNum,
        next_retry_at: new Date(settleNowMs + delay).toISOString(), lease_until: null,
      });
    }
    processed.push({ id: a.id, worker: workerId, status: res.status });
  }
  return processed;
}

// Operator-authorized manual retry of a single attempt. Authorization is enforced
// by the calling backend function; this only performs the send + bookkeeping.
export async function manualRetry(store, attemptId, deliverFn, ctx) {
  const a = await store.getAttempt(attemptId);
  if (!a) return { ok: false, reason: 'not_found' };
  const won = await store.claimLease(attemptId, ctx.workerId || 'manual', ctx.nowMs, ctx.leaseMs || DEFAULT_LEASE_MS);
  if (!won) return { ok: false, reason: 'leased' };

  if (typeof ctx.isLeadSold === 'function' && await ctx.isLeadSold(a.lead_id)) {
    await store.updateAttempt(attemptId, { status: ATTEMPT_STATUS.SUPERSEDED, next_retry_at: null, lease_until: null });
    return { ok: true, status: ATTEMPT_STATUS.SUPERSEDED };
  }

  const nextAttemptNum = (a.attempt_number || 1) + 1;
  const res = await deliverFn({ ...a, attempt_number: nextAttemptNum });
  await store.updateAttempt(attemptId, {
    status: res.status, lease_until: null, attempt_number: nextAttemptNum,
    next_retry_at: res.status === ATTEMPT_STATUS.ERROR ? new Date(ctx.nowMs).toISOString() : null,
  });
  if (ctx.healthStore) {
    await ctx.healthStore.recordResult(
      { subDeliveryId: a.sub_delivery_id || null, destinationId: a.destination_id || null },
      res.status === ATTEMPT_STATUS.ACCEPTED, ctx.nowMs, ctx.healthOpts,
    );
  }
  return { ok: true, status: res.status };
}
