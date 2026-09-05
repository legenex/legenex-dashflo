// W6-FIXTURES: thirteen named, synthetic lead fixtures run through the REAL
// eligibility/delivery-mock path, each asserting its exact lead_status and
// reason code, plus verification of the two adversarial HTTP delivery modes
// (200-with-unmatched-body, accept-then-drop-connection).
//
// Every fixture runs through runDistribution/distributeLead/evaluateMember
// from the SAME generated engine bundle production imports
// (server/src/functions/routingEngine.generated.js) - nothing here is hand-
// computed or mocked out at the reason-code layer. Delivery-outcome fixtures
// talk to a real local loopback HTTP server (node:http), the same pattern
// already used in client/src/lib/distribution/directPost.test.js and
// server/test/campaignDeliveryTest.test.js, so classifyResponse and the
// timeout/connection-reset paths run against a genuine socket, not a scripted
// stand-in function.
//
// engine.js and processLead.js are both read-only reference for this work
// unit (see AGENTS.md/forge-pack WORK-UNITS.yaml W6-FIXTURES) - this file
// never edits either, and never calls processLead.js directly (it is a large
// integration surface with no existing test harness; each fixture instead
// documents, with exact processLead.js line citations, what the current code
// does with the real engine-level outcome asserted here).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import * as engine from '../src/functions/routingEngine.generated.js';
import { makeTraceDb } from './fixtures/_helpers.js';

import { fixture as cleanAccept } from './fixtures/01-clean-accept.js';
import { fixture as cascadeTieredPrice } from './fixtures/02-cascade-tiered-price.js';
import { fixture as geoExcluded } from './fixtures/03-geo-excluded.js';
import { fixture as allCapped } from './fixtures/04-all-capped.js';
import { fixture as scheduleClosed, NOW_MS as SCHEDULE_NOW_MS } from './fixtures/05-schedule-closed.js';
import { fixture as allBuyersRejected } from './fixtures/06-all-buyers-rejected.js';
import { fixture as criteriaDq } from './fixtures/07-criteria-dq.js';
import { fixture as duplicateFixture } from './fixtures/08-duplicate.js';
import { fixture as missingRequired } from './fixtures/09-missing-required.js';
import { fixture as dncSuppressed } from './fixtures/10-dnc-suppressed.js';
import { fixture as wcAccept } from './fixtures/11-wc-accept.js';
import { fixture as wcStateInactive } from './fixtures/12-wc-state-inactive.js';
import { fixture as ambiguousTimeout } from './fixtures/13-ambiguous-timeout.js';

const {
  REASON, ATTEMPT_STATUS, RUN, classifyResponse, toClassifyResponseMapping,
  shouldFallback, isWithinSchedule, missingRequiredFields, runDistribution,
  makeInMemoryCasStore, makeInMemoryAttemptStore,
} = engine;

const NOW = Date.parse('2026-08-12T15:00:00Z');

const ALL_FIXTURES = [
  cleanAccept, cascadeTieredPrice, geoExcluded, allCapped, scheduleClosed,
  allBuyersRejected, criteriaDq, duplicateFixture, missingRequired,
  dncSuppressed, wcAccept, wcStateInactive, ambiguousTimeout,
];

// ── Local mock destination server, shared across every fixture ─────────────
// A real socket on loopback. No fixture, and no test in this file, ever
// contacts a real buyer or an external host.
let server; let base;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = url.pathname;
      const price = url.searchParams.get('price');
      const bid = url.searchParams.get('bid') || 'BYR-X';
      if (path === '/accept') {
        return json(res, 200, { result: 'accepted', price: price != null ? Number(price) : 0, buyer_lead_id: bid });
      }
      if (path === '/reject') {
        return json(res, 200, { result: 'declined', reason: 'not interested' });
      }
      if (path === '/duplicate') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ result: 'duplicate' }));
      }
      // A well-formed, real JSON 200 body that matches NEITHER the accept
      // pattern ("accepted") nor the reject pattern ("declined") configured
      // below - the exact false-positive shape documented in docs/STATE.md's
      // real Walker incident (HTTP 200, {"response":{"errors":...}}, no
      // response_mapping configured, classified accepted by the "any 2xx is
      // accepted" fallback).
      if (path === '/unmatched') {
        return json(res, 200, { status: 'processing', ticket_id: 'TCK-4471' });
      }
      // Accepts the connection, writes a partial body, then drops the socket
      // without ever completing the response - never responds at all.
      if (path === '/drop') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"resu');
        return req.socket.destroy();
      }
      if (path === '/hang') {
        return; // never respond; the client's own AbortController times out
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Runs one fixture through the real orchestrator (runDistribution ->
// distributeLead -> evaluateMember/deliverDirectPost/classifyResponse),
// counting real HTTP calls via a thin wrapper around the real fetch.
async function runFixture(fixtureDef, { nowMs = NOW } = {}) {
  const withinSchedule = fixtureDef.schedule
    ? isWithinSchedule(fixtureDef.nowMs ?? nowMs, fixtureDef.schedule)
    : undefined;
  const built = fixtureDef.build(base, withinSchedule);
  const db = makeTraceDb();
  const capStore = makeInMemoryCasStore();
  const attemptStore = makeInMemoryAttemptStore();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    return globalThis.fetch(url, opts);
  };
  const ctx = {
    leadId: `lead_${fixtureDef.id}`, campaignId: 'camp_fixture_outcomes',
    idempotencyKey: `idem_${fixtureDef.id}`,
    leadData: fixtureDef.lead, nowMs: fixtureDef.nowMs ?? nowMs,
    distributionMode: 'new_only', fetchImpl, testMode: true, allowlistHosts: ['127.0.0.1'],
    snapshot: { groups: built.groups, configHash: 'fixture', configErrors: [] },
    stores: { capStore, attemptStore, walletStore: null },
    healthStore: null,
  };
  const out = await runDistribution(db, ctx);
  return { out, calls, db };
}

// ── Meta-guard: every expected value used below is a REAL, current value of
// REASON / ATTEMPT_STATUS / RUN, never an invented one. This is the
// mechanical form of "recount them carefully against the actual eligibility
// engine's REASON codes" - a fixture whose expected code is a typo or a
// value the engine no longer exports fails here immediately, loudly, before
// any behavioral assertion below could be blamed instead. ────────────────
describe('fixture expectations reference only real, current engine codes', () => {
  const runValues = new Set(Object.values(RUN));
  const reasonValues = new Set(Object.values(REASON));
  const attemptValues = new Set(Object.values(ATTEMPT_STATUS));

  it('every fixture reasonCode is a real REASON or ATTEMPT_STATUS value', () => {
    for (const f of ALL_FIXTURES) {
      const rc = f.expected.reasonCode;
      if (rc === undefined) continue;
      expect(reasonValues.has(rc) || attemptValues.has(rc), `${f.id}: "${rc}" is not a real REASON/ATTEMPT_STATUS value`).toBe(true);
    }
  });
  it('every fixture runStatus is a real RUN value', () => {
    for (const f of ALL_FIXTURES) {
      expect(runValues.has(f.expected.runStatus), `${f.id}: "${f.expected.runStatus}" is not a real RUN value`).toBe(true);
    }
  });
  it('every fixture attemptStatuses entry is a real ATTEMPT_STATUS value', () => {
    for (const f of ALL_FIXTURES) {
      for (const s of f.expected.attemptStatuses || []) {
        expect(attemptValues.has(s), `${f.id}: "${s}" is not a real ATTEMPT_STATUS value`).toBe(true);
      }
    }
  });
  it('all thirteen fixture ids are distinct', () => {
    expect(new Set(ALL_FIXTURES.map((f) => f.id)).size).toBe(13);
    expect(ALL_FIXTURES).toHaveLength(13);
  });
});

// ── The thirteen fixtures ───────────────────────────────────────────────
describe('W6-FIXTURES: thirteen adversarial lead scenarios', () => {
  it('1. clean accept', async () => {
    const { out, calls } = await runFixture(cleanAccept);
    const exp = cleanAccept.expected;
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe(exp.winnerMemberId);
    expect(out.revenue).toBe(exp.revenue);
    expect(out.result.attempts.at(-1).status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(calls).toHaveLength(exp.callCount);
  });

  it('2. cascade + tiered price (first destination rejects, second accepts at a different price)', async () => {
    const { out, calls } = await runFixture(cascadeTieredPrice);
    const exp = cascadeTieredPrice.expected;
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe(exp.winnerMemberId);
    expect(out.revenue).toBe(exp.revenue);
    expect(out.result.attempts.map((a) => a.status)).toEqual([ATTEMPT_STATUS.REJECTED, ATTEMPT_STATUS.ACCEPTED]);
    expect(calls).toHaveLength(exp.callCount); // proves the cascade genuinely happened
  });

  it('3. geo excluded (FILTER_ZIP)', async () => {
    const { out, calls } = await runFixture(geoExcluded);
    const exp = geoExcluded.expected;
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates.every((c) => c.reason === REASON.FILTER_ZIP)).toBe(true);
    expect(calls).toHaveLength(exp.callCount);
  });

  it('4. all capped (every eligible destination is at its cap)', async () => {
    const { out, calls } = await runFixture(allCapped);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates).toHaveLength(2);
    expect(out.result.candidates.every((c) => c.reason === REASON.CAP_DAILY)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('5. schedule closed (outside the buyer\'s operating window)', async () => {
    // Exercise the real isWithinSchedule resolver directly too, not only
    // through the fixture runner, to pin the fixture's own premise.
    expect(isWithinSchedule(SCHEDULE_NOW_MS, scheduleClosed.schedule)).toBe(false);
    const { out, calls } = await runFixture(scheduleClosed);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates[0].reason).toBe(REASON.OUTSIDE_SCHEDULE);
    expect(calls).toHaveLength(0);
  });

  it('6. all buyers rejected (contacted, both decline)', async () => {
    const { out, calls } = await runFixture(allBuyersRejected);
    expect(out.status).toBe(RUN.REJECTED);
    expect(out.result.attempts.map((a) => a.status)).toEqual([ATTEMPT_STATUS.REJECTED, ATTEMPT_STATUS.REJECTED]);
    expect(calls).toHaveLength(2);
    expect(shouldFallback(out.status)).toBe(true); // real function: rejected IS fallback-eligible
  });

  it('7. criteria disqualification (DQ) via the native condition tree', async () => {
    const { out, calls } = await runFixture(criteriaDq);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates[0].reason).toBe(REASON.QUALIFICATION_FAILED);
    expect(calls).toHaveLength(0);
  });

  it('8. duplicate (HTTP 409; a second, lower-priority buyer must never be contacted)', async () => {
    const { out, calls } = await runFixture(duplicateFixture);
    const exp = duplicateFixture.expected;
    expect(out.status).toBe(RUN.DUPLICATE);
    expect(out.winnerMemberId).toBe(exp.winnerMemberId);
    expect(out.result.attempts).toHaveLength(1);
    expect(out.result.attempts[0].status).toBe(ATTEMPT_STATUS.DUPLICATE);
    expect(calls).toHaveLength(exp.callCount);
  });

  it('9. missing required field (one field present, the other absent)', () => {
    // Exercise the real, exported pure function directly, in addition to the
    // full-run assertion below.
    expect(missingRequiredFields(missingRequired.lead, missingRequired.requiredFields)).toEqual(['date_of_birth']);
  });
  it('9b. missing required field, run through the full eligibility path', async () => {
    const { out, calls } = await runFixture(missingRequired);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates[0].reason).toBe(REASON.MISSING_REQUIRED_FIELDS);
    expect(calls).toHaveLength(0);
  });

  it('10. DNC suppressed (canonical mobile field, not the legacy phone alias)', async () => {
    const { out, calls } = await runFixture(dncSuppressed);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates[0].reason).toBe(REASON.SUPPRESSED);
    expect(calls).toHaveLength(0); // never contacted
  });

  it('11. WC accept (Workers Comp vertical, distinct fields from MVA)', async () => {
    const { out, calls } = await runFixture(wcAccept);
    const exp = wcAccept.expected;
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe(exp.winnerMemberId);
    expect(out.revenue).toBe(exp.revenue);
    expect(calls).toHaveLength(exp.callCount);
  });

  it('12. WC state inactive (buyer lifecycle status, not a geographic filter)', async () => {
    const { out, calls } = await runFixture(wcStateInactive);
    expect(out.status).toBe(RUN.NO_ELIGIBLE);
    expect(out.result.candidates[0].reason).toBe(REASON.BUYER_LIFECYCLE_INELIGIBLE);
    expect(calls).toHaveLength(0);
  });

  it('13. ambiguous timeout: routing stops, no cascade, no legacy fallback', async () => {
    const { out, calls } = await runFixture(ambiguousTimeout);
    const exp = ambiguousTimeout.expected;
    expect(out.result.attempts).toHaveLength(1);
    expect(out.result.attempts[0].status).toBe(ATTEMPT_STATUS.ERROR);
    expect(out.result.attempts[0].error_class).toBe(exp.errorClass);
    // The core safety assertion: the run resolves AMBIGUOUS, not a clean miss.
    expect(out.status).toBe(RUN.AMBIGUOUS);
    // No cascade: exactly the one configured destination was ever contacted.
    expect(calls).toHaveLength(exp.callCount);
    // No legacy fallback: the real modeControl function, not a hand-computed
    // boolean, says an ambiguous native result may never trigger a second
    // (legacy) send attempt at this lead.
    expect(shouldFallback(out.status)).toBe(exp.shouldFallback);
  });
});

// ── Adversarial mock-delivery HTTP coverage ─────────────────────────────
// Verifies what already existed vs what this work unit adds, for the two
// named adversarial behaviors.
describe('adversarial delivery classification: 200-with-unmatched-body', () => {
  // Already covered before this work unit, at the single-attempt level:
  // client/src/lib/distribution/directPost.test.js's "invalid/malformed
  // response body handled without crashing" test posts to a body that also
  // does not match any accept/reject pattern, though it never asserts the
  // resulting status. No existing test anywhere in the suite named or
  // asserted the classification of a WELL-FORMED 200 JSON body that matches
  // neither pattern - this is the gap this work unit adds coverage for.
  it('with requireAccept configured, an unmatched 200 body is REJECTED, never falsely ACCEPTED', () => {
    const mapping = toClassifyResponseMapping({ accepted: 'accepted', rejected: 'declined', require_accept: true });
    const status = classifyResponse({ httpStatus: 200, body: JSON.stringify({ status: 'processing', ticket_id: 'TCK-4471' }), mapping });
    expect(status).toBe(ATTEMPT_STATUS.REJECTED);
  });

  // KNOWN GAP, verified by direct execution against the real code (not
  // fixed here - client/src/lib/distribution/deliveryAttempt.js is outside
  // this work unit's file ownership, server/test/fixtures/** and
  // server/test/fixtureOutcomes.test.js only):
  //
  // classifyResponse has NO status between accepted and rejected for a 2xx
  // response. Without requireAccept configured (the common case - it is not
  // mandatory today), the SAME unmatched 200 body is classified ACCEPTED,
  // exactly the real historical Walker false positive recorded in
  // docs/STATE.md ("Real observed response: HTTP 200, {'response':
  // {'errors':...}}" classified accepted by the "any 2xx is accepted"
  // fallback). This is pinned below as a documented, currently-true gap, not
  // as desired behavior: a destination this misclassifies is never routed to
  // any "needs review" state, and a lead that should have been queued for a
  // human is instead recorded as sold. Recommended follow-up: make
  // requireAccept mandatory (or default true) and/or add a genuine
  // "needs_review" ATTEMPT_STATUS value distinct from both accepted and
  // rejected for this exact shape.
  it('KNOWN GAP: without requireAccept, the SAME unmatched 200 body is misclassified ACCEPTED', () => {
    const mapping = toClassifyResponseMapping({ accepted: 'accepted', rejected: 'declined' });
    const status = classifyResponse({ httpStatus: 200, body: JSON.stringify({ status: 'processing', ticket_id: 'TCK-4471' }), mapping });
    expect(status).toBe(ATTEMPT_STATUS.ACCEPTED);
  });
});

describe('adversarial delivery classification: accept-then-drop-connection', () => {
  // Already covered before this work unit, at the single-attempt level:
  // client/src/lib/distribution/directPost.test.js's "ambiguous connection
  // reset after partial body -> error (not accepted)" test uses the exact
  // same real-local-server accept-then-drop shape and asserts
  // ATTEMPT_STATUS.ERROR. Not duplicated here.
  //
  // NOT previously covered at the ORCHESTRATION level: whether a genuine
  // connection-drop, run through the full runDistribution waterfall (not
  // just one bare deliverDirectPost call), resolves the overall RUN status
  // to AMBIGUOUS the same way a real timeout does. This is new coverage.
  it('a genuine connection drop is never classified as a successful attempt', async () => {
    const db = makeTraceDb();
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const member = {
      id: 'rm_drop0001', buyerId: 'buyer_drop0001', active: true, priority: 1, weight: 1,
      priceMode: 'fixed', fixedPrice: 50, price: 50, filters: {}, conditions: null, caps: {},
      buyer: { status: 'active', active: true }, wallet: null, health: { state: 'closed' },
      subDeliveryId: 'sd_drop0001', destinationId: 'dest_drop0001',
      delivery: {
        subDeliveryId: 'sd_drop0001', targetUrl: `${base}/drop`, method: 'POST', encoding: 'json',
        headers: {}, credentialRef: null, fieldMap: [{ src: 'email', dest: 'email' }],
        responseMapping: { accept: 'accepted', requireAccept: true }, timeoutMs: 5000,
      },
    };
    const ctx = {
      leadId: 'lead_drop', campaignId: 'camp_fixture_outcomes', idempotencyKey: 'idem_drop',
      leadData: { email: 'synthetic.drop@example.test', mobile: '5555550190' }, nowMs: NOW,
      distributionMode: 'new_only', fetchImpl: globalThis.fetch, testMode: true, allowlistHosts: ['127.0.0.1'],
      snapshot: { groups: [{ id: 'grp_drop', method: 'priority', active: true, orderIndex: 0, members: [member] }], configHash: 'x', configErrors: [] },
      stores: { capStore, attemptStore, walletStore: null }, healthStore: null,
    };
    const out = await runDistribution(db, ctx);
    expect(out.result.attempts[0].status).toBe(ATTEMPT_STATUS.ERROR);
    expect(out.status).not.toBe(RUN.ACCEPTED);
  });

  // KNOWN GAP, verified by direct execution against the real code (not fixed
  // here - client/src/lib/distribution/distributeRun.js is outside this work
  // unit's file ownership):
  //
  // distributeRun.js's toRunStatus flags a run ambiguous only when an ERROR
  // attempt's error_class is exactly 'timeout' or 'network_error'. A real
  // Node/undici connection reset (fetch accepts the connection, the server
  // destroys the socket mid-response) throws with message "fetch failed",
  // which matches NEITHER string. The result is RUN.ERROR_CLEAN - a
  // fallback-eligible "clean miss" - even though a real request was sent to
  // a real destination whose true outcome is unknown, which is exactly the
  // shape the ambiguous classification exists to protect against. This is
  // pinned below as a documented, currently-true gap, not as desired
  // behavior. Recommended follow-up: broaden toRunStatus's ambiguous check
  // to classify EVERY non-timeout ERROR the same way whenever no HTTP status
  // was ever received (http_status === null), rather than string-matching a
  // specific error_class value that real network stacks do not reliably
  // produce.
  it('KNOWN GAP: a real connection drop resolves ERROR_CLEAN (fallback-eligible), not AMBIGUOUS', async () => {
    const db = makeTraceDb();
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const member = {
      id: 'rm_drop0002', buyerId: 'buyer_drop0002', active: true, priority: 1, weight: 1,
      priceMode: 'fixed', fixedPrice: 50, price: 50, filters: {}, conditions: null, caps: {},
      buyer: { status: 'active', active: true }, wallet: null, health: { state: 'closed' },
      subDeliveryId: 'sd_drop0002', destinationId: 'dest_drop0002',
      delivery: {
        subDeliveryId: 'sd_drop0002', targetUrl: `${base}/drop`, method: 'POST', encoding: 'json',
        headers: {}, credentialRef: null, fieldMap: [{ src: 'email', dest: 'email' }],
        responseMapping: { accept: 'accepted', requireAccept: true }, timeoutMs: 5000,
      },
    };
    const ctx = {
      leadId: 'lead_drop2', campaignId: 'camp_fixture_outcomes', idempotencyKey: 'idem_drop2',
      leadData: { email: 'synthetic.drop2@example.test', mobile: '5555550191' }, nowMs: NOW,
      distributionMode: 'new_only', fetchImpl: globalThis.fetch, testMode: true, allowlistHosts: ['127.0.0.1'],
      snapshot: { groups: [{ id: 'grp_drop2', method: 'priority', active: true, orderIndex: 0, members: [member] }], configHash: 'x', configErrors: [] },
      stores: { capStore, attemptStore, walletStore: null }, healthStore: null,
    };
    const out = await runDistribution(db, ctx);
    const errorClass = out.result.attempts[0].error_class;
    expect(['timeout', 'network_error']).not.toContain(errorClass);
    expect(out.status).toBe(RUN.ERROR_CLEAN);
    expect(shouldFallback(out.status)).toBe(true);
  });
});

// KNOWN GAP, verified by direct execution against the real code (not fixed
// here - client/src/lib/distribution/distribute.js is outside this work
// unit's file ownership):
//
// The required "ambiguous timeout" fixture above (13) uses a single
// configured destination, which is the property genuinely true of the
// current code: nothing else exists to cascade to. Running the SAME timeout
// against a route with a SECOND, otherwise-eligible destination shows that
// distributeLead's own per-candidate loop does not stop when one candidate's
// outcome is ambiguous - it moves on to the next destination in the same
// run, exactly like it would after an ordinary REJECTED response. If that
// second destination then accepts, the overall run reports a clean
// RUN.ACCEPTED sale with no trace, at the run-status level, that the first
// destination's true outcome was ever unknown - the double-commercial-send
// risk this fixture set exists to guard against. Recommended follow-up:
// distributeLead must stop trying further destinations in the SAME run once
// any attempt resolves ambiguous (timeout/network-error/queued/superseded),
// the same way it already stops unconditionally on ACCEPTED/DUPLICATE.
describe('KNOWN GAP: ambiguous timeout does not stop cross-destination cascade today', () => {
  it('a second, otherwise-eligible destination is contacted (and can win) after the first times out', async () => {
    const db = makeTraceDb();
    const capStore = makeInMemoryCasStore();
    const attemptStore = makeInMemoryAttemptStore();
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push(String(url)); return globalThis.fetch(url, opts); };
    const m1 = {
      id: 'rm_gap0001', buyerId: 'buyer_gap0001', active: true, priority: 1, weight: 1,
      priceMode: 'fixed', fixedPrice: 50, price: 50, filters: {}, conditions: null, caps: {},
      buyer: { status: 'active', active: true }, wallet: null, health: { state: 'closed' },
      subDeliveryId: 'sd_gap0001', destinationId: 'dest_gap0001',
      delivery: {
        subDeliveryId: 'sd_gap0001', targetUrl: `${base}/hang`, method: 'POST', encoding: 'json',
        headers: {}, credentialRef: null, fieldMap: [{ src: 'email', dest: 'email' }],
        responseMapping: { accept: 'accepted', requireAccept: true }, timeoutMs: 100,
      },
    };
    const m2 = {
      id: 'rm_gap0002', buyerId: 'buyer_gap0002', active: true, priority: 2, weight: 1,
      priceMode: 'fixed', fixedPrice: 40, price: 40, filters: {}, conditions: null, caps: {},
      buyer: { status: 'active', active: true }, wallet: null, health: { state: 'closed' },
      subDeliveryId: 'sd_gap0002', destinationId: 'dest_gap0002',
      delivery: {
        subDeliveryId: 'sd_gap0002', targetUrl: `${base}/accept?price=40&bid=BYR-GAP2`, method: 'POST', encoding: 'json',
        headers: {}, credentialRef: null, fieldMap: [{ src: 'email', dest: 'email' }],
        responseMapping: { accept: 'accepted', requireAccept: true, revenuePath: 'price' }, timeoutMs: 5000,
      },
    };
    const ctx = {
      leadId: 'lead_gap', campaignId: 'camp_fixture_outcomes', idempotencyKey: 'idem_gap',
      leadData: { email: 'synthetic.gap@example.test', mobile: '5555550192' }, nowMs: NOW,
      distributionMode: 'new_only', fetchImpl, testMode: true, allowlistHosts: ['127.0.0.1'],
      snapshot: { groups: [{ id: 'grp_gap', method: 'priority', active: true, orderIndex: 0, members: [m1, m2] }], configHash: 'x', configErrors: [] },
      stores: { capStore, attemptStore, walletStore: null }, healthStore: null,
    };
    const out = await runDistribution(db, ctx);
    expect(out.result.attempts[0].status).toBe(ATTEMPT_STATUS.ERROR);
    expect(out.result.attempts[0].error_class).toBe('timeout');
    // The gap: destination 2 WAS contacted and WON, even though destination
    // 1's outcome is genuinely unknown.
    expect(calls).toHaveLength(2);
    expect(out.status).toBe(RUN.ACCEPTED);
    expect(out.winnerMemberId).toBe('rm_gap0002');
  });
});
