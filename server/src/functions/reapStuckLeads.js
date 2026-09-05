// Stuck lead reaper and the Stuck Leads queue feed.
// Work unit W4-REAPER, forge-pack/CONTRACT.md D1 and Section 7.
//
// D1, verbatim: "processing_state is a separate internal field: received,
// validating, routing, settled, failed, ambiguous. A crash never changes
// lead_status. A lead at queued + failed is a stuck lead, surfaced in the
// Stuck Leads queue and picked up by the reaper."
//
// This module is that reaper. It finds leads at lead_status queued whose
// processing_state has not advanced within fifteen minutes, decides, from
// durable evidence only, whether each one can be resumed without any chance of
// a second commercial send, resumes exactly the class that can, and surfaces
// everything else with the stage it stalled at.
//
//
// THE SHAPE OF THE PROBLEM, AND WHY THIS FILE REFUSES MORE THAN IT RESUMES
// ------------------------------------------------------------------------
// Section 7 lists "duplicate commercial sends or sales" and "unsafe retries"
// as never-acceptable at cutover. A reaper is, by construction, the one job in
// this system whose whole purpose is to re-touch leads that already went part
// way through a commercial pipeline. So the default answer here is no, and
// every yes has to be justified from a durable record that is joined to the
// lead itself.
//
// The four questions this file answers, in order, for every stuck lead:
//
//   1. Did the status migration put this lead in the state it is in right now?
//      Answered by isExcludedFromRedrive in lib/leadStatus.js. Not by a
//      migrated_at presence test: see that module's own comment for why the
//      marker is permanent and a presence test would hide every genuine live
//      failure a migrated lead ever has again.
//   2. Is the outcome of anything this lead already sent unknown? If so it is
//      never resumed, in any mode, for any reason. It surfaces for
//      reconciliation instead.
//   3. Has this lead already been sold? If so nothing is resumed. Money is
//      read from the write-once flags (D2), never from a status.
//   4. Is there an already-built, already-tested re-entry point that can
//      resume this exact stage without re-posting the lead? If yes, use it. If
//      no, mark the lead as stuck and let a human decide.
//
//
// THE RE-ENTRY POINT, AND THE GAP
// -------------------------------
// The unit spec required finding an existing safe re-entry rather than
// inventing one, because AGENTS.md invariant 3 promises "a committed receipt is
// replayable after a crash. Replay cannot double-deliver or double-bill." Two
// candidates exist in this repository and only one of them is safe.
//
//   USABLE: lib/nativeRetryRunner.js runNativeRetryPass. This is the real
//   thing. It re-enters through the engine's reserveAndDeliver, which is the
//   identical cap-reservation, per-lead winner-claim and wallet-debit
//   primitive the primary send uses, and it reuses the stored
//   run_idempotency_key so the outbound Idempotency-Key header a retry sends
//   is byte-identical to the one the first attempt sent. Its worker loop also
//   checks isLeadSold before deliverFn is ever called, so a lead another
//   destination already won is terminalized as superseded rather than sent
//   again. That is a genuine exactly-once mechanism and this file delegates to
//   it rather than reimplementing any part of it.
//
//   NOT USABLE: functions/resubmitLead.js, which replays lead.raw_payload
//   through processLead. That is a fresh intake, not a resume. deriveTransportKey
//   in lib/receipts.js buckets a content hash by the minute for a poster that
//   sends no idempotency key, so a replay minutes later derives a DIFFERENT
//   transport key, commits a SECOND receipt, and processLead creates a SECOND
//   Lead row which then routes and can sell independently of the first. That is
//   precisely the duplicate commercial send Section 7 forbids. It is not used
//   here and must not be wired in later as a convenience.
//
// THE GAP, stated plainly because it is a finding and not an omission: there
// is no callable function anywhere in this repository that re-enters
// validation or routing for an ALREADY CREATED Lead from a pre-routing
// checkpoint. Every path into that part of the pipeline goes through
// processLead.js, which always creates a new Lead row and which this unit is
// forbidden from touching. So a lead killed between its durable write and
// routing cannot be automatically re-driven by anything that exists today. The
// reaper does the only safe thing available: it proves the lead was not lost,
// records the exact stage it stalled at, promotes it into D1's Stuck Leads
// queue where an operator can see it, and never re-posts it.
//
// A SECOND GAP, in the same family: lead_receipts carries no lead_id and Lead
// carries no receipt_id (see server/src/db/receiptSchema.js). There is no join
// between a stuck lead and its durable receipt, so this file CANNOT read that
// receipt's effects_applied flag for a specific lead, and it does not pretend
// to. "Never resends where a prior receipt is possible" is therefore enforced
// from the durable records that ARE joined to the lead: DeliveryAttempt rows,
// the legacy leadbyte_request/leadbyte_response pair, and the write-once sale
// flags. Those are listed field by field in hasUnknownOutcome below.
//
//
// THE AMBIGUOUS-CASCADE DEFECT THIS DESIGN DOES NOT ASSUME AWAY
// ------------------------------------------------------------
// forge-pack/state/BLOCKERS.md records, verified by direct execution against
// the real engine, that client/src/lib/distribution/distribute.js does not stop
// its per-candidate loop on an ambiguous outcome, and that distributeRun.js's
// toRunStatus only classifies a run ambiguous when error_class is exactly
// 'timeout' or 'network_error', so a real undici connection drop ("fetch
// failed") resolves as a clean miss and stays cascade-eligible. None of those
// files are in this unit's ownership and none of them are fixed here.
//
// The consequence for this file is concrete: processing_state === 'ambiguous'
// is NOT a trustworthy sole signal that ambiguity was detected upstream,
// because the upstream classifier under-detects it. So the reaper derives
// ambiguity itself, from the attempt rows, and treats a missing http_status as
// an unknown outcome regardless of how error_class was spelled. That is
// deliberately stricter than the engine's own classifier and it is the
// mitigation for a defect this unit cannot repair.
//
//
// ROLLBACK
// --------
// STUCK_LEAD_REAPER_ENABLED. Default OFF. With the variable unset or set to
// anything other than the exact string "true", the HTTP entry point performs no
// scan and no write and says so, and startStuckLeadReaper creates no timer.
// This is a real checked gate on both entry points, not a comment, and it is
// the unit's stated rollback: unset the variable and the reaper is inert.

import { requireUser } from './_runtime.js';
import { runNativeRetryPass } from '../lib/nativeRetryRunner.js';
import {
  LEAD_STATUS,
  LEGACY_STATUS,
  PROCESSING_STATE,
  isExcludedFromRedrive,
  newVocabularyFields,
} from '../lib/leadStatus.js';

// ── Gate ──────────────────────────────────────────────────────────────────

export const STUCK_LEAD_REAPER_FLAG = 'STUCK_LEAD_REAPER_ENABLED';

// Exact-string comparison, the same shape nativeRetryWorker.js already uses for
// NATIVE_RETRY_WORKER_ENABLED. "1", "yes", "TRUE" and an empty value all leave
// the reaper off, so a half-set variable fails closed rather than half-arming a
// job that touches commercial state.
export function isReaperEnabled(env = process.env) {
  return env[STUCK_LEAD_REAPER_FLAG] === 'true';
}

// ── Thresholds ────────────────────────────────────────────────────────────

// D1's fifteen minutes.
export const STALL_THRESHOLD_MS = 15 * 60 * 1000;

// Upper bound on one pass, so a pathological backlog cannot turn a scheduled
// tick into an unbounded scan.
const MAX_SCAN = 5000;
const PAGE_SIZE = 500;

// The processing states that describe unfinished work. `settled` is finished by
// definition and is never stuck.
const UNSETTLED_STATES = Object.freeze([
  PROCESSING_STATE.RECEIVED,
  PROCESSING_STATE.VALIDATING,
  PROCESSING_STATE.ROUTING,
  PROCESSING_STATE.FAILED,
  PROCESSING_STATE.AMBIGUOUS,
]);

// The two states D1 names as a stuck lead in their own right. A lead sitting in
// one of these is surfaced in the queue immediately, without waiting out the
// stall window again, because the window has already been waited out once by
// whatever put it there.
const TERMINALLY_STUCK_STATES = Object.freeze([
  PROCESSING_STATE.FAILED,
  PROCESSING_STATE.AMBIGUOUS,
]);

// ── Dispositions ──────────────────────────────────────────────────────────
//
// Exactly one of these is assigned to every lead the scan returns. They are the
// vocabulary the Stuck Leads card renders, so they are stable machine codes in
// the same SCREAMING_SNAKE convention the rest of this repository uses for a
// machine reason.
export const REAP_DISPOSITION = Object.freeze({
  // The migration put this lead in the state it is in, and nothing has happened
  // to it since. Never touched. D4 risk 3.
  EXCLUDED_MIGRATED: 'EXCLUDED_MIGRATED',
  // Something this lead sent may have been received and we cannot prove it was
  // not. Never resumed. Surfaced for human reconciliation.
  AMBIGUOUS_HOLD: 'AMBIGUOUS_HOLD',
  // Already sold. Nothing to resume; a resume could only ever produce a second
  // sale.
  ALREADY_SOLD: 'ALREADY_SOLD',
  // A durable, retryable delivery attempt exists whose outcome is known, so the
  // existing native retry worker can safely re-drive it.
  RESUME_DELIVERY: 'RESUME_DELIVERY',
  // Stalled before anything was sent. Nothing was delivered and nothing was
  // billed, but no callable re-entry point exists for this stage. Marked as a
  // stuck lead and surfaced.
  NO_SAFE_REENTRY: 'NO_SAFE_REENTRY',
});

// Machine reason codes this module writes into Lead.status_reason. Same
// convention as processLead.js's own codes (QUEUE_ROUTE, MISSING_CERT,
// INTERNAL_ERROR and the rest): a stable extend-only code, never prose.
export const REAP_REASON = Object.freeze({
  STALLED_PRE_ROUTING: 'REAPER_STALLED_PRE_ROUTING',
  RESUMED: 'REAPER_RESUMED',
});

// ── Durable-evidence helpers ──────────────────────────────────────────────

function parseMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? null : parsed;
}

// The newest durable evidence that ANYTHING happened to this lead.
//
// updated_date is included here, and that is not a contradiction of
// lib/leadStatus.js's warning against it. That module warns against comparing
// updated_date to migrated_at, because the repository bumps updated_date on the
// migration's own write and the comparison would mark every migrated row
// eligible the instant the backfill finished. The question HERE is a different
// one: "has anything written this row lately", and for that question row
// bookkeeping is exactly the right signal, because a lead being actively
// processed has its row written repeatedly and a lead whose process died does
// not. created_date is the floor, so a lead that was created and never touched
// again still ages out of the window.
export function lastProgressMs(lead) {
  const candidates = [
    parseMs(lead?.processed_at),
    parseMs(lead?.leadbyte_outcome_at),
    parseMs(lead?.updated_date),
    parseMs(lead?.created_date),
  ].filter((v) => v !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

// DeliveryAttempt statuses that mean a request may have reached a buyer and we
// have no recorded answer. deliveryStore.js's own comment says attempts are
// "created BEFORE send so a crash mid-send leaves a durable record to recover",
// which is exactly why `pending` cannot be read as "nothing left the building".
const IN_FLIGHT_ATTEMPT_STATUSES = Object.freeze(['pending', 'sent', 'queued']);

// True when any durable record joined to this lead shows an outbound action
// whose outcome cannot be proven.
//
// This is the predicate that implements "never resends where a prior receipt is
// possible". Every clause is a record the reaper can actually read for a
// specific lead; the lead_receipts table is deliberately absent because it
// carries no lead_id (see the module comment).
export function hasUnknownOutcome(lead, attempts = []) {
  // 1. The pipeline itself already said so. Trusted when present, but never
  //    relied on alone: BLOCKERS.md records that the upstream classifier
  //    under-detects this exact condition.
  if (lead?.processing_state === PROCESSING_STATE.AMBIGUOUS) return true;

  // 2. A native attempt row that was created and never concluded.
  for (const attempt of attempts) {
    const status = String(attempt?.status || 'pending');
    if (IN_FLIGHT_ATTEMPT_STATUSES.includes(status)) return true;
    // 3. A failed attempt with no HTTP status. The request left this process
    //    and no response line came back, so the buyer may or may not have it.
    //    Checked on http_status rather than on error_class precisely because
    //    BLOCKERS.md item 3 is that a real undici connection drop throws
    //    "fetch failed" and matches neither of the two error_class strings the
    //    engine's own ambiguity check looks for. A missing status code is the
    //    property that actually holds.
    if (status === 'error' && (attempt?.http_status === null || attempt?.http_status === undefined)) return true;
  }

  // 4. The legacy LeadByte path, which is the path carrying real traffic while
  //    distribution_mode is legacy_only. processLead.js writes leadbyte_request
  //    immediately before the post and leadbyte_response after it, so a request
  //    with no response is a post whose outcome is unknown.
  const hasRequest = Boolean(String(lead?.leadbyte_request || '').trim());
  const hasResponse = Boolean(String(lead?.leadbyte_response || '').trim());
  if (hasRequest && !hasResponse) return true;

  return false;
}

// A delivery attempt the native retry worker will actually pick up AND whose
// prior outcome is known.
//
// Both halves matter. deliveryStore.js's listDue selects only status 'error'
// with a due next_retry_at, so an attempt missing either is invisible to the
// worker and claiming it is resumable would be a lie. And http_status must be a
// real number, which is the proof that the previous send reached the
// destination and was answered, so re-sending it cannot be the second half of a
// double delivery.
export function isSafelyRetryableAttempt(attempt) {
  if (!attempt) return false;
  if (String(attempt.status) !== 'error') return false;
  if (typeof attempt.http_status !== 'number') return false;
  return Boolean(attempt.next_retry_at);
}

// Money is read from the write-once flags, never from a status (D2). The
// attempt rows are the second half of the same question: a destination that
// answered `accepted` delivered this lead, whether or not the sale flags were
// latched onto the row before the process died. Re-driving the lead's other
// attempts after that is a cross-destination cascade past a completed sale,
// which is the shape of BLOCKERS.md defect 1. The retry worker's own isLeadSold
// pre-check would terminalize such an attempt as superseded rather than send
// it, so refusing here is consistent with the engine's behaviour and not a
// stricter rule invented by this file.
function isAlreadySold(lead, attempts = []) {
  if (lead?.is_sold === true) return true;
  return attempts.some((a) => String(a?.status) === 'accepted');
}

// ── Classification ────────────────────────────────────────────────────────

// Pure. Given a lead, its delivery attempts and the clock, decide what the
// reaper may do with it. No IO, no writes, so the whole safety argument for
// this unit is testable without a database.
//
// Returns null when the lead is not a stuck lead at all, so a caller can treat
// null as "leave it alone" without reading a flag.
// The cheap half of the classification: is this row even worth looking at.
// Reads nothing but the lead itself, so the pass can apply it before spending a
// DeliveryAttempt query per lead. Returns null for a lead that is not stuck.
export function stuckCandidate(lead, { nowMs = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  if (!lead) return null;

  // D1: a crash never changes lead_status. So a stuck lead is, without
  // exception, still at queued. Anything that has moved off queued has settled
  // into a business outcome and is not this job's concern.
  if (lead.lead_status !== LEAD_STATUS.QUEUED) return null;

  const stage = String(lead.processing_state || '');
  if (!UNSETTLED_STATES.includes(stage)) return null;

  const progressMs = lastProgressMs(lead);
  const stalledMs = progressMs === null ? null : Math.max(0, nowMs - progressMs);
  const stalled = stalledMs !== null && stalledMs >= thresholdMs;

  // Surfaced if it is either already in a D1 stuck state or has aged out of the
  // window. Acted upon only once it has aged out: a lead the reaper marked
  // sixty seconds ago is visible in the queue but is not re-processed.
  if (!stalled && !TERMINALLY_STUCK_STATES.includes(stage)) return null;

  return {
    stage,
    stalled_ms: stalledMs,
    last_progress_at: progressMs === null ? null : new Date(progressMs).toISOString(),
    actionable: stalled,
  };
}

export function classifyStuckLead({ lead, attempts = [], nowMs = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  const base = stuckCandidate(lead, { nowMs, thresholdMs });
  if (!base) return null;
  const { stage } = base;

  // 1. D4 risk 3. The migration must not re-drive historical errors into live
  //    distribution. isExcludedFromRedrive is the single predicate that answers
  //    this and it is called, not reimplemented: it distinguishes a lead whose
  //    current failed state IS the one the migration left it in from a migrated
  //    lead that has since failed for real on a live path. A naive
  //    Boolean(migrated_at) here would hide every genuine live failure a
  //    migrated lead ever has again, because migrated_at is never cleared.
  if (isExcludedFromRedrive(lead)) {
    return {
      ...base,
      disposition: REAP_DISPOSITION.EXCLUDED_MIGRATED,
      resumable: false,
      actionable: false,
      reason: 'This lead has carried the status-migration marker since before any live activity, so its failed state is the one the migration created. Re-driving it would post pre-cutover data to a real buyer.',
    };
  }

  // 2. Unknown outcome. Absolute, and checked before everything below it so no
  //    later branch can talk its way past it.
  if (hasUnknownOutcome(lead, attempts)) {
    return {
      ...base,
      disposition: REAP_DISPOSITION.AMBIGUOUS_HOLD,
      resumable: false,
      reason: 'A delivery for this lead may have been received and there is no recorded response proving otherwise. It is held for human reconciliation and is never resumed automatically, because a resume could produce a second sale of the same lead.',
    };
  }

  // 3. Already sold. Nothing a resume could add, and everything it could break.
  if (isAlreadySold(lead, attempts)) {
    return {
      ...base,
      disposition: REAP_DISPOSITION.ALREADY_SOLD,
      resumable: false,
      reason: 'This lead already carries a completed sale, either on its write-once flags or as an accepted delivery attempt. Resuming it could only ever produce a second sale.',
    };
  }

  // 4. A real, already-built re-entry point covers this one.
  const retryable = attempts.filter(isSafelyRetryableAttempt);
  if (retryable.length > 0) {
    return {
      ...base,
      disposition: REAP_DISPOSITION.RESUME_DELIVERY,
      resumable: true,
      retryable_attempt_ids: retryable.map((a) => a.id).filter(Boolean),
      reason: `${retryable.length} delivery attempt(s) failed with a recorded HTTP status and are due for retry. The native retry worker re-sends them through the same reservation, winner-claim and idempotency-key path the primary send used.`,
    };
  }

  // 5. Everything else. Stalled before anything was sent, with no mechanism
  //    that can re-enter this stage without re-posting the lead.
  return {
    ...base,
    disposition: REAP_DISPOSITION.NO_SAFE_REENTRY,
    resumable: false,
    reason: `This lead stalled at processing_state "${stage}" with no outbound attempt on record. Nothing was delivered and nothing was billed, but no callable re-entry point exists for this stage without re-posting the lead as a new intake, which would create a second lead and risk a duplicate send. It is surfaced for an operator instead.`,
  };
}

// ── The pass ──────────────────────────────────────────────────────────────

async function loadQueuedLeads(db) {
  const out = [];
  let skip = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await db.entities.Lead.filter({ lead_status: LEAD_STATUS.QUEUED }, '-created_date', PAGE_SIZE, skip);
    const rows = Array.isArray(batch) ? batch : [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE || out.length >= MAX_SCAN) break;
    skip += PAGE_SIZE;
  }
  return out.slice(0, MAX_SCAN);
}

async function loadAttempts(db, leadId) {
  if (!db?.entities?.DeliveryAttempt) return [];
  const rows = await db.entities.DeliveryAttempt.filter({ lead_id: leadId });
  return Array.isArray(rows) ? rows : [];
}

// What the operator sees. Deliberately free of raw contact data: a stuck lead
// queue is an operational surface and does not need the person's email or
// phone to do its job (invariant 4's spirit, and cross-buyer/supplier leakage
// under Section 7).
function toCardRow(lead, verdict) {
  return {
    id: lead.id,
    lead_id: lead.lead_id ?? null,
    supplier_name: lead.supplier_name || null,
    campaign_id: lead.campaign_id || null,
    lead_status: lead.lead_status,
    stage: verdict.stage,
    disposition: verdict.disposition,
    reason: verdict.reason,
    stalled_ms: verdict.stalled_ms,
    stalled_minutes: verdict.stalled_ms === null ? null : Math.floor(verdict.stalled_ms / 60000),
    last_progress_at: verdict.last_progress_at,
    created_date: lead.created_date || null,
    status_reason: lead.status_reason || null,
    queue_reason: lead.queue_reason || null,
    resumable: verdict.resumable === true,
    actionable: verdict.actionable === true,
  };
}

// One reaper pass.
//
// `retryPass` is injectable so a test can prove the exactly-once behaviour of
// this file without booting the routing engine. Production always gets the real
// runNativeRetryPass, exactly the way nativeRetryRunner.js takes an injectable
// validateTarget that no real caller overrides.
// `write: false` is a genuine read-only scan: no Lead.update, no call into the
// retry worker, nothing handed to a destination. It is what the Stuck Leads
// card reads, so opening the queue can never itself resume a lead.
export async function runStuckLeadReaperPass(db, {
  nowMs = Date.now(),
  thresholdMs = STALL_THRESHOLD_MS,
  workerId = 'stuck-lead-reaper',
  retryPass = runNativeRetryPass,
  env = process.env,
  write = true,
} = {}) {
  if (!isReaperEnabled(env)) {
    return {
      ran: false,
      reason: `${STUCK_LEAD_REAPER_FLAG} is not set to "true"; the stuck lead reaper is off.`,
      scanned: 0,
      stuck: [],
    };
  }

  const leads = await loadQueuedLeads(db);

  const stuck = [];
  const resumableLeadIds = [];
  const markedLeadIds = [];
  const byDisposition = {};
  const byStage = {};

  for (const lead of leads) {
    // The cheap check first, so a scan over a large queued backlog does not
    // spend a DeliveryAttempt query on every lead that is simply still moving.
    if (!stuckCandidate(lead, { nowMs, thresholdMs })) continue;
    // eslint-disable-next-line no-await-in-loop
    const attempts = await loadAttempts(db, lead.id);
    const verdict = classifyStuckLead({ lead, attempts, nowMs, thresholdMs });
    if (!verdict) continue;

    stuck.push(toCardRow(lead, verdict));
    byDisposition[verdict.disposition] = (byDisposition[verdict.disposition] || 0) + 1;
    byStage[verdict.stage] = (byStage[verdict.stage] || 0) + 1;

    if (!verdict.actionable || !write) continue;

    if (verdict.disposition === REAP_DISPOSITION.RESUME_DELIVERY) {
      // Recorded, then handed to the retry worker once for the whole pass
      // below. Writing the marker BEFORE the resume is deliberate: it bumps
      // updated_date, which resets this lead's stall clock, so a second pass
      // arriving while the retry worker is still working cannot classify the
      // same lead as stalled again and trigger a second routing run.
      //
      // lead_status is written back as queued, which is the value it already
      // holds. newVocabularyFields cannot write final_status and cannot write
      // any of the eight money flags (lib/leadStatus.js's
      // assertNoMoneyFieldWritten throws on both), so a reaper bug can move
      // this lead's machine state and nothing else.
      // eslint-disable-next-line no-await-in-loop
      await db.entities.Lead.update(lead.id, newVocabularyFields(LEGACY_STATUS.PROCESSING, {
        processingState: PROCESSING_STATE.ROUTING,
        reason: REAP_REASON.RESUMED,
        reasonDetail: `Reaper handed ${verdict.retryable_attempt_ids?.length || 0} due delivery attempt(s) to the native retry worker after a ${Math.floor((verdict.stalled_ms || 0) / 60000)} minute stall at ${verdict.stage}.`,
      }));
      resumableLeadIds.push(lead.id);
      continue;
    }

    if (verdict.disposition === REAP_DISPOSITION.NO_SAFE_REENTRY && lead.processing_state !== PROCESSING_STATE.FAILED) {
      // D1: "A lead at queued + failed is a stuck lead, surfaced in the Stuck
      // Leads queue." Promoting a silently stalled lead into that state is what
      // makes it visible where the contract says stuck leads live, instead of
      // leaving it looking like a lead that is still mid-flight forever.
      //
      // lead_status stays queued. If the original process was merely slow
      // rather than dead and later finishes, its own statusPatch write wins and
      // overwrites this, so the marker is not destructive.
      // eslint-disable-next-line no-await-in-loop
      await db.entities.Lead.update(lead.id, newVocabularyFields(LEGACY_STATUS.ERROR, {
        reason: REAP_REASON.STALLED_PRE_ROUTING,
        reasonDetail: `Stalled at processing_state "${verdict.stage}" for ${Math.floor((verdict.stalled_ms || 0) / 60000)} minutes with no outbound attempt on record. Not re-sent: no safe re-entry point exists for this stage.`,
      }));
      markedLeadIds.push(lead.id);
    }
  }

  // EXACTLY ONE routing run per pass, regardless of how many leads qualified.
  // runNativeRetryPass is a batch worker over the whole due queue, not a
  // per-lead call, so calling it once per resumable lead would be N passes over
  // the same queue and is the obvious way to turn a recovery into a stampede.
  let retryResult = null;
  if (write && resumableLeadIds.length > 0) {
    retryResult = await retryPass(db, { workerId });
  }

  return {
    ran: true,
    write,
    scanned: leads.length,
    threshold_ms: thresholdMs,
    stuck,
    counts: {
      surfaced: stuck.length,
      by_disposition: byDisposition,
      by_stage: byStage,
    },
    resumed: {
      lead_ids: resumableLeadIds,
      routing_runs: retryResult ? 1 : 0,
      retry_pass: retryResult,
    },
    marked_stuck: markedLeadIds,
  };
}

// ── Scheduled caller ──────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60000;

// In-process periodic caller, the same shape and for the same reasons as
// lib/nativeRetryScheduler.js: this application is a single always-running
// self-hosted service, and calling the pass directly avoids inventing a new
// authenticated cross-network credential just so a scheduler can call its own
// server (creating a production credential is a human-approval gate under
// AGENTS.md section 13).
//
// It lives in this file rather than in server/src/lib because this unit's
// files_owned in forge-pack/03-plan/WORK-UNITS.yaml is exactly three files and
// server/src/lib is not one of them. The one remaining wiring step, which
// belongs to whoever owns server/src/index.js, is an import of this function
// and a call next to the existing startNativeRetryScheduler call. Until that
// happens the reaper is reachable through its HTTP entry point only.
//
// Returns the interval handle so a test can clear it, or null when disabled.
export function startStuckLeadReaper(db, { intervalMs = DEFAULT_INTERVAL_MS, log = console, env = process.env, ...passOptions } = {}) {
  if (!isReaperEnabled(env)) {
    log.log(`[stuck-lead-reaper] disabled (${STUCK_LEAD_REAPER_FLAG} is not "true")`);
    return null;
  }
  log.log(`[stuck-lead-reaper] enabled, polling every ${intervalMs}ms`);
  const tick = async () => {
    try {
      const result = await runStuckLeadReaperPass(db, { workerId: 'stuck-lead-reaper-scheduler', env, ...passOptions });
      if (result.ran && result.counts.surfaced > 0) {
        log.log(`[stuck-lead-reaper] ${result.counts.surfaced} stuck lead(s), ${result.resumed.lead_ids.length} resumed`);
      }
    } catch (err) {
      log.error('[stuck-lead-reaper] tick failed', err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  // Never keep the process alive on its own.
  if (timer.unref) timer.unref();
  return timer;
}

// ── HTTP entry point ──────────────────────────────────────────────────────

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

// Same operator test nativeRetryWorker.js applies. A supplier or buyer account,
// or any account linked to one, is refused outright before permissions are even
// read: the Stuck Leads queue spans every supplier and every buyer, so exposing
// it to a portal account would be exactly the cross-supplier leakage Section 7
// forbids.
async function assertOperator(db, user) {
  const record = await db.entities.User.get(user.id).catch(() => null);
  const caller = record || user;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string'
      ? JSON.parse(caller.permissions || '{}')
      : (caller.permissions || {});
  } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// POST /api/functions/reapStuckLeads
//
// body.dry_run === true scans and classifies without writing anything and
// without handing anything to the retry worker. That is the mode the Stuck
// Leads card reads, so simply looking at the queue can never resume a lead.
export default async function reapStuckLeads(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  if (!isReaperEnabled(ctx.env || process.env)) {
    return {
      ok: false,
      ran: false,
      enabled: false,
      reason: `${STUCK_LEAD_REAPER_FLAG} is not set to "true".`,
      stuck: [],
    };
  }

  // A dry run classifies and reports and does nothing else: no Lead write, no
  // call into the retry worker. This is the mode the Stuck Leads card reads.
  const dryRun = ctx.body?.dry_run === true;
  const result = await runStuckLeadReaperPass(db, {
    workerId: `stuck-lead-reaper-${user.id}`,
    env: ctx.env || process.env,
    write: !dryRun,
  });

  return { ok: true, enabled: true, dry_run: dryRun, ...result };
}
