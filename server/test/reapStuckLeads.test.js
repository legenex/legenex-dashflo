// W4-REAPER acceptance evidence.
//
// forge-pack/03-plan/WORK-UNITS.yaml lists four acceptance steps for this unit
// and this file proves each one by executing it, not by asserting that it is
// true:
//
//   1. Kill the process between durable write and routing, restart, the lead is
//      present at queued and recovered.
//   2. An ambiguous delivery outcome is never resumed automatically; it
//      surfaces for reconciliation.
//   3. Leads carrying migrated_at are excluded.
//   4. Exactly one routing run and at most one sale result after recovery.
//
// Acceptance 4 is quoted verbatim from the unit spec, and what this file proves
// about it is narrower than those words suggest, so it is said plainly here
// rather than left to be assumed. What IS proven: one reaper pass makes exactly
// one call into the retry worker no matter how many leads qualify; two
// genuinely concurrent passes make exactly one between them, because a writing
// pass takes an in-process lock and a colliding one is skipped; and that call is
// scoped to the leads the pass classified as resumable. What is NOT claimed:
// that no other worker is touching the same queue, because
// nativeRetryScheduler.js drains it on its own timer. At-most-one-sale is real
// but is enforced a layer below this file, by the attempt store's CAS lease
// claim (exactly one worker ever owns an attempt) and by the engine's per-lead
// winner claim inside reserveAndDeliver.
//
// Two deliberate choices about how they are proven:
//
// Fixtures are built through the REAL production status writers. The crashed
// lead below is constructed with the same statusPatch(LEGACY_STATUS.PROCESSING,
// { processingState: RECEIVED }) call processLead.js makes on the line that
// creates the row, so the "exact intermediate state a real crash would leave"
// is not a hand-typed guess at that shape. If processLead's durable write ever
// changes shape, this fixture changes with it.
//
// The classifier is pure and is exercised directly as well as through the pass,
// because the whole safety argument for this unit is "what may be resumed", and
// that question must be answerable without a database, an engine, or a network.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEAD_STATUS,
  LEGACY_STATUS,
  PROCESSING_STATE,
  MONEY_FIELDS_NEVER_WRITTEN,
  statusPatch,
  leadStatusPatch,
  hasMigrationMarker,
  isExcludedFromRedrive,
} from '../src/lib/leadStatus.js';

import reapStuckLeads, {
  STUCK_LEAD_REAPER_FLAG,
  NATIVE_RETRY_WORKER_FLAG,
  STALL_THRESHOLD_MS,
  REAP_DISPOSITION,
  REAP_REASON,
  isReaperEnabled,
  isNativeRetryEnabled,
  classifyStuckLead,
  hasUnknownOutcome,
  isSafelyRetryableAttempt,
  lastProgressMs,
  runStuckLeadReaperPass,
  startStuckLeadReaper,
} from '../src/functions/reapStuckLeads.js';

// The REAL batch worker, not a double. Two tests below drive it end to end
// against a local mock buyer endpoint, because the defect this file exists to
// disprove is invisible to a spy: every one of the original 59 tests injected
// `retryPass`, so none of them could see that the real function ignores the
// reaper's classification entirely and re-drives the whole due queue.
import { runNativeRetryPass } from '../src/lib/nativeRetryRunner.js';

// ── Clock ─────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-05T10:00:00.000Z');
const STALLED = T0 + STALL_THRESHOLD_MS + 60_000;   // 16 minutes later
const FRESH = T0 + 60_000;                          // 1 minute later
const iso = (ms) => new Date(ms).toISOString();

// ── In-memory repository ──────────────────────────────────────────────────
//
// The same { entities: { ... } } shape every backend function receives, which
// is what lets the reaper run unchanged here and in production. Deliberately
// records every write and every create so a test can assert that a path wrote
// nothing at all, which is the only way to prove a negative like "never
// resends".

function makeDb({ leads = [], attempts = [], users = [], clockMs = STALLED } = {}) {
  const leadRows = leads.map((l) => ({ ...l }));
  const attemptRows = attempts.map((a) => ({ ...a }));
  let seq = 0;
  const calls = { leadUpdates: [], leadCreates: [], attemptWrites: [] };
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);

  return {
    calls,
    rows: { leads: leadRows, attempts: attemptRows },
    entities: {
      Lead: {
        async filter(where, _order, limit = 500, skip = 0) {
          return leadRows.filter((r) => matches(r, where)).slice(skip, skip + limit);
        },
        async list(_order, limit = 500, skip = 0) {
          return leadRows.slice(skip, skip + limit);
        },
        async get(id) {
          return leadRows.find((r) => r.id === id) || null;
        },
        async create(rec) {
          // A reaper must never create a Lead. Recorded so the crash-recovery
          // test can prove the recovery was not a re-post in disguise.
          const row = { ...rec, id: `created-${++seq}` };
          calls.leadCreates.push(row);
          leadRows.push(row);
          return row;
        },
        async update(id, patch) {
          calls.leadUpdates.push({ id, patch });
          const row = leadRows.find((r) => r.id === id);
          if (row) Object.assign(row, patch, { updated_date: iso(clockMs) });
          return row;
        },
      },
      DeliveryAttempt: {
        async filter(where) {
          return attemptRows.filter((a) => matches(a, where));
        },
        async update(id, patch) {
          calls.attemptWrites.push({ id, patch });
          return null;
        },
      },
      User: {
        async get(id) {
          return users.find((u) => u.id === id) || null;
        },
      },
    },
  };
}

// A retry pass double. Records every call so "exactly one routing run" is a
// counted fact rather than an inference.
function makeRetryPassSpy(result = { ran: true, mode: 'new_only', outcome: [] }) {
  const spy = vi.fn(async () => result);
  return spy;
}

// The reaper's own flag, and nothing else. Deliberately kept as the default
// environment for most tests: a reaper armed on its own must never reach the
// native retry worker, which is that worker's separate rollback control.
const ENABLED = { [STUCK_LEAD_REAPER_FLAG]: 'true' };

// Both rollback controls open. Only a pass running under THIS environment is
// allowed to hand anything to the retry worker.
const FULLY_ENABLED = { [STUCK_LEAD_REAPER_FLAG]: 'true', [NATIVE_RETRY_WORKER_FLAG]: 'true' };

// ── Fixtures built through the real production writers ────────────────────

// EXACTLY what processLead.js writes on the line that durably creates the lead
// (the Lead.create immediately after captureAndScreen commits the receipt).
// Built through the same statusPatch call, not transcribed.
function crashedBeforeRoutingLead(overrides = {}) {
  return {
    id: 'lead-crash',
    lead_id: 90001,
    supplier_name: 'Acme Leads',
    supplier_key_id: 'key-1',
    raw_payload: JSON.stringify({ first_name: 'Ada', last_name: 'Byron' }),
    archived: false,
    ...statusPatch(LEGACY_STATUS.PROCESSING, { processingState: PROCESSING_STATE.RECEIVED }),
    created_date: iso(T0),
    updated_date: iso(T0),
    ...overrides,
  };
}

// A lead that reached delivery, had one destination answer with a real HTTP
// error, and then stalled. This is the only class the reaper resumes.
function stalledAtRoutingLead(overrides = {}) {
  return {
    id: 'lead-routing',
    lead_id: 90002,
    supplier_name: 'Acme Leads',
    archived: false,
    ...statusPatch(LEGACY_STATUS.PROCESSING, { processingState: PROCESSING_STATE.ROUTING }),
    created_date: iso(T0),
    updated_date: iso(T0),
    ...overrides,
  };
}

function answeredAttempt(overrides = {}) {
  return {
    id: 'attempt-1',
    lead_id: 'lead-routing',
    sub_delivery_id: 'sd-1',
    route_member_id: 'rm-1',
    status: 'error',
    http_status: 502,
    error_class: 'http_5xx',
    attempt_number: 1,
    next_retry_at: iso(T0 + 30_000),
    run_idempotency_key: '90002',
    ...overrides,
  };
}

// Three resumable leads with two due attempts each. Hoisted to module scope
// because both acceptance 4 and the concurrency tests need it.
function resumableSetFor() {
  const leads = ['a', 'b', 'c'].map((k) => stalledAtRoutingLead({ id: `lead-${k}`, lead_id: 9100 + k.charCodeAt(0) }));
  const attempts = leads.flatMap((l, i) => [
    answeredAttempt({ id: `attempt-${i}-1`, lead_id: l.id }),
    answeredAttempt({ id: `attempt-${i}-2`, lead_id: l.id, sub_delivery_id: 'sd-2', http_status: 503 }),
  ]);
  return { leads, attempts };
}

// ── The wire ──────────────────────────────────────────────────────────────
//
// Everything below this line exists because the original suite could not have
// caught the defect it was written to prevent. All 59 of its tests injected a
// `retryPass` double, so they observed the reaper's own report of what it had
// decided and never what the retry worker actually put on a socket. The two
// were not the same thing: the reaper classified per lead, and then called a
// BATCH worker that re-drove every due attempt in the system regardless.
//
// These fixtures drive the REAL runNativeRetryPass against a real local HTTP
// server standing in for a buyer endpoint, and assert on the requests that
// arrived there. The target URL carries the route member id, so "which lead was
// sent" is read off the request log rather than inferred.

let wireServer = null;
let wireBase = '';
let wireLog = [];

beforeAll(async () => {
  wireServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      wireLog.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'accepted' }));
    });
  });
  await new Promise((r) => wireServer.listen(0, '127.0.0.1', r));
  wireBase = `http://127.0.0.1:${wireServer.address().port}`;
});

afterAll(() => new Promise((r) => wireServer.close(r)));

// The same permissive stand-in nativeRetryWorker.test.js uses, and for the same
// reason: the real strict validator (ssrfGuard.js) correctly refuses 127.0.0.1,
// which is exactly where an isolated loopback mock buyer lives. validateTarget
// is the override nativeRetryRunner.js already exposes for this. Nothing else
// about the pass is stubbed: the mode gate, the due-attempt selection, the CAS
// lease claim, the isLeadSold pre-check, reserveAndDeliver and the scoping under
// test are all the production code paths.
const ALLOW_ALL_TARGETS = async () => ({ ok: true });

const REAL_RETRY_PASS = (db, opts) => runNativeRetryPass(db, { ...opts, validateTarget: ALLOW_ALL_TARGETS });

const EPOCH_ISO = new Date(0).toISOString();

function makeWireScenario({ leads = [], attempts = [], clockMs = STALLED, distributionMode = 'new_only' } = {}) {
  wireLog = [];
  const leadRows = leads.map((l) => ({ ...l }));
  const attemptRows = attempts.map((a) => ({
    lease_until: null,
    lease_version: 0,
    ...a,
    // The reaper classifies against the injected clock while the retry worker
    // reads the real wall clock, so due times are anchored to the epoch to be
    // unambiguously due under both. isSafelyRetryableAttempt only requires
    // next_retry_at to be present, so this does not change any classification.
    next_retry_at: a.next_retry_at === null ? null : EPOCH_ISO,
    // Distinct per attempt so no two attempts share an outbound
    // Idempotency-Key and one lead's send cannot be suppressed as a duplicate
    // of another's.
    idempotency_key: `idem-${a.id}`,
    run_idempotency_key: `idem-${a.id}`,
  }));
  const calls = { leadUpdates: [], leadCreates: [] };
  const health = [];
  const capCounters = [];
  let seq = 0;
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);

  // sub_delivery_id -> route_member_id, so each destination has its own URL.
  const memberOfSub = new Map(attemptRows.map((a) => [a.sub_delivery_id, a.route_member_id]));

  const db = {
    calls,
    rows: { leads: leadRows, attempts: attemptRows },
    entities: {
      AppSettings: { list: async () => [{ distribution_mode: distributionMode }] },
      User: { get: async () => ({ id: 'u1', role: 'admin' }) },
      Lead: {
        async filter(where, _order, limit = 500, skip = 0) {
          return leadRows.filter((r) => matches(r, where)).slice(skip, skip + limit);
        },
        // Falls back to a synthetic row so the control test can drive the batch
        // worker over attempts whose leads are not part of the reaper's scan.
        async get(id) {
          return leadRows.find((r) => r.id === id) || { id, email: `${id}@example.test` };
        },
        async create(rec) { const row = { ...rec, id: `created-${++seq}` }; calls.leadCreates.push(row); leadRows.push(row); return row; },
        async update(id, patch) {
          calls.leadUpdates.push({ id, patch });
          const row = leadRows.find((r) => r.id === id);
          if (row) Object.assign(row, patch, { updated_date: iso(clockMs) });
          return row;
        },
      },
      DeliveryAttempt: {
        async filter(where) { return attemptRows.filter((a) => matches(a, where)); },
        async create(rec) { const row = { ...rec, id: `a-${++seq}` }; attemptRows.push(row); return row; },
        async update(id, patch) { const a = attemptRows.find((x) => x.id === id); if (a) Object.assign(a, patch); return a; },
        async updateMany(where, { $set }) {
          const hits = attemptRows.filter((a) => matches(a, where));
          for (const a of hits) Object.assign(a, $set);
          return { updated: hits.length };
        },
      },
      SubDelivery: {
        async get(id) {
          if (!memberOfSub.has(id)) return null;
          return {
            id,
            delivery_id: 'del-1',
            target_url: `${wireBase}/post/${memberOfSub.get(id)}`,
            method: 'POST',
            encoding: 'json',
            field_map: JSON.stringify([{ src: 'email', dest: 'email' }]),
            response_mapping: JSON.stringify({ accepted: 'accepted' }),
          };
        },
      },
      Delivery: { async get(id) { return id === 'del-1' ? { id: 'del-1', buyer_id: 'buyer-1', status: 'active' } : null; } },
      RouteMember: {
        async get(id) { return { id, buyer_id: 'buyer-1', price_mode: 'fixed', fixed_price: 25 }; },
      },
      Buyer: { async get(id) { return { id, billing_type: 'invoice' }; } },
      DestinationHealth: {
        async filter(q) { return health.filter((h) => matches(h, q)); },
        async create(rec) { const row = { id: `h-${++seq}`, ...rec }; health.push(row); return row; },
        async update(id, patch) { const h = health.find((x) => x.id === id); if (h) Object.assign(h, patch); return h; },
      },
      CapCounter: {
        async filter(q) { return capCounters.filter((c) => matches(c, q)); },
        async create(rec) { const row = { id: `cc-${++seq}`, ...rec }; capCounters.push(row); return row; },
        async updateMany(q, { $set }) {
          const hits = capCounters.filter((c) => matches(c, q));
          for (const c of hits) Object.assign(c, $set);
          return { updated: hits.length };
        },
      },
      IntegrationConfig: { async filter() { return []; } },
    },
  };

  return {
    db,
    // The route members that actually received a POST, in arrival order. This
    // is the assertion that matters: it is read off the socket, not off the
    // reaper's own summary of what it believed it was doing.
    delivered: () => wireLog.map((entry) => entry.url.split('/').pop()),
    attemptRow: (id) => attemptRows.find((a) => a.id === id),
  };
}

// ── Environment flag ──────────────────────────────────────────────────────

describe('STUCK_LEAD_REAPER_ENABLED is a real gate, default off', () => {
  it('is off when the variable is absent', () => {
    expect(isReaperEnabled({})).toBe(false);
  });

  it('is off for every near-miss spelling, so a half-set variable fails closed', () => {
    for (const value of ['', '1', 'yes', 'TRUE', 'True', 'on', 'false', ' true']) {
      expect(isReaperEnabled({ [STUCK_LEAD_REAPER_FLAG]: value }), `"${value}" must not arm the reaper`).toBe(false);
    }
  });

  it('is on only for the exact string "true"', () => {
    expect(isReaperEnabled({ [STUCK_LEAD_REAPER_FLAG]: 'true' })).toBe(true);
  });

  it('with the flag off the pass scans nothing, writes nothing and resumes nothing', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const retryPass = makeRetryPassSpy();
    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: {} });

    expect(out.ran).toBe(false);
    expect(out.reason).toContain(STUCK_LEAD_REAPER_FLAG);
    expect(out.stuck).toEqual([]);
    expect(db.calls.leadUpdates).toHaveLength(0);
    expect(retryPass).not.toHaveBeenCalled();
  });

  it('the scheduled caller creates no timer while the flag is off, and one while it is on', () => {
    const log = { log: () => {}, error: () => {} };
    expect(startStuckLeadReaper(makeDb({}), { env: {}, log })).toBeNull();

    const timer = startStuckLeadReaper(makeDb({}), { env: ENABLED, log, intervalMs: 60_000 });
    expect(timer).not.toBeNull();
    clearInterval(timer);
  });

  it('the HTTP entry point refuses a portal account before it reads the flag at all', async () => {
    const db = makeDb({ users: [{ id: 'u1', base_role: 'buyer', role: 'user' }] });
    const json = vi.fn((body, status) => ({ body, status }));
    const res = await reapStuckLeads({ db, user: { id: 'u1' }, env: ENABLED, json, body: {} });
    expect(res.status).toBe(403);
  });

  it('the HTTP entry point reports the disabled state to an operator rather than pretending it ran', async () => {
    const db = makeDb({ users: [{ id: 'u1', role: 'admin' }] });
    const out = await reapStuckLeads({ db, user: { id: 'u1' }, env: {}, json: (b, s) => ({ b, s }), body: {} });
    expect(out.ok).toBe(false);
    expect(out.enabled).toBe(false);
    expect(out.stuck).toEqual([]);
  });

  it('a dry run classifies but writes nothing and hands nothing to the retry worker', async () => {
    // The HTTP entry point deliberately does not accept an injected clock, so
    // these two are dated well into the past to be unambiguously stalled
    // against the real Date.now() the handler uses.
    const longAgo = iso(Date.parse('2020-01-01T00:00:00.000Z'));
    const db = makeDb({
      leads: [
        stalledAtRoutingLead({ created_date: longAgo, updated_date: longAgo }),
        crashedBeforeRoutingLead({ created_date: longAgo, updated_date: longAgo }),
      ],
      attempts: [answeredAttempt()],
      users: [{ id: 'u1', role: 'admin' }],
    });
    const out = await reapStuckLeads({
      db, user: { id: 'u1' }, env: ENABLED, json: (b, s) => ({ b, s }), body: { dry_run: true },
    });

    expect(out.dry_run).toBe(true);
    expect(out.stuck.length).toBe(2);
    expect(db.calls.leadUpdates).toHaveLength(0);
    expect(out.resumed.routing_runs).toBe(0);
  });
});

// ── Acceptance 1: crash between durable write and routing ─────────────────

describe('acceptance 1: killed between the durable write and routing, the lead is present at queued and is recovered', () => {
  // The state a real crash leaves, restated as facts about the fixture before
  // the reaper is allowed anywhere near it. This is the "restart" half: the
  // process is gone, and this is what survived it on disk.
  it('the surviving row is at queued with an unadvanced processing_state and no processed_at', () => {
    const lead = crashedBeforeRoutingLead();
    expect(lead.lead_status).toBe(LEAD_STATUS.QUEUED);
    expect(lead.processing_state).toBe(PROCESSING_STATE.RECEIVED);
    expect(lead.processed_at).toBeUndefined();
    // The crash did not move the business status. D1's "a crash never changes
    // lead_status", observed on the actual fixture rather than assumed.
    expect(lead.lead_status).not.toBe(LEAD_STATUS.SOLD);
    expect(lead.is_sold).toBeUndefined();
  });

  it('is invisible to the reaper until the fifteen minute window has passed', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()], clockMs: FRESH });
    const out = await runStuckLeadReaperPass(db, { nowMs: FRESH, retryPass: makeRetryPassSpy(), env: ENABLED });
    expect(out.stuck).toHaveLength(0);
    expect(db.calls.leadUpdates).toHaveLength(0);
  });

  it('is found, classified at the stage it stalled at, and recovered into the Stuck Leads queue', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const retryPass = makeRetryPassSpy();
    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(out.ran).toBe(true);
    expect(out.stuck).toHaveLength(1);

    const row = out.stuck[0];
    expect(row.id).toBe('lead-crash');
    expect(row.lead_status).toBe(LEAD_STATUS.QUEUED);
    // The stage it stalled at, which is what the card has to show an operator.
    expect(row.stage).toBe(PROCESSING_STATE.RECEIVED);
    expect(row.stalled_minutes).toBe(16);
    expect(row.disposition).toBe(REAP_DISPOSITION.NO_SAFE_REENTRY);
    expect(row.resumable).toBe(false);

    // Recovered: promoted into the state D1 calls a stuck lead, with the stage
    // recorded, and still at queued.
    expect(db.calls.leadUpdates).toHaveLength(1);
    const { id, patch } = db.calls.leadUpdates[0];
    expect(id).toBe('lead-crash');
    expect(patch.lead_status).toBe(LEAD_STATUS.QUEUED);
    expect(patch.processing_state).toBe(PROCESSING_STATE.FAILED);
    expect(patch.status_reason).toBe(REAP_REASON.STALLED_PRE_ROUTING);
    expect(patch.status_reason_detail).toContain(PROCESSING_STATE.RECEIVED);
    expect(out.marked_stuck).toEqual(['lead-crash']);
  });

  it('recovers it without re-posting it: no second lead, no routing run, no delivery', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const retryPass = makeRetryPassSpy();
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    // The unsafe recovery this unit was warned off is a replay through intake,
    // which creates a second Lead row that routes and sells independently of
    // the first. Proven not to have happened.
    expect(db.calls.leadCreates).toHaveLength(0);
    expect(db.rows.leads).toHaveLength(1);
    expect(retryPass).not.toHaveBeenCalled();
    expect(db.calls.attemptWrites).toHaveLength(0);
  });

  it('a second pass over the recovered lead changes nothing, so a scheduler cannot churn it', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const retryPass = makeRetryPassSpy();
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });
    const afterFirst = db.calls.leadUpdates.length;

    const second = await runStuckLeadReaperPass(db, { nowMs: STALLED + STALL_THRESHOLD_MS, retryPass, env: ENABLED });

    // Still surfaced, because a lead at queued plus failed IS a stuck lead and
    // must stay visible until a human deals with it. But not rewritten.
    expect(second.stuck).toHaveLength(1);
    expect(second.stuck[0].stage).toBe(PROCESSING_STATE.FAILED);
    expect(db.calls.leadUpdates).toHaveLength(afterFirst);
    expect(retryPass).not.toHaveBeenCalled();
  });

  it('the recovery write touches no money flag and no legacy status field', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    for (const { patch } of db.calls.leadUpdates) {
      for (const field of MONEY_FIELDS_NEVER_WRITTEN) {
        expect(Object.prototype.hasOwnProperty.call(patch, field), `reaper wrote money flag ${field}`).toBe(false);
      }
      // final_status is the expand-phase legacy column. newVocabularyFields
      // strips it precisely so a recovery job cannot race the writers that own
      // it, and this asserts that stripping actually happened.
      expect(Object.prototype.hasOwnProperty.call(patch, 'final_status')).toBe(false);
      // Whatever else changes, the business status never does.
      expect(patch.lead_status).toBe(LEAD_STATUS.QUEUED);
    }
  });
});

// ── Acceptance 2: an ambiguous outcome is never resumed ───────────────────

describe('acceptance 2: an ambiguous delivery outcome is never resumed automatically', () => {
  it('a lead the pipeline itself marked ambiguous is held, not resumed', async () => {
    const lead = stalledAtRoutingLead({
      id: 'lead-ambiguous',
      ...statusPatch(LEGACY_STATUS.QUEUED, {
        processingState: PROCESSING_STATE.AMBIGUOUS,
        reason: 'DELIVERY_AMBIGUOUS',
      }),
      queue_reason: 'Native delivery outcome unconfirmed (timeout); not re-sent to avoid a double sale',
      created_date: iso(T0),
      updated_date: iso(T0),
    });
    const db = makeDb({ leads: [lead] });
    const retryPass = makeRetryPassSpy();

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(out.stuck[0].disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
    expect(out.stuck[0].resumable).toBe(false);
    expect(out.stuck[0].stage).toBe(PROCESSING_STATE.AMBIGUOUS);
    expect(out.resumed.lead_ids).toEqual([]);
    expect(out.resumed.routing_runs).toBe(0);
    expect(retryPass).not.toHaveBeenCalled();
    // Held means held. Not even a status marker is written over an ambiguous
    // lead, because the one thing an operator reconciling it needs is the state
    // the pipeline actually left.
    expect(db.calls.leadUpdates).toHaveLength(0);
  });

  it('ambiguity outranks a perfectly retryable attempt sitting next to it', () => {
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead({
        processing_state: PROCESSING_STATE.AMBIGUOUS,
      }),
      attempts: [answeredAttempt()],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
    expect(verdict.resumable).toBe(false);
  });

  // The reason this unit does not simply trust processing_state === ambiguous.
  // forge-pack/state/BLOCKERS.md records that distributeRun.js's toRunStatus
  // classifies a run ambiguous only when error_class is exactly 'timeout' or
  // 'network_error', so a real undici connection drop ("fetch failed") is
  // recorded as a clean miss and stays cascade eligible. If the reaper trusted
  // the upstream label, that lead would arrive here looking resumable.
  it('derives ambiguity itself when the upstream classifier missed it (BLOCKERS.md defect 3)', () => {
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead(),                       // processing_state: routing, NOT ambiguous
      attempts: [answeredAttempt({
        error_class: 'fetch failed',                      // matches neither string toRunStatus looks for
        http_status: null,                                // no response line ever came back
      })],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
    expect(verdict.resumable).toBe(false);
  });

  it.each([
    ['an attempt row created but never sent', { status: 'pending', http_status: null, next_retry_at: null }],
    ['an attempt sent with no recorded answer', { status: 'sent', http_status: null, next_retry_at: null }],
    ['an attempt parked at queued', { status: 'queued', http_status: null, next_retry_at: null }],
    ['an errored attempt with no HTTP status at all', { status: 'error', http_status: null }],
    ['an errored attempt whose status is undefined rather than null', { status: 'error', http_status: undefined }],
  ])('holds %s', (_label, attemptOverride) => {
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead(),
      attempts: [answeredAttempt(attemptOverride)],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
  });

  it('holds a legacy LeadByte post that has a request on record and no response', () => {
    // processLead.js writes leadbyte_request immediately before the post and
    // leadbyte_response after it. A request with no response is a post whose
    // outcome nobody knows. This is the shape real traffic takes today, because
    // distribution_mode is legacy_only and native attempt rows do not exist.
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead({ leadbyte_request: '{"lead":"payload"}' }),
      attempts: [],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
  });

  it('does not hold a legacy post that was answered', () => {
    expect(hasUnknownOutcome({
      leadbyte_request: '{"lead":"payload"}',
      leadbyte_response: '{"status":"ok"}',
    }, [])).toBe(false);
  });

  it('an ambiguous lead surfaces for reconciliation rather than disappearing', async () => {
    const db = makeDb({
      leads: [stalledAtRoutingLead({ id: 'lead-amb', processing_state: PROCESSING_STATE.AMBIGUOUS })],
    });
    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });
    expect(out.counts.by_disposition[REAP_DISPOSITION.AMBIGUOUS_HOLD]).toBe(1);
    expect(out.stuck[0].reason).toMatch(/second sale/i);
  });
});

// ── Acceptance 3: migrated_at exclusion, through isExcludedFromRedrive ────

describe('acceptance 3: leads carrying migrated_at are excluded', () => {
  // Built by the real migration patch builder, so this is the row shape the
  // backfill actually produces for a legacy Error lead, not a guess at it.
  function migratedErrorLead(overrides = {}) {
    const historical = {
      id: 'lead-migrated',
      lead_id: 70001,
      supplier_name: 'Legacy Import',
      final_status: LEGACY_STATUS.ERROR,
      created_date: iso(T0 - 90 * 24 * 3600 * 1000),
    };
    const patch = leadStatusPatch(historical, { at: new Date(T0 - 24 * 3600 * 1000) });
    return { ...historical, ...patch, updated_date: iso(T0 - 24 * 3600 * 1000), ...overrides };
  }

  it('the migration really does leave the row at queued plus failed with a marker', () => {
    const lead = migratedErrorLead();
    expect(lead.lead_status).toBe(LEAD_STATUS.QUEUED);
    expect(lead.processing_state).toBe(PROCESSING_STATE.FAILED);
    expect(lead.migrated_at).toBeTruthy();
  });

  it('is excluded, never resumed, and never written to', async () => {
    const db = makeDb({ leads: [migratedErrorLead()] });
    const retryPass = makeRetryPassSpy();
    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(out.stuck).toHaveLength(1);
    expect(out.stuck[0].disposition).toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);
    expect(out.stuck[0].resumable).toBe(false);
    expect(out.stuck[0].actionable).toBe(false);
    expect(retryPass).not.toHaveBeenCalled();
    expect(db.calls.leadUpdates).toHaveLength(0);
    expect(db.calls.leadCreates).toHaveLength(0);
  });

  it('is excluded even with a retryable attempt attached, so a stale attempt row cannot re-drive history', () => {
    const verdict = classifyStuckLead({
      lead: migratedErrorLead(),
      attempts: [answeredAttempt({ lead_id: 'lead-migrated' })],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);
  });

  // The test that proves the predicate was CALLED and not reimplemented as
  // Boolean(lead.migrated_at). migrated_at is permanent and is never cleared,
  // so a presence test would make every migrated lead permanently invisible to
  // the reaper, including one that migrated cleanly in June and then genuinely
  // failed, live, in September. isExcludedFromRedrive compares the marker
  // against the lead's own live-path activity instead.
  it('a migrated lead that failed again on a live path is NOT excluded, which a naive marker check would have got wrong', async () => {
    const lead = migratedErrorLead({
      id: 'lead-migrated-then-live',
      // A real live-path timestamp AFTER the migration stamp. processLead.js
      // writes processed_at on every branch; this module cannot write it at all
      // (it is not in STATUS_PATCH_FIELDS), which is what makes it trustworthy.
      processed_at: iso(T0),
      updated_date: iso(T0),
    });

    // The naive check and the correct one disagree here, which is the whole
    // point. Asserted explicitly so a future edit back to the naive form fails
    // this test loudly instead of silently hiding live failures.
    expect(hasMigrationMarker(lead)).toBe(true);
    expect(isExcludedFromRedrive(lead)).toBe(false);

    const db = makeDb({ leads: [lead] });
    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    expect(out.stuck[0].disposition).not.toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);
    expect(out.stuck[0].disposition).toBe(REAP_DISPOSITION.NO_SAFE_REENTRY);
  });

  it('an unparseable or activity-free marker stays excluded, matching the predicate on both conservative edges', () => {
    expect(classifyStuckLead({
      lead: migratedErrorLead({ id: 'lead-bad-marker', migrated_at: 'not-a-date' }),
      nowMs: STALLED,
    }).disposition).toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);

    expect(classifyStuckLead({
      lead: migratedErrorLead({ id: 'lead-no-activity', processed_at: null, leadbyte_outcome_at: null }),
      nowMs: STALLED,
    }).disposition).toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);
  });
});

// ── Acceptance 4: exactly one routing run, at most one sale ───────────────

describe('acceptance 4: exactly one routing run and at most one sale result after recovery', () => {
  // Three resumable leads, two due attempts each. A per-lead or per-attempt
  // call into the retry worker would fan this out; the pass must not.
  const resumableSet = resumableSetFor;

  it('hands the whole batch to the retry worker in exactly one call, scoped to exactly those leads', async () => {
    const { leads, attempts } = resumableSet();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED });

    expect(out.resumed.lead_ids).toEqual(['lead-a', 'lead-b', 'lead-c']);
    // Three leads, six due attempts, one call into the retry worker.
    expect(retryPass).toHaveBeenCalledTimes(1);
    expect(out.resumed.routing_runs).toBe(1);
    // And that one call is scoped. Without onlyLeadIds it is a batch pass over
    // every due attempt in the system, which is the B2 defect.
    expect(retryPass.mock.calls[0][1].onlyLeadIds).toEqual(['lead-a', 'lead-b', 'lead-c']);
  });

  it('a second pass immediately after does not produce a second call into the retry worker for the same leads', async () => {
    const { leads, attempts } = resumableSet();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED });
    expect(retryPass).toHaveBeenCalledTimes(1);

    // The resume marker bumped updated_date, which resets each lead's stall
    // clock. A scheduler ticking a minute later therefore sees work in
    // progress, not a stalled lead, and does not re-drive it. This is what
    // stops "recovered" from becoming "recovered repeatedly".
    const second = await runStuckLeadReaperPass(db, { nowMs: STALLED + 60_000, retryPass, env: FULLY_ENABLED });
    expect(second.stuck).toHaveLength(0);
    expect(second.resumed.routing_runs).toBe(0);
    expect(retryPass).toHaveBeenCalledTimes(1);
  });

  it('the resume marker keeps the lead at queued and records why it was resumed', async () => {
    const db = makeDb({ leads: [stalledAtRoutingLead()], attempts: [answeredAttempt()] });
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: FULLY_ENABLED });

    expect(db.calls.leadUpdates).toHaveLength(1);
    const { patch } = db.calls.leadUpdates[0];
    expect(patch.lead_status).toBe(LEAD_STATUS.QUEUED);
    expect(patch.processing_state).toBe(PROCESSING_STATE.ROUTING);
    expect(patch.status_reason).toBe(REAP_REASON.RESUMED);
    for (const field of MONEY_FIELDS_NEVER_WRITTEN) {
      expect(Object.prototype.hasOwnProperty.call(patch, field)).toBe(false);
    }
  });

  it('a lead already carrying the write-once sale flags is never resumed', async () => {
    const lead = stalledAtRoutingLead({
      id: 'lead-sold',
      is_sold: true,
      sold_at: iso(T0),
      sale_price_effective: 42.5,
    });
    const db = makeDb({ leads: [lead], attempts: [answeredAttempt({ lead_id: 'lead-sold' })] });
    const retryPass = makeRetryPassSpy();

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(out.stuck[0].disposition).toBe(REAP_DISPOSITION.ALREADY_SOLD);
    expect(out.resumed.routing_runs).toBe(0);
    expect(retryPass).not.toHaveBeenCalled();
    expect(db.calls.leadUpdates).toHaveLength(0);
  });

  it('a lead with an accepted delivery attempt is never resumed, even if the sale flags were never latched', async () => {
    // The crash window that makes this matter: a destination answered accepted,
    // and the process died before the write-once flags reached the Lead row. The
    // sale happened. Re-driving this lead's other attempts would be a cascade
    // past a completed sale, which is BLOCKERS.md defect 1 arriving through the
    // recovery path instead of the primary one.
    const lead = stalledAtRoutingLead({ id: 'lead-accepted' });
    const db = makeDb({
      leads: [lead],
      attempts: [
        answeredAttempt({ id: 'won', lead_id: 'lead-accepted', status: 'accepted', http_status: 200, next_retry_at: null }),
        answeredAttempt({ id: 'lost', lead_id: 'lead-accepted' }),
      ],
    });
    const retryPass = makeRetryPassSpy();

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(lead.is_sold).toBeUndefined();
    expect(out.stuck[0].disposition).toBe(REAP_DISPOSITION.ALREADY_SOLD);
    expect(retryPass).not.toHaveBeenCalled();
    expect(db.calls.leadUpdates).toHaveLength(0);
  });

  it('resumes nothing, and starts no routing run, when nothing is resumable', async () => {
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const retryPass = makeRetryPassSpy();
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });
    expect(retryPass).not.toHaveBeenCalled();
  });

  it('the resume is delegated to the existing retry worker, with the pass worker id, not reimplemented here', async () => {
    const db = makeDb({ leads: [stalledAtRoutingLead()], attempts: [answeredAttempt()] });
    const retryPass = makeRetryPassSpy();
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, workerId: 'reaper-test', env: FULLY_ENABLED });

    expect(retryPass).toHaveBeenCalledWith(db, { workerId: 'reaper-test', onlyLeadIds: ['lead-routing'] });
  });
});

// ── B1: the reaper must not defeat the retry worker's own rollback control ──
//
// nativeRetryRunner.js's header states that NATIVE_RETRY_WORKER_ENABLED is the
// caller's responsibility. nativeRetryWorker.js checks it and refuses;
// nativeRetryScheduler.js checks it and creates no timer. This file previously
// did neither, so setting one flag (STUCK_LEAD_REAPER_ENABLED) silently armed a
// second, wider retry mechanism the operator had deliberately left off.

describe('B1: NATIVE_RETRY_WORKER_ENABLED gates the reaper too, exactly as it gates the other two callers', () => {
  it('is off when absent and on only for the exact string "true", matching the other callers', () => {
    expect(isNativeRetryEnabled({})).toBe(false);
    for (const value of ['', '1', 'yes', 'TRUE', 'True', 'on', 'false', ' true']) {
      expect(isNativeRetryEnabled({ [NATIVE_RETRY_WORKER_FLAG]: value }), `"${value}" must not arm the retry worker`).toBe(false);
    }
    expect(isNativeRetryEnabled({ [NATIVE_RETRY_WORKER_FLAG]: 'true' })).toBe(true);
  });

  // The proof the QA's reproduction demanded: the REAL runNativeRetryPass, not
  // an injected spy, with the variable absent from the environment, and a lead
  // that is unambiguously resumable sitting there ready to be sent. Zero
  // delivery attempts must reach the wire.
  it('makes ZERO delivery attempts through the real runNativeRetryPass when the variable is unset', async () => {
    const scenario = makeWireScenario({
      leads: [stalledAtRoutingLead({ id: 'lead-resumable' })],
      attempts: [answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' })],
    });

    const out = await runStuckLeadReaperPass(scenario.db, {
      nowMs: STALLED,
      // No retryPass override. This is the real batch worker.
      retryPass: REAL_RETRY_PASS,
      env: ENABLED,                 // reaper armed, retry worker NOT armed
    });

    expect(scenario.delivered()).toEqual([]);
    expect(out.native_retry_enabled).toBe(false);
    expect(out.resumed.routing_runs).toBe(0);
    expect(out.resumed.retry_pass).toBeNull();
    // Held, not resumed, and reported as held rather than as nothing found.
    expect(out.resumed.lead_ids).toEqual([]);
    expect(out.resumed.held_by_native_retry_gate).toEqual(['lead-resumable']);
    expect(out.stuck[0].held_by_native_retry_gate).toBe(true);
    // And no RESUMED marker was written, because nothing was resumed. Writing
    // one would both lie to the operator and reset the lead's stall clock so
    // the next pass could not see it either.
    expect(scenario.db.calls.leadUpdates).toHaveLength(0);
  });

  it('with the same fixture and BOTH flags set, the same lead really is delivered, so the gate is what made the difference', async () => {
    const scenario = makeWireScenario({
      leads: [stalledAtRoutingLead({ id: 'lead-resumable' })],
      attempts: [answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' })],
    });

    const out = await runStuckLeadReaperPass(scenario.db, {
      nowMs: STALLED, retryPass: REAL_RETRY_PASS, env: FULLY_ENABLED,
    });

    expect(scenario.delivered()).toEqual(['rm-1']);
    expect(out.native_retry_enabled).toBe(true);
    expect(out.resumed.lead_ids).toEqual(['lead-resumable']);
    expect(out.resumed.routing_runs).toBe(1);
  });
});

// ── B2: the classification controls the wire, not just the card ─────────────
//
// The defect these two tests exist to disprove, in one sentence:
// runNativeRetryPass is a batch worker over the ENTIRE due queue, so the
// reaper's careful per-lead verdict decided what got written and displayed and
// decided nothing at all about what got sent. A lead the card rendered as
// "Never resumed automatically" was resent in the very same pass.
//
// Both tests drive the REAL runNativeRetryPass against a real local HTTP
// endpoint and assert on what actually arrived there, keyed by route member, so
// they check the wire and not the reaper's own report of itself.

describe('B2: only leads the reaper classified as resumable are ever sent', () => {
  it('an AMBIGUOUS_HOLD lead alongside a resumable one: only the resumable one is delivered', async () => {
    const scenario = makeWireScenario({
      leads: [
        stalledAtRoutingLead({ id: 'lead-resumable' }),
        stalledAtRoutingLead({ id: 'lead-ambiguous' }),
      ],
      attempts: [
        // Known outcome: a real HTTP status came back. Safe to re-drive.
        answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' }),
        // The real "fetch failed" shape from BLOCKERS.md item 3: status error,
        // no http_status. The request left this process and nothing came back,
        // so a resend could be the second half of a double delivery. This is
        // due in the retry worker's own queue, which is precisely why an
        // unscoped batch pass picked it up.
        answeredAttempt({
          id: 'att-ambiguous', lead_id: 'lead-ambiguous', sub_delivery_id: 'sd-amb', route_member_id: 'rm-amb',
          http_status: null, error_class: 'fetch failed',
        }),
      ],
    });

    const out = await runStuckLeadReaperPass(scenario.db, {
      nowMs: STALLED, retryPass: REAL_RETRY_PASS, env: FULLY_ENABLED,
    });

    // The classification is right, and always was.
    const byId = Object.fromEntries(out.stuck.map((r) => [r.id, r]));
    expect(byId['lead-ambiguous'].disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
    expect(byId['lead-ambiguous'].resumable).toBe(false);
    expect(byId['lead-resumable'].disposition).toBe(REAP_DISPOSITION.RESUME_DELIVERY);

    // The wire is what was wrong. Before the fix this was ['rm-1', 'rm-amb'].
    expect(scenario.delivered()).toEqual(['rm-1']);
    expect(scenario.delivered()).not.toContain('rm-amb');

    // And the ambiguous lead's attempt row was not touched at all: no lease
    // taken, no lease_version bumped, no status moved. Scoping excludes it from
    // the worker's due-selection, so it is never even claimed.
    const ambAttempt = scenario.attemptRow('att-ambiguous');
    expect(ambAttempt.status).toBe('error');
    expect(ambAttempt.lease_until == null).toBe(true);
    expect(ambAttempt.lease_version || 0).toBe(0);
    expect(ambAttempt.attempt_number).toBe(1);
  });

  it('an EXCLUDED_MIGRATED lead alongside a resumable one: only the resumable one is delivered', async () => {
    // Built through the real migration patch builder, the same way acceptance 3
    // builds it, so this is the row shape the backfill actually produces.
    const historical = {
      id: 'lead-migrated',
      lead_id: 70002,
      supplier_name: 'Legacy Import',
      final_status: LEGACY_STATUS.ERROR,
      created_date: iso(T0 - 90 * 24 * 3600 * 1000),
    };
    const migrated = {
      ...historical,
      ...leadStatusPatch(historical, { at: new Date(T0 - 24 * 3600 * 1000) }),
      updated_date: iso(T0 - 24 * 3600 * 1000),
    };

    const scenario = makeWireScenario({
      leads: [stalledAtRoutingLead({ id: 'lead-resumable' }), migrated],
      attempts: [
        answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' }),
        // A stale, perfectly due attempt row attached to pre-cutover history.
        // Re-driving it posts pre-cutover data to a real buyer, which is D4
        // risk 3 arriving through the recovery path.
        answeredAttempt({ id: 'att-migrated', lead_id: 'lead-migrated', sub_delivery_id: 'sd-mig', route_member_id: 'rm-mig' }),
      ],
    });

    const out = await runStuckLeadReaperPass(scenario.db, {
      nowMs: STALLED, retryPass: REAL_RETRY_PASS, env: FULLY_ENABLED,
    });

    const byId = Object.fromEntries(out.stuck.map((r) => [r.id, r]));
    expect(byId['lead-migrated'].disposition).toBe(REAP_DISPOSITION.EXCLUDED_MIGRATED);

    // Before the fix this was ['rm-1', 'rm-mig'].
    expect(scenario.delivered()).toEqual(['rm-1']);
    expect(scenario.delivered()).not.toContain('rm-mig');
    expect(scenario.attemptRow('att-migrated').status).toBe('error');
    expect(scenario.attemptRow('att-migrated').lease_version || 0).toBe(0);
  });

  it('a due attempt belonging to a lead that is not stuck at all is not swept up by the reaper pass', async () => {
    // The third class the QA named. A lead that is still moving is none of this
    // job's business, and an unscoped batch pass re-drove its attempts too,
    // simply because the reaper happened to run. Draining the whole due queue
    // is the scheduler's job (nativeRetryScheduler.js), on its own timer.
    const scenario = makeWireScenario({
      leads: [
        stalledAtRoutingLead({ id: 'lead-resumable' }),
        stalledAtRoutingLead({ id: 'lead-moving', updated_date: iso(STALLED - 60_000) }),
      ],
      attempts: [
        answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' }),
        answeredAttempt({ id: 'att-moving', lead_id: 'lead-moving', sub_delivery_id: 'sd-mov', route_member_id: 'rm-mov' }),
      ],
    });

    const out = await runStuckLeadReaperPass(scenario.db, {
      nowMs: STALLED, retryPass: REAL_RETRY_PASS, env: FULLY_ENABLED,
    });

    expect(out.stuck.map((r) => r.id)).toEqual(['lead-resumable']);
    expect(scenario.delivered()).toEqual(['rm-1']);
  });

  it('the scoped parameter really is what excludes them: the same pass unscoped delivers all three', async () => {
    // The control. This is the pre-fix behaviour, reproduced deliberately by
    // calling the batch worker the way the reaper used to call it, so the two
    // tests above are shown to be measuring the scoping and not some unrelated
    // property of the fixture (for instance an attempt that was never due).
    const scenario = makeWireScenario({
      leads: [stalledAtRoutingLead({ id: 'lead-resumable' })],
      attempts: [
        answeredAttempt({ id: 'att-resumable', lead_id: 'lead-resumable', sub_delivery_id: 'sd-1', route_member_id: 'rm-1' }),
        answeredAttempt({
          id: 'att-ambiguous', lead_id: 'lead-ambiguous', sub_delivery_id: 'sd-amb', route_member_id: 'rm-amb',
          http_status: null, error_class: 'fetch failed',
        }),
        answeredAttempt({ id: 'att-migrated', lead_id: 'lead-migrated', sub_delivery_id: 'sd-mig', route_member_id: 'rm-mig' }),
      ],
    });

    const unscoped = await runNativeRetryPass(scenario.db, { workerId: 'control', validateTarget: ALLOW_ALL_TARGETS });

    expect(unscoped.ran).toBe(true);
    // Every due attempt in the system, which is exactly the batch worker's
    // documented job and exactly why the reaper must not call it unscoped.
    expect(scenario.delivered().sort()).toEqual(['rm-1', 'rm-amb', 'rm-mig']);
    expect(unscoped.scoped_lead_ids).toBeUndefined();
  });
});

// ── S1: what concurrency actually guarantees ───────────────────────────────

describe('S1: concurrent writing passes serialize, and the safety claim is stated accurately', () => {
  it('two genuinely concurrent passes produce exactly one call into the retry worker', async () => {
    const { leads, attempts } = resumableSetFor();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    const [first, second] = await Promise.all([
      runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED }),
      runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED }),
    ]);

    // One ran, one was skipped. Before this, both ran and both called in.
    const ran = [first, second].filter((r) => r.ran === true);
    const skipped = [first, second].filter((r) => r.skipped === 'already_running');
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].stuck).toEqual([]);
    expect(retryPass).toHaveBeenCalledTimes(1);
    expect(ran[0].resumed.routing_runs).toBe(1);
  });

  it('a dry run is never blocked by a writing pass, because it writes and sends nothing', async () => {
    const { leads, attempts } = resumableSetFor();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    const [write, read] = await Promise.all([
      runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED }),
      runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: FULLY_ENABLED, write: false }),
    ]);

    expect(write.ran).toBe(true);
    expect(read.ran).toBe(true);
    expect(read.stuck.length).toBeGreaterThan(0);
    expect(retryPass).toHaveBeenCalledTimes(1);
  });

  it('the lock is released even when a pass throws, so one failure cannot wedge the reaper', async () => {
    const db = makeDb({ leads: [stalledAtRoutingLead()], attempts: [answeredAttempt()] });
    const boom = vi.fn(async () => { throw new Error('retry worker exploded'); });

    await expect(runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: boom, env: FULLY_ENABLED }))
      .rejects.toThrow('retry worker exploded');

    const after = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: FULLY_ENABLED });
    expect(after.ran).toBe(true);
  });

  it('the module states what is guaranteed rather than claiming a single global routing run', () => {
    const raw = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/functions/reapStuckLeads.js'),
      'utf8',
    );
    // The accurate claim, kept in the source so the next reader is not misled:
    // per-attempt exclusivity comes from the store's CAS lease and at-most-one
    // sale from the engine's winner claim, one layer below this file.
    expect(raw).toMatch(/CAS\s+lease/);
    expect(raw).toMatch(/winner claim/);
    // And the inaccurate one is gone.
    expect(raw).not.toMatch(/EXACTLY ONE routing run/);
  });
});

// ── S2: a dead letter with no answer is an unknown outcome, not a clean one ──

describe('S2: a dead-lettered attempt with no HTTP status is treated as an unknown outcome', () => {
  it('holds it rather than reporting that nothing was delivered', () => {
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead(),
      attempts: [answeredAttempt({
        status: 'dead_letter', http_status: null, error_class: 'timeout', next_retry_at: null,
      })],
      nowMs: STALLED,
    });
    expect(verdict.disposition).toBe(REAP_DISPOSITION.AMBIGUOUS_HOLD);
    expect(verdict.resumable).toBe(false);
    // The specific claim that was wrong. An attempt that timed out repeatedly
    // may well have been received and processed before the connection died.
    expect(verdict.reason).not.toMatch(/nothing was delivered/i);
  });

  it('a dead letter that DID get an answer is still a known outcome and is not held on that basis', () => {
    // The destination answered 400. Nothing is unknown about it, so this must
    // not be swept into the ambiguous bucket by an over-broad rule.
    expect(hasUnknownOutcome(stalledAtRoutingLead(), [answeredAttempt({
      status: 'dead_letter', http_status: 400, next_retry_at: null,
    })])).toBe(false);
  });

  it('is reported through hasUnknownOutcome directly, for both the null and undefined shapes', () => {
    for (const http_status of [null, undefined]) {
      expect(hasUnknownOutcome(stalledAtRoutingLead(), [answeredAttempt({
        status: 'dead_letter', http_status, next_retry_at: null,
      })])).toBe(true);
    }
  });
});

// ── S3: the scan cannot silently hide the oldest stuck leads ────────────────

describe('S3: the scan finds the oldest stuck leads regardless of table size, and says when it truncated', () => {
  it('orders oldest first, so a cap truncates the newest rows rather than the stuck ones', async () => {
    const seen = [];
    const db = makeDb({ leads: [crashedBeforeRoutingLead()] });
    const inner = db.entities.Lead.filter;
    db.entities.Lead.filter = async (where, order, limit, skip) => {
      seen.push(order);
      return inner(where, order, limit, skip);
    };

    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    // '-created_date' (newest first) is what made the oldest stuck leads
    // invisible past the cap. Stuck leads are old by definition.
    expect(seen.every((o) => o === 'created_date')).toBe(true);
    expect(seen).not.toContain('-created_date');
  });

  it('the oldest stuck lead is still found when the queue is larger than one page', async () => {
    // One genuinely old stuck lead buried under a page and a half of newer
    // queued rows that are still moving. Newest-first paging would have put it
    // last; oldest-first puts it first.
    const oldest = crashedBeforeRoutingLead({
      id: 'lead-oldest', created_date: iso(T0 - 30 * 24 * 3600 * 1000), updated_date: iso(T0 - 30 * 24 * 3600 * 1000),
    });
    const newer = Array.from({ length: 600 }, (_, i) => stalledAtRoutingLead({
      id: `moving-${i}`, created_date: iso(T0 + i), updated_date: iso(STALLED - 60_000),
    }));
    const db = makeDb({ leads: [oldest, ...newer] });
    // The in-memory Lead.filter ignores sort, so order the rows the way the
    // real repository's ORDER BY created_date ASC would return them.
    db.rows.leads.sort((a, b) => Date.parse(a.created_date) - Date.parse(b.created_date));

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    expect(out.scanned).toBe(601);
    expect(out.stuck.map((r) => r.id)).toEqual(['lead-oldest']);
    expect(out.scan.truncated).toBe(false);
  });

  it('reports truncation explicitly when the cap is hit, instead of losing rows silently', async () => {
    // A queued backlog larger than MAX_SCAN. The pass still does bounded work,
    // but it now says so.
    const many = Array.from({ length: 5200 }, (_, i) => stalledAtRoutingLead({
      id: `q-${i}`, created_date: iso(T0 + i), updated_date: iso(STALLED - 60_000),
    }));
    const db = makeDb({ leads: many });

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    expect(out.scan.truncated).toBe(true);
    expect(out.scan.limit).toBe(5000);
    expect(out.scanned).toBe(5000);
  });
});

// ── The resume predicate itself ───────────────────────────────────────────

describe('an attempt is only resumable when the retry worker will actually pick it up and its last outcome is known', () => {
  it('accepts an errored attempt with a real status code and a due retry time', () => {
    expect(isSafelyRetryableAttempt(answeredAttempt())).toBe(true);
  });

  it.each([
    ['no next_retry_at, so listDue will never return it', { next_retry_at: null }],
    ['a null http_status, so the prior outcome is unknown', { http_status: null }],
    ['a non-numeric http_status', { http_status: '502' }],
    ['a status listDue does not select', { status: 'dead_letter' }],
    ['an attempt still pending', { status: 'pending' }],
    ['an already accepted attempt', { status: 'accepted', http_status: 200 }],
    ['a superseded attempt', { status: 'superseded' }],
  ])('refuses %s', (_label, override) => {
    expect(isSafelyRetryableAttempt(answeredAttempt(override))).toBe(false);
  });

  it('refuses a missing attempt rather than throwing', () => {
    expect(isSafelyRetryableAttempt(null)).toBe(false);
    expect(isSafelyRetryableAttempt(undefined)).toBe(false);
  });
});

// ── Scope of the scan ─────────────────────────────────────────────────────

describe('the scan is scoped to leads that are genuinely stuck', () => {
  it('ignores a lead that has settled, whatever its business status', () => {
    for (const status of [LEAD_STATUS.SOLD, LEAD_STATUS.UNSOLD, LEAD_STATUS.REJECTED, LEAD_STATUS.DISQUALIFIED]) {
      expect(classifyStuckLead({
        lead: { lead_status: status, processing_state: PROCESSING_STATE.SETTLED, created_date: iso(T0) },
        nowMs: STALLED,
      })).toBeNull();
    }
  });

  it('ignores a queued lead that has settled its machine state, which is a queue-route lead and not a stuck one', () => {
    expect(classifyStuckLead({
      lead: { lead_status: LEAD_STATUS.QUEUED, processing_state: PROCESSING_STATE.SETTLED, created_date: iso(T0) },
      nowMs: STALLED,
    })).toBeNull();
  });

  it('ignores a lead whose processing_state is still advancing', () => {
    expect(classifyStuckLead({
      lead: stalledAtRoutingLead({ updated_date: iso(STALLED - 60_000) }),
      nowMs: STALLED,
    })).toBeNull();
  });

  it('surfaces a lead already at failed even before the window elapses, because D1 calls that a stuck lead', () => {
    const verdict = classifyStuckLead({
      lead: stalledAtRoutingLead({
        processing_state: PROCESSING_STATE.FAILED,
        updated_date: iso(STALLED - 60_000),
      }),
      nowMs: STALLED,
    });
    expect(verdict).not.toBeNull();
    expect(verdict.actionable).toBe(false);
  });

  it('does not query delivery attempts for a lead that is not a candidate', async () => {
    // A large queued backlog is normal. Spending an attempt query on every row
    // in it would turn a sixty second scheduler tick into a table scan, so the
    // cheap predicate runs first and the expensive read only happens for leads
    // that are genuinely stuck.
    const moving = Array.from({ length: 20 }, (_, i) => stalledAtRoutingLead({
      id: `moving-${i}`, updated_date: iso(STALLED - 60_000),
    }));
    const db = makeDb({ leads: [...moving, crashedBeforeRoutingLead()] });
    let attemptQueries = 0;
    const inner = db.entities.DeliveryAttempt.filter;
    db.entities.DeliveryAttempt.filter = async (where) => { attemptQueries += 1; return inner(where); };

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

    expect(out.scanned).toBe(21);
    expect(out.stuck).toHaveLength(1);
    expect(attemptQueries).toBe(1);
  });

  it('reads progress from the newest durable evidence on the row', () => {
    expect(lastProgressMs({ created_date: iso(T0) })).toBe(T0);
    expect(lastProgressMs({ created_date: iso(T0), updated_date: iso(T0 + 5000) })).toBe(T0 + 5000);
    expect(lastProgressMs({ created_date: iso(T0), processed_at: iso(T0 + 9000) })).toBe(T0 + 9000);
    expect(lastProgressMs({ created_date: 'nonsense' })).toBeNull();
  });

  it('never resumes a lead the migration owns, even when everything else about it looks resumable', () => {
    const verdict = classifyStuckLead({
      lead: {
        id: 'x',
        lead_status: LEAD_STATUS.QUEUED,
        processing_state: PROCESSING_STATE.ROUTING,
        migrated_at: iso(T0),
        created_date: iso(T0 - 1000),
        updated_date: iso(T0),
      },
      attempts: [answeredAttempt({ lead_id: 'x' })],
      nowMs: STALLED,
    });
    expect(verdict.resumable).toBe(false);
  });
});

// ── Structural guarantees ─────────────────────────────────────────────────

describe('the reaper cannot become an unsafe re-entry point by a later edit', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.join(here, '../src/functions/reapStuckLeads.js'), 'utf8');

  // Executable lines only. The module comment names the unsafe paths on purpose
  // (explaining why processLead and resubmitLead are NOT used, and what
  // reserveAndDeliver guarantees underneath the retry worker), so matching the
  // whole file would fail on its own documentation. What must not appear is a
  // call or an import.
  const source = raw
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');

  it('does not import or call processLead, which would create a second lead row', () => {
    // resubmitLead.js replays raw_payload through processLead as a fresh
    // intake. deriveTransportKey buckets a content hash by the minute, so a
    // replay minutes later derives a different transport key, commits a second
    // receipt, and processLead creates a second Lead that routes and can sell
    // independently of the first. That is the duplicate commercial send
    // CONTRACT.md section 7 forbids, and this pins that it is not wired in.
    expect(source).not.toMatch(/processLead/);
    expect(source).not.toMatch(/resubmitLead/);
    expect(source).not.toMatch(/getFunction\(/);
  });

  it('resumes only through the existing native retry runner', () => {
    expect(source).toContain("from '../lib/nativeRetryRunner.js'");
    // No direct import of the routing engine bundle: a resume that reached past
    // the retry worker into the engine would bypass the worker's isLeadSold
    // pre-check and its lease.
    expect(source).not.toMatch(/routingEngine\.generated/);
    expect(source).not.toMatch(/reserveAndDeliver/);
  });

  it('reaches the migration exclusion through isExcludedFromRedrive rather than a marker presence test', () => {
    expect(source).toContain('isExcludedFromRedrive');
    // A bare Boolean(lead.migrated_at) or lead.migrated_at truthiness check
    // would silence every live failure a migrated lead ever has again.
    expect(source).not.toMatch(/Boolean\(\s*lead\??\.?migrated_at/);
    expect(source).not.toMatch(/if\s*\(\s*lead\.migrated_at\s*\)/);
  });

  it('writes lead state only through the vocabulary helper that cannot touch money or final_status', () => {
    expect(source).toContain('newVocabularyFields');
    expect(source).not.toMatch(/statusPatch\(/);
  });
});

// ── Environment hygiene ───────────────────────────────────────────────────

describe('the module reads the real environment when none is injected', () => {
  const original = process.env[STUCK_LEAD_REAPER_FLAG];

  beforeEach(() => { delete process.env[STUCK_LEAD_REAPER_FLAG]; });
  afterEach(() => {
    if (original === undefined) delete process.env[STUCK_LEAD_REAPER_FLAG];
    else process.env[STUCK_LEAD_REAPER_FLAG] = original;
  });

  it('defaults to off against the real process environment', () => {
    expect(isReaperEnabled()).toBe(false);
  });

  it('arms against the real process environment when the operator sets it', () => {
    process.env[STUCK_LEAD_REAPER_FLAG] = 'true';
    expect(isReaperEnabled()).toBe(true);
  });
});
