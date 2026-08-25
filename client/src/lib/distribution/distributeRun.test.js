// Live distribution orchestrator tests. Covers the behaviours that make the
// difference between a safe cutover and a double-sold or lost lead:
// accept stops the waterfall, reject falls through, cap reservation is released
// on failure and finalized on sale, ambiguous timeouts never report clean, and
// the wallet is only debited when the buyer actually runs on a balance.

import { describe, it, expect, beforeEach } from 'vitest';
import { runDistribution, capScopesFor, reserveAndDeliver, isLeadAlreadySold, RUN } from './distributeRun.js';
import { makeInMemoryCasStore } from './capStore.js';
import { makeInMemoryAttemptStore } from './deliveryStore.js';
import { makeInMemoryHealthStore, CIRCUIT } from './destinationHealth.js';
import { ATTEMPT_STATUS } from './deliveryAttempt.js';

const NOW = Date.parse('2026-08-12T15:00:00Z');

function member(id, over = {}) {
  return {
    id,
    buyerId: over.buyerId || `buyer-${id}`,
    active: true,
    priority: over.priority ?? 1,
    weight: 1,
    priceMode: 'fixed',
    fixedPrice: over.price ?? 50,
    price: over.price ?? 50,
    filters: {},
    conditions: null,
    caps: over.caps || {},
    buyer: { status: 'active', active: true },
    wallet: over.wallet ?? null,
    health: { state: 'closed' },
    delivery: over.delivery ?? {
      subDeliveryId: `sd-${id}`, targetUrl: `https://buyer-${id}.test/api`, method: 'POST',
      encoding: 'json', headers: {}, credentialRef: null,
      fieldMap: [{ src: 'email', dest: 'email' }],
      // requireAccept mirrors the production rule: a bare 2xx is NOT a sale unless
      // the buyer's accept pattern matches, so a polite 200 never books revenue.
      responseMapping: { accept: 'accepted', revenuePath: 'price', requireAccept: true }, timeoutMs: 5000,
    },
    subDeliveryId: `sd-${id}`,
    destinationId: null,
    ...over.raw,
  };
}

function snapshotOf(members) {
  return { groups: [{ id: 'g1', method: 'priority', active: true, orderIndex: 0, members }], configHash: 'abc123', configErrors: [] };
}

// Minimal db double: only RouteDecisionTrace is written by the orchestrator.
function makeDb() {
  const traces = [];
  return { traces, entities: { RouteDecisionTrace: { create: async (r) => { traces.push(r); return r; } } } };
}

// Scripted fetch keyed by hostname substring.
function makeFetch(script) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const key = Object.keys(script).find((k) => String(url).includes(k));
    const r = script[key];
    if (!r) throw new Error('unscripted url ' + url);
    if (r.throw) { const e = new Error(r.throw); e.name = r.name || 'Error'; throw e; }
    return { status: r.status, text: async () => r.body };
  };
  return { fetchImpl, calls };
}

function ctxFor(members, script, over = {}) {
  const { fetchImpl, calls } = makeFetch(script);
  const capStore = makeInMemoryCasStore();
  const attemptStore = makeInMemoryAttemptStore();
  return {
    calls, capStore, attemptStore,
    ctx: {
      leadId: 'lead-1', campaignId: 'camp-1', idempotencyKey: 'idem-1',
      leadData: { email: 'a@b.com', state: 'TX' }, nowMs: NOW, distributionMode: 'new_only',
      fetchImpl, snapshot: snapshotOf(members),
      stores: { capStore, attemptStore, walletStore: over.walletStore || null },
      ...over.ctx,
    },
  };
}

describe('capScopesFor', () => {
  it('produces one bucketed scope per limited window and skips unlimited ones', () => {
    const scopes = capScopesFor(member('m1', { caps: { daily: { limit: 10, count: 0 }, hourly: {}, total: { limit: 100 } } }), NOW);
    const windows = scopes.map((s) => s.window).sort();
    expect(windows).toEqual(['daily', 'total']);
    expect(scopes.find((s) => s.window === 'daily').key).toContain('route_member:m1:daily:');
    expect(scopes.find((s) => s.window === 'total').key).toBe('route_member:m1:total:all');
  });
});

describe('runDistribution', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('sells to the first accepting destination and stops', async () => {
    const members = [member('m1', { priority: 1 }), member('m2', { priority: 2 })];
    const { ctx, calls } = ctxFor(members, {
      'buyer-m1': { status: 200, body: '{"result":"accepted","price":55}' },
      'buyer-m2': { status: 200, body: '{"result":"accepted","price":40}' },
    });
    const out = await runDistribution(db, ctx);
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe('m1');
    expect(out.revenue).toBe(55);
    expect(calls.length).toBe(1); // m2 was never contacted
  });

  it('falls through to the next destination on rejection', async () => {
    const members = [member('m1', { priority: 1 }), member('m2', { priority: 2 })];
    const { ctx, calls } = ctxFor(members, {
      'buyer-m1': { status: 200, body: '{"result":"no thanks"}' },
      'buyer-m2': { status: 200, body: '{"result":"accepted","price":42}' },
    });
    const out = await runDistribution(db, ctx);
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe('m2');
    expect(calls.length).toBe(2);
  });

  it('returns no_eligible_member when every member is ineligible, and posts nothing', async () => {
    const m = member('m1');
    m.buyer = { status: 'paused', active: false };
    const { ctx, calls } = ctxFor([m], {});
    const out = await runDistribution(db, ctx);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(calls.length).toBe(0);
  });

  it('holds cap on a sale and releases it on a rejection', async () => {
    const caps = { daily: { limit: 1, count: 0 } };
    const sold = ctxFor([member('m1', { caps })], { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":10}' } });
    await runDistribution(db, sold.ctx);
    const soldKey = capScopesFor(member('m1', { caps }), NOW)[0].key;
    expect(await sold.capStore.getCount(soldKey)).toBe(1); // consumed

    const rejected = ctxFor([member('m2', { caps })], { 'buyer-m2': { status: 200, body: '{"result":"nope"}' } });
    await runDistribution(db, rejected.ctx);
    const rejKey = capScopesFor(member('m2', { caps }), NOW)[0].key;
    expect(await rejected.capStore.getCount(rejKey)).toBe(0); // given back
  });

  it('maxAttemptsPerDest > 1: an in-run retry of the SAME destination reserves cap correctly and finalizes exactly once', async () => {
    // Regression: reservation.js's claim key used to be keyed only on
    // (idempotencyKey, memberId) with no attempt number, so attempt 1's
    // claim (won, then released on the transient 500) permanently occupied
    // that key - attempt 2's own reserve() call would see ALREADY_RESERVED
    // and be rejected without ever posting, even though maxAttemptsPerDest
    // explicitly permits retrying the same destination.
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return { status: 500, text: async () => 'boom' };
      return { status: 200, text: async () => '{"result":"accepted","price":10}' };
    };
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const m = member('m1', { caps: { daily: { limit: 5, count: 0 } } });
    const ctx = {
      leadId: 'lead-1', campaignId: 'camp-1', idempotencyKey: 'idem-1',
      leadData: { email: 'a@b.com', state: 'TX' }, nowMs: NOW, distributionMode: 'new_only',
      fetchImpl, snapshot: snapshotOf([m]),
      stores: { capStore, attemptStore, walletStore: null },
      maxAttemptsPerDest: 2,
    };
    const out = await runDistribution(db, ctx);
    expect(calls).toBe(2); // attempt 1 failed, attempt 2 (same destination) was actually sent
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe('m1');
    const capKey = capScopesFor(m, NOW)[0].key;
    expect(await capStore.getCount(capKey)).toBe(1); // finalized exactly once, not double-consumed
  });

  it('skips a destination whose cap is already exhausted', async () => {
    const caps = { daily: { limit: 1, count: 0 } };
    const { ctx, capStore, calls } = ctxFor(
      [member('m1', { caps, priority: 1 }), member('m2', { priority: 2 })],
      { 'buyer-m2': { status: 200, body: '{"result":"accepted","price":9}' } },
    );
    await capStore.incrementIfBelow(capScopesFor(member('m1', { caps }), NOW)[0].key, 1); // fill it
    const out = await runDistribution(db, ctx);
    expect(out.winnerMemberId).toBe('m2');
    expect(calls.some((u) => String(u).includes('buyer-m1'))).toBe(false);
  });

  it('reports a timeout as ambiguous, never as a clean failure', async () => {
    const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { throw: 'aborted', name: 'AbortError' } });
    const out = await runDistribution(db, ctx);
    expect(out.status).toBe(RUN.AMBIGUOUS);
  });

  it('debits the wallet only for a balance-run buyer, and never for an invoiced one', async () => {
    const debits = [];
    const walletStore = {
      claimTxn: async () => true,
      getBalance: async () => ({ balance: 1000, version: 0 }),
      casAdjustBalance: async () => true,
      appendTxn: async (t) => { debits.push(t); return { ...t, id: 't1' }; },
      awaitTxnByKey: async () => null,
    };
    const prepaid = ctxFor([member('m1', { wallet: { mode: 'prepaid', balance: 1000, minBalance: 0 } })],
      { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":50}' } }, { walletStore });
    await runDistribution(db, prepaid.ctx);
    expect(debits.length).toBe(1);
    expect(debits[0].amount).toBe(50);

    debits.length = 0;
    const invoiced = ctxFor([member('m2', { wallet: { mode: 'postpaid', outstanding: 0, creditLimit: null } })],
      { 'buyer-m2': { status: 200, body: '{"result":"accepted","price":50}' } }, { walletStore });
    await runDistribution(db, invoiced.ctx);
    expect(debits.length).toBe(0); // invoiced buyers are billed downstream, never gated here
  });

  it('writes exactly one decision trace carrying the winner and the candidate list', async () => {
    const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":25}' } });
    await runDistribution(db, ctx);
    expect(db.traces.length).toBe(1);
    expect(db.traces[0].result).toBe(RUN.ACCEPTED);
    expect(db.traces[0].winner_member_id).toBe('m1');
    expect(JSON.parse(db.traces[0].evaluated_candidates)).toHaveLength(1);
  });

  it('never throws and never reports delivered when the snapshot load fails', async () => {
    const brokenDb = makeDb();
    const out = await runDistribution(brokenDb, {
      leadId: 'lead-9', campaignId: 'c', idempotencyKey: 'k', leadData: {}, nowMs: NOW,
      distributionMode: 'new_only',
      snapshot: null,
    });
    expect(out.ran).toBe(false);
    expect([RUN.ERROR_CLEAN, RUN.NO_ELIGIBLE]).toContain(out.status);
  });

  // Stage 3: circuit breaker write-side wiring. distributeRun.js records every
  // real outcome so a persistently failing destination opens, and (per
  // engine.js/snapshot.js's cooldown-aware read side) can recover.
  describe('circuit breaker bookkeeping', () => {
    it('records a real ACCEPTED outcome as a success, keyed by sub_delivery_id', async () => {
      const healthStore = makeInMemoryHealthStore();
      const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":25}' } }, { ctx: { healthStore } });
      await runDistribution(db, ctx);
      const h = await healthStore.get({ subDeliveryId: 'sd-m1' });
      expect(h.state).toBe(CIRCUIT.CLOSED);
      expect(h.consecutive_failures).toBe(0);
    });

    it('records a real failure and opens the circuit at the failure threshold', async () => {
      const healthStore = makeInMemoryHealthStore();
      for (let i = 0; i < 5; i++) {
        const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 500, body: 'boom' } }, {
          ctx: { healthStore, healthOpts: { failureThreshold: 5, cooldownMs: 60000 }, idempotencyKey: `idem-${i}` },
        });
        await runDistribution(db, ctx);
      }
      const h = await healthStore.get({ subDeliveryId: 'sd-m1' });
      expect(h.state).toBe(CIRCUIT.OPEN);
      expect(h.consecutive_failures).toBe(5);
      expect(h.disabled_until).toBeTruthy();
    });

    it('a rejection (destination reachable, business decision) does not count as an ACCEPTED success but is still recorded', async () => {
      const healthStore = makeInMemoryHealthStore();
      const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 200, body: '{"result":"no thanks"}' } }, { ctx: { healthStore } });
      await runDistribution(db, ctx);
      const h = await healthStore.get({ subDeliveryId: 'sd-m1' });
      expect(h).not.toBe(null);
      expect(h.consecutive_failures).toBe(1); // matches the retry worker's own ACCEPTED-only success definition
    });

    it('health bookkeeping failure never breaks the delivery itself', async () => {
      const throwingStore = { recordResult: async () => { throw new Error('boom'); } };
      const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":25}' } }, { ctx: { healthStore: throwingStore } });
      const out = await runDistribution(db, ctx);
      expect(out.status).toBe(RUN.ACCEPTED);
    });

    it('defaults to a real health store when none is injected, without throwing even if the entity is unavailable', async () => {
      // db here (makeDb()) has no entities.DestinationHealth at all; the
      // default makeEntityHealthStore(db) must fail closed (best-effort),
      // never break the sale.
      const { ctx } = ctxFor([member('m1')], { 'buyer-m1': { status: 200, body: '{"result":"accepted","price":25}' } });
      const out = await runDistribution(db, ctx);
      expect(out.status).toBe(RUN.ACCEPTED);
    });
  });
});

// reserveAndDeliver is the shared primitive the async native retry worker
// (server/src/lib/nativeRetryRunner.js) calls too, so a retried send is
// governed by the identical cap/wallet/winner rules as a primary send. These
// tests exercise it directly to prove the cross-destination double-sale
// protections that only matter once two SEPARATE destinations (as opposed to
// one destination's own in-run waterfall, already covered above) can both
// reach an ACCEPTED outcome for the same lead - exactly the shape of an
// async retry racing a different destination's own eventual sale.
describe('reserveAndDeliver: cross-destination double-sale protection', () => {
  function ctxWith(fetchImpl, over = {}) {
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    return {
      capStore, attemptStore,
      stores: { attemptStore, capStore, walletStore: null },
      ctx: { leadId: 'lead-X', idempotencyKey: 'idem-X', leadData: { email: 'a@b.com' }, nowMs: NOW, fetchImpl, ...over },
    };
  }

  it('A fails, B accepts and wins; A later becomes retry-due and MUST NOT SEND', async () => {
    const { fetchImpl, calls } = makeFetch({
      'buyer-mB': { status: 200, body: '{"result":"accepted","price":40}' },
    });
    const { stores, ctx } = ctxWith(fetchImpl);

    const winB = await reserveAndDeliver({ member: member('mB'), meta: { attemptNumber: 1, trigger: 'primary' }, stores, ctx });
    expect(winB.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(winB.wonLead).toBe(true);

    expect(await isLeadAlreadySold(stores.capStore, 'lead-X')).toBe(true);

    // A's async retry fires later, for a DIFFERENT member/destination.
    const retryA = await reserveAndDeliver({ member: member('mA'), meta: { attemptNumber: 2, trigger: 'retry' }, stores, ctx });
    // SUPERSEDED, not REJECTED: a plain REJECTED is fallback-eligible
    // (shouldFallback/processLead.js treat it as a safe clean miss), and
    // "another destination already sold this lead" must never be.
    expect(retryA.status).toBe(ATTEMPT_STATUS.SUPERSEDED);
    expect(retryA.reason).toBe('LEAD_ALREADY_SOLD');
    // Only B was ever actually contacted; A's retry never sent.
    expect(calls.length).toBe(1);
    expect(calls.some((u) => String(u).includes('buyer-mA'))).toBe(false);
  });

  it('concurrent winner race: exactly one of two simultaneous accepts becomes the real winner', async () => {
    const { fetchImpl } = makeFetch({
      'buyer-mA': { status: 200, body: '{"result":"accepted","price":40}' },
      'buyer-mB': { status: 200, body: '{"result":"accepted","price":40}' },
    });
    const { stores, ctx } = ctxWith(fetchImpl);

    const [outA, outB] = await Promise.all([
      reserveAndDeliver({ member: member('mA'), meta: { attemptNumber: 1, trigger: 'retry' }, stores, ctx }),
      reserveAndDeliver({ member: member('mB'), meta: { attemptNumber: 1, trigger: 'retry' }, stores, ctx }),
    ]);

    const winners = [outA, outB].filter((o) => o.wonLead === true);
    const superseded = [outA, outB].filter((o) => o.status === ATTEMPT_STATUS.SUPERSEDED);
    expect(winners).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    // Both destinations genuinely said accepted at the HTTP level; only one
    // carries real business effect.
    expect(superseded[0].balanceDecision).toBe('superseded_duplicate_sale');
  });

  it('a retry accepted as the sole winner still finalizes cap and debits the wallet exactly once', async () => {
    const { fetchImpl } = makeFetch({ 'buyer-mA': { status: 200, body: '{"result":"accepted","price":40}' } });
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const debits = [];
    const walletStore = {
      claimTxn: async () => true,
      getBalance: async () => ({ balance: 1000, version: 0 }),
      casAdjustBalance: async () => true,
      appendTxn: async (t) => { debits.push(t); return { ...t, id: 't1' }; },
      awaitTxnByKey: async () => null,
    };
    const caps = { daily: { limit: 5, count: 0 } };
    const m = member('mA', { price: 40, wallet: { mode: 'prepaid', balance: 1000, minBalance: 0 }, caps });
    const out = await reserveAndDeliver({
      member: m, meta: { attemptNumber: 3, trigger: 'retry' },
      stores: { attemptStore, capStore, walletStore },
      ctx: { leadId: 'lead-Y', idempotencyKey: 'idem-Y', leadData: {}, nowMs: NOW, fetchImpl },
    });
    expect(out.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(40);
    const capKey = capScopesFor(m, NOW)[0].key;
    expect(await capStore.getCount(capKey)).toBe(1); // finalized once, not double-consumed
  });

  it('attempt-numbered reservation: a same-destination retry is not rejected merely because an earlier attempt already held (and released) the slot', async () => {
    const { fetchImpl } = makeFetch({ 'buyer-mA': { status: 500, body: 'boom' } });
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const stores = { attemptStore, capStore, walletStore: null };
    const ctx = { leadId: 'lead-Z', idempotencyKey: 'idem-Z', leadData: {}, nowMs: NOW, fetchImpl };
    const m = member('mA', { caps: { daily: { limit: 5, count: 0 } } });

    const attempt1 = await reserveAndDeliver({ member: m, meta: { attemptNumber: 1, trigger: 'primary' }, stores, ctx });
    expect(attempt1.status).toBe(ATTEMPT_STATUS.ERROR); // reserved, sent, released on the 500

    const attempt2 = await reserveAndDeliver({ member: m, meta: { attemptNumber: 2, trigger: 'retry' }, stores, ctx });
    // Must reach a real send outcome (ERROR from the same scripted 500), not
    // be short-circuited as ALREADY_RESERVED by attempt 1's own claim key.
    expect(attempt2.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(attempt2.reason).not.toBe('ALREADY_RESERVED');
  });
});

// Regression (found by adversarial review): a whole runDistribution() run
// whose only real attempt comes back SUPERSEDED (this destination genuinely
// accepted, but lost the cross-run winner claim to a concurrent duplicate
// submission that already sold the same lead) must NEVER report a
// fallback-eligible clean outcome - the caller (processLead.js) reads
// RUN.AMBIGUOUS/RUN.ACCEPTED/RUN.DUPLICATE as "never re-send through legacy"
// and everything else as fair game, so this run's overall status is exactly
// what decides whether the lead gets sold a second time through the legacy
// relay. The first version of this fix classified the pre-send "already
// sold" guard as REJECTED (a status legacy fallback DOES treat as safe),
// which silently reintroduced the double-sale the whole change exists to
// close.
describe('runDistribution: a run superseded by a concurrent winner never reports a fallback-eligible outcome', () => {
  it('reports AMBIGUOUS, not REJECTED/ERROR_CLEAN, when this run\'s only candidate is superseded', async () => {
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    // Simulate a concurrent duplicate submission of the same lead that has
    // already won the lead-level claim before this run's own candidate ever
    // gets to send.
    await capStore.claim('winner:lead-1');

    const { fetchImpl, calls } = makeFetch({ 'buyer-m1': { status: 200, body: '{"result":"accepted","price":25}' } });
    const ctx = {
      leadId: 'lead-1', campaignId: 'camp-1', idempotencyKey: 'idem-1',
      leadData: { email: 'a@b.com', state: 'TX' }, nowMs: NOW, distributionMode: 'new_only',
      fetchImpl, snapshot: snapshotOf([member('m1')]),
      stores: { capStore, attemptStore, walletStore: null },
    };
    const out = await runDistribution(makeDb(), ctx);
    expect(out.status).toBe(RUN.AMBIGUOUS);
    expect(out.status).not.toBe(RUN.REJECTED);
    expect(out.status).not.toBe(RUN.ERROR_CLEAN);
    expect(calls.length).toBe(0); // never sent - caught by the pre-send guard
  });
});
