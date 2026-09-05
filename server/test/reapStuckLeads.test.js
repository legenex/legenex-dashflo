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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  STALL_THRESHOLD_MS,
  REAP_DISPOSITION,
  REAP_REASON,
  isReaperEnabled,
  classifyStuckLead,
  hasUnknownOutcome,
  isSafelyRetryableAttempt,
  lastProgressMs,
  runStuckLeadReaperPass,
  startStuckLeadReaper,
} from '../src/functions/reapStuckLeads.js';

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

const ENABLED = { [STUCK_LEAD_REAPER_FLAG]: 'true' };

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
  function resumableSet() {
    const leads = ['a', 'b', 'c'].map((k) => stalledAtRoutingLead({ id: `lead-${k}`, lead_id: 9100 + k.charCodeAt(0) }));
    const attempts = leads.flatMap((l, i) => [
      answeredAttempt({ id: `attempt-${i}-1`, lead_id: l.id }),
      // A second due attempt on the same lead. A per-lead or per-attempt call
      // into the retry worker would fan this out; the pass must not.
      answeredAttempt({ id: `attempt-${i}-2`, lead_id: l.id, sub_delivery_id: 'sd-2', http_status: 503 }),
    ]);
    return { leads, attempts };
  }

  it('hands the whole batch to the retry worker in exactly one routing run', async () => {
    const { leads, attempts } = resumableSet();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    const out = await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });

    expect(out.resumed.lead_ids).toEqual(['lead-a', 'lead-b', 'lead-c']);
    // Three leads, six due attempts, one routing run.
    expect(retryPass).toHaveBeenCalledTimes(1);
    expect(out.resumed.routing_runs).toBe(1);
  });

  it('a second pass immediately after does not produce a second routing run for the same leads', async () => {
    const { leads, attempts } = resumableSet();
    const db = makeDb({ leads, attempts });
    const retryPass = makeRetryPassSpy();

    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, env: ENABLED });
    expect(retryPass).toHaveBeenCalledTimes(1);

    // The resume marker bumped updated_date, which resets each lead's stall
    // clock. A scheduler ticking a minute later therefore sees work in
    // progress, not a stalled lead, and does not re-drive it. This is what
    // stops "recovered" from becoming "recovered repeatedly".
    const second = await runStuckLeadReaperPass(db, { nowMs: STALLED + 60_000, retryPass, env: ENABLED });
    expect(second.stuck).toHaveLength(0);
    expect(second.resumed.routing_runs).toBe(0);
    expect(retryPass).toHaveBeenCalledTimes(1);
  });

  it('the resume marker keeps the lead at queued and records why it was resumed', async () => {
    const db = makeDb({ leads: [stalledAtRoutingLead()], attempts: [answeredAttempt()] });
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass: makeRetryPassSpy(), env: ENABLED });

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
    await runStuckLeadReaperPass(db, { nowMs: STALLED, retryPass, workerId: 'reaper-test', env: ENABLED });

    expect(retryPass).toHaveBeenCalledWith(db, { workerId: 'reaper-test' });
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
