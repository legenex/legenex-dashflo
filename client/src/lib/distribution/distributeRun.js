// Live distribution orchestrator. This is the missing link between the pure
// routing engine and a real outbound post: it loads the published snapshot, runs
// the approved waterfall (distributeLead), and for each destination reserves cap,
// posts via the direct-post adapter, then finalizes or releases.
//
// Design rules held here:
// - ONE canonical engine. This composes the existing pure modules; it re-implements
//   nothing (no second copy of eligibility, ordering, pricing, or classification).
// - Structurally single-delivery. distributeLead stops at the first ACCEPTED, and a
//   reservation is finalized only on that accept, so no lead is sold twice.
// - Fail closed. Any load or evaluation failure returns a clean, non-delivered
//   status so the caller may fall back to legacy without risking a double send.
// - No secrets. The credential is an opaque ref resolved at send time by the
//   adapter via the injected resolveCredential.
// - Pure of ambient time and network: nowMs, fetchImpl and resolveCredential are
//   injected, so the same orchestrator runs in Deno and in tests.

import { distributeLead } from './distribute.js';
import { capWindowStart, capScopeKey, resolvePrice } from './engine.js';
import { evalConditionTree } from './conditions.js';
import { loadRoutingSnapshot, hasActiveRouteGroup } from './snapshotLoader.js';
import { deliverDirectPost } from './directPost.js';
import { makeEntityAttemptStore } from './deliveryStore.js';
import { makeEntityCapStore } from './capStore.js';
import { makeEntityWalletStore } from './walletStore.js';
import { makeEntityHealthStore } from './destinationHealth.js';
import { walletDebit } from './walletLedger.js';
import { reserve, finalize, release, RESERVE } from './reservation.js';
import { ATTEMPT_STATUS } from './deliveryAttempt.js';

// Outcome categories the caller (processLead) reads to decide on legacy fallback.
// These line up with modeControl.shouldFallback: only clean non-deliveries qualify.
export const RUN = {
  ACCEPTED: 'accepted',
  DUPLICATE: 'duplicate',
  NO_ELIGIBLE: 'no_eligible_member',
  REJECTED: 'rejected',
  ERROR_CLEAN: 'error_clean',
  AMBIGUOUS: 'ambiguous',
  SKIPPED: 'skipped',
};

const CAP_WINDOWS = ['total', 'hourly', 'daily', 'weekly', 'monthly'];

// Build the cap scopes for one member from its resolved caps snapshot. Keys are
// window-bucketed so a new day starts a new counter. A window with no limit is
// unlimited and produces no scope.
export function capScopesFor(member, nowMs, tzOffsetMinutes = 0) {
  const scopes = [];
  const caps = member.caps || {};
  for (const w of CAP_WINDOWS) {
    const cfg = caps[w];
    if (!cfg || cfg.limit == null) continue;
    const bucket = w === 'total' ? 'all' : capWindowStart(nowMs, w, tzOffsetMinutes);
    scopes.push({
      key: capScopeKey(member.id, w, bucket),
      limit: Number(cfg.limit),
      window: w,
      windowStart: w === 'total' ? null : bucket,
      memberId: member.id,
      scopeType: 'route_member',
    });
  }
  return scopes;
}

// Wallet policy for a sale. Two distinct questions, deliberately separated:
//   accounting - do we record the movement? (yes for any balance-run buyer)
//   enforcement - may the debit be refused? (only with an explicit credit_limit)
// A prepay buyer with no configured limit is recorded and allowed to go negative
// rather than having the sale blocked. Invoiced buyers with no limit are billed
// downstream and touch no wallet at all.
function walletPolicyFor(member) {
  const w = member.wallet;
  if (!w) return null;
  if (w.enforce && w.creditLimit != null) return { creditLimit: Number(w.creditLimit) };
  if (w.mode === 'prepaid') return { creditLimit: Infinity }; // record, never refuse
  return null;
}

// Is this lead ALREADY sold, by any destination, primary or retry? A
// read-only peek at the lead-level winner claim (see reserveAndDeliver step
// 4), via capStore.isClaimed - never mutates, never itself claims.
export async function isLeadAlreadySold(capStore, leadId) {
  if (!leadId || !capStore) return false;
  return capStore.isClaimed(winnerClaimKey(leadId));
}

function winnerClaimKey(leadId) {
  return `winner:${leadId}`;
}

// THE shared per-destination settlement primitive: reserve cap -> post ->
// lead-level winner claim -> finalize/release + wallet debit. Both the
// primary send path (makeDeliver, below) and the async native retry worker
// (server/src/lib/nativeRetryRunner.js, via the generated engine bundle)
// call this SAME function, so a retried send is governed by identical
// business rules as a primary send - not a second, independent
// implementation of cap/billing/winner logic.
//
// Two layers close the double-sale/double-delivery risk a purely
// asynchronous retry otherwise creates (a destination that failed on the
// primary run, and later becomes retry-due AFTER a different destination has
// already sold the same lead):
//   1. A pre-send peek (isLeadAlreadySold): if another destination already
//      won, this attempt is rejected WITHOUT ever posting - the common case,
//      and the only layer that can prevent the PII send itself.
//   2. An atomic per-lead winner claim, attempted only after a REAL accepted
//      response comes back: this is the correctness guarantee under a
//      genuine race (two retry-due attempts for the same lead processed
//      concurrently by two workers). Exactly one destination's claim can
//      ever win; the other is marked SUPERSEDED and gets no cap
//      finalization, no wallet debit, and no winner attribution, even though
//      the buyer it contacted did say accepted.
// meta: { attemptNumber, trigger } - trigger defaults to 'primary' (the only
// value distribute.js's in-run waterfall ever supplies); the retry caller
// passes trigger: 'retry'.
export async function reserveAndDeliver({ member, meta, stores, ctx, sink }) {
  const { attemptStore, capStore, walletStore } = stores;
  const nowMs = ctx.nowMs;
  const price = resolvePrice(member);
  const attemptNumber = (meta && meta.attemptNumber) || 1;
  const trigger = (meta && meta.trigger) || 'primary';
  const memberKey = `${ctx.idempotencyKey}:${member.id}`;

  // 0. Best-effort pre-send guard: never post to a destination once this
  // lead already has a winner elsewhere. Status is SUPERSEDED, not REJECTED:
  // a genuine business REJECTED is safe to fall through to another
  // destination or legacy (the caller's shouldFallback/processLead.js
  // approves it), but "already sold elsewhere" must NEVER be treated as a
  // clean miss - conflating the two under REJECTED let a run whose real
  // winner attempt was superseded (step 4) still report an overall
  // fallback-eligible outcome once every remaining candidate hit this same
  // pre-check, since they all resolved to the ordinary REJECTED bucket.
  if (await isLeadAlreadySold(capStore, ctx.leadId)) {
    return { status: ATTEMPT_STATUS.SUPERSEDED, reason: 'LEAD_ALREADY_SOLD', revenue: 0, retryable: false, wonLead: false };
  }

  // 1. Reserve capacity atomically before any outbound request. The
  // reservation's own idempotency key is scoped by attempt number
  // (`${idempotencyKey}:${attemptNumber}`) so a same-destination retry -
  // in-run (maxAttemptsPerDest > 1) or async (the retry worker) - gets its
  // own fresh claim instead of being rejected merely because an earlier
  // attempt already held (and, on failure, released) this exact slot. The
  // CAP SCOPE key itself (capScopesFor) is unaffected by attempt number: it
  // is the window's actual consumed-count, which must stay one counter
  // across every attempt at the same destination.
  const scopes = capScopesFor(member, nowMs, ctx.tzOffsetMinutes || 0);
  let reservation = null;
  if (scopes.length) {
    const res = await reserve(capStore, {
      idempotencyKey: `${ctx.idempotencyKey}:${attemptNumber}`, leadId: ctx.leadId, memberId: member.id, price, scopes,
    });
    if (!res.ok) {
      return { status: ATTEMPT_STATUS.REJECTED, reason: res.code || RESERVE.CAP_EXCEEDED, revenue: 0, retryable: false };
    }
    reservation = res.reservation;
    // An idempotent replay of this EXACT attempt must not post twice.
    if (res.code === RESERVE.ALREADY_RESERVED) {
      return { status: ATTEMPT_STATUS.REJECTED, reason: 'ALREADY_RESERVED', revenue: 0, retryable: false };
    }
  }

  // 2. Post. The member's canonical endpoint cfg came from the SubDelivery.
  const cfg = member.delivery;
  if (!cfg || !cfg.targetUrl) {
    if (reservation) await release(capStore, reservation);
    return { status: ATTEMPT_STATUS.ERROR, errorClass: 'no_endpoint', revenue: 0, retryable: false };
  }

  let out;
  try {
    out = await deliverDirectPost({
      ...cfg,
      destinationId: member.destinationId || null,
      routeMemberId: member.id,
      leadId: ctx.leadId,
      leadData: ctx.leadData,
      idempotencyKey: memberKey,
      // The bare, non-member-scoped run key, persisted alongside the
      // combined one so a LATER async retry (which only has the stored
      // attempt row, not this closure's ctx) can pass it back in as its own
      // ctx.idempotencyKey and reconstruct the IDENTICAL outbound
      // Idempotency-Key header - never a different one for the same logical
      // attempt, which would defeat the buyer's own dedup and increase,
      // rather than close, the double-accept risk a retry already carries.
      runIdempotencyKey: ctx.idempotencyKey,
      attemptNumber,
      isPrimary: trigger === 'primary' && attemptNumber === 1,
      trigger,
    }, {
      store: attemptStore,
      nowMs,
      fetchImpl: ctx.fetchImpl,
      testMode: !!ctx.testMode,
      allowlistHosts: ctx.allowlistHosts || [],
      resolveCredential: ctx.resolveCredential,
      validateTarget: ctx.validateTarget,
    });
  } catch (err) {
    if (reservation) await release(capStore, reservation);
    return {
      status: ATTEMPT_STATUS.ERROR,
      errorClass: String((err && err.message) || err).slice(0, 60),
      revenue: 0, retryable: false,
    };
  }

  // 3. Circuit breaker bookkeeping: record this real outcome. A
  // persistently failing destination opens; a destination given a trial
  // send while open (see snapshot.js/isBlocked) closes again on success.
  // Matches the retry worker's own success definition (ACCEPTED only) so
  // both writers agree on what "healthy" means. Never blocks or fails the
  // delivery itself - health bookkeeping is best-effort.
  if (ctx.healthStore) {
    try {
      await ctx.healthStore.recordResult(
        { subDeliveryId: member.subDeliveryId || null, destinationId: member.destinationId || null },
        out.status === ATTEMPT_STATUS.ACCEPTED, nowMs, ctx.healthOpts,
      );
    } catch { /* health bookkeeping must never break delivery */ }
  }

  // 4. Settle the reservation on the real outcome.
  if (out.status === ATTEMPT_STATUS.ACCEPTED) {
    const won = await capStore.claim(winnerClaimKey(ctx.leadId));
    if (!won) {
      // A different destination won this lead between step 0's peek and this
      // send completing (a genuine cross-destination race). No business
      // effect for this one: release the cap slot, never touch the wallet,
      // and mark the already-persisted attempt row so it is visibly
      // distinguished from a real, counted sale.
      if (reservation) await release(capStore, reservation);
      if (out.attemptId) {
        try { await attemptStore.updateAttempt(out.attemptId, { status: ATTEMPT_STATUS.SUPERSEDED }); } catch { /* best-effort */ }
      }
      if (sink) sink.balanceDecision = 'superseded_duplicate_sale';
      return {
        status: ATTEMPT_STATUS.SUPERSEDED, revenue: 0, httpStatus: out.httpStatus ?? null,
        retryable: false, attemptId: out.attemptId, balanceDecision: 'superseded_duplicate_sale', wonLead: false,
      };
    }
    if (reservation) await finalize(capStore, reservation);
    const policy = walletPolicyFor(member);
    if (policy && price > 0) {
      try {
        const debit = await walletDebit(walletStore, {
          buyerId: member.buyerId, amount: price, idempotencyKey: `sale:${memberKey}`,
          creditLimit: policy.creditLimit, type: 'debit', description: `lead ${ctx.leadId}`,
        });
        out.balanceDecision = debit.applied ? 'debited' : (debit.duplicate ? 'duplicate' : (debit.code || 'not_applied'));
      } catch {
        // Billing must never unsell a delivered lead. Record and move on.
        out.balanceDecision = 'debit_error';
      }
      if (sink) sink.balanceDecision = out.balanceDecision;
    } else if (sink) {
      sink.balanceDecision = 'not_applicable';
    }
  } else if (reservation) {
    await release(capStore, reservation);
  }

  return {
    status: out.status,
    revenue: out.revenue || 0,
    httpStatus: out.httpStatus ?? null,
    errorClass: out.errorClass ?? null,
    retryable: !!out.retryable,
    attemptId: out.attemptId,
    buyerLeadId: out.buyerLeadId ?? null,
    balanceDecision: out.balanceDecision ?? null,
    wonLead: out.status === ATTEMPT_STATUS.ACCEPTED,
  };
}

// Per-destination delivery step for the in-run waterfall (distribute.js).
// `sink` collects out-of-band outcomes (the wallet decision) that the attempt
// rows in the waterfall result do not carry. Thin wrapper over the shared
// reserveAndDeliver primitive - see its own comment for the full contract.
function makeDeliver({ stores, ctx, sink }) {
  return async function deliver(member, meta) {
    return reserveAndDeliver({ member, meta, stores, ctx, sink });
  };
}

// Map the waterfall result onto the caller-facing outcome category.
function toRunStatus(result) {
  switch (result.finalStatus) {
    case 'Sold': return RUN.ACCEPTED;
    case 'Duplicate': return RUN.DUPLICATE;
    case 'NoEligibleDestination': return RUN.NO_ELIGIBLE;
    case 'CampaignInactive': return RUN.NO_ELIGIBLE;
    case 'Exhausted': {
      // Exhausted is a clean non-delivery ONLY when nothing ambiguous happened.
      // A timeout or aborted request might have been received by the buyer, so
      // it is ambiguous and must never trigger a legacy re-send. A QUEUED
      // response is the same kind of risk from the other direction: it is not
      // a network failure, it is a REAL response the destination sent, and
      // every design signal in this codebase treats it as "the destination has
      // received and is holding this lead" (retryWorker.js retries the SAME
      // destination on QUEUED rather than treating it as settled; the
      // legacy-era queue_reason semantics were always "held for a human," never
      // "safe to resend elsewhere"). No repository or production evidence ever
      // shows a QUEUED lead later resold to a second destination, so it is
      // treated the same as an ambiguous timeout: never a clean fallthrough.
      // SUPERSEDED is the strongest signal of all: it means a destination in
      // THIS run definitely accepted the lead (real PII sent, real 2xx-class
      // acceptance) but lost the cross-run winner claim to a different
      // destination - so the lead was, in fact, delivered. Without this
      // check, every remaining candidate in the same run also resolves to
      // SUPERSEDED via the pre-send guard (step 0 of reserveAndDeliver), none
      // of which register as REJECTED or ambiguous under the OLD checks
      // below, so the run's overall outcome would otherwise wrongly report a
      // clean miss and the caller (processLead.js) would fall through to the
      // legacy relay - a real, reachable double-sale under ordinary
      // duplicate-submission conditions, not only a rare race.
      const ambiguous = (result.attempts || []).some(
        (a) => (a.status === ATTEMPT_STATUS.ERROR && ['timeout', 'network_error'].includes(String(a.error_class || '')))
          || a.status === ATTEMPT_STATUS.QUEUED
          || a.status === ATTEMPT_STATUS.SUPERSEDED,
      );
      if (ambiguous) return RUN.AMBIGUOUS;
      const anyDelivered = (result.attempts || []).some((a) => a.status === ATTEMPT_STATUS.REJECTED);
      return anyDelivered ? RUN.REJECTED : RUN.ERROR_CLEAN;
    }
    default: return RUN.ERROR_CLEAN;
  }
}

// Run one lead through live distribution.
// ctx: { leadId, campaignId, idempotencyKey, leadData, nowMs, distributionMode,
//        fetchImpl, resolveCredential, testMode, allowlistHosts, tzOffsetMinutes }
// Returns { ran, status, winnerMemberId, buyerId, price, revenue, result }.
export async function runDistribution(db, ctx) {
  const nowMs = ctx.nowMs ?? 0;
  const trace = async (patch) => {
    try {
      await db.entities.RouteDecisionTrace.create({
        lead_id: ctx.leadId,
        idempotency_key: ctx.idempotencyKey || null,
        distribution_mode: ctx.distributionMode || 'unknown',
        created_at: new Date(nowMs).toISOString(),
        ...patch,
      });
    } catch { /* trace write failed; never break the delivery path */ }
  };

  try {
    const hasGroups = ctx.snapshot ? true : await hasActiveRouteGroup(db, ctx.campaignId, nowMs);
    if (!hasGroups) {
      await trace({ result: 'no_route_config', winner_member_id: '', evaluated_candidates: '[]', fallthrough_path: '[]' });
      return { ran: false, status: RUN.NO_ELIGIBLE, reason: 'no_route_config' };
    }

    const snap = ctx.snapshot || await loadRoutingSnapshot(db, {
      campaignId: ctx.campaignId, nowMs, leadState: (ctx.leadData || {}).state,
    });
    // Real the backend adapters in production; tests inject in-memory equivalents.
    const stores = ctx.stores || {
      attemptStore: makeEntityAttemptStore(db),
      capStore: makeEntityCapStore(db),
      walletStore: makeEntityWalletStore(db),
    };
    // healthStore defaults to the real per-endpoint circuit breaker unless a
    // test injects its own (or explicitly passes null to opt out).
    const healthStore = ctx.healthStore !== undefined ? ctx.healthStore : makeEntityHealthStore(db);

    const t0 = nowMs;
    const sink = {};
    const result = await distributeLead({
      campaign: ctx.campaign || null,
      groups: snap.groups,
      lead: ctx.leadData || {},
      seed: { key: ctx.idempotencyKey || '' },
      nowMs,
      evalConditions: (t, d) => evalConditionTree(t, d, { nowMs }),
      deliver: makeDeliver({ db, stores, ctx: { ...ctx, nowMs, healthStore }, sink }),
      maxAttemptsPerDest: ctx.maxAttemptsPerDest || 1,
    });

    const status = toRunStatus(result);
    const winnerRow = result.winner
      ? (snap.groups.flatMap((g) => g.members).find((m) => m.id === result.winner) || null)
      : null;

    await trace({
      result: status,
      evaluated_candidates: JSON.stringify(result.candidates || []),
      winner_member_id: result.winner || '',
      price: result.price || 0,
      fallthrough_path: JSON.stringify(result.ordered || []),
      config_version: snap.configHash || null,
      balance_decision: sink.balanceDecision || null,
      eval_latency_ms: nowMs - t0,
    });

    return {
      ran: true,
      status,
      winnerMemberId: result.winner || null,
      buyerId: winnerRow ? winnerRow.buyerId : null,
      subDeliveryId: winnerRow ? winnerRow.subDeliveryId : null,
      price: result.price || 0,
      revenue: result.revenue || 0,
      result,
    };
  } catch (err) {
    // Nothing was delivered on this path (any post failure is caught inside
    // deliver and surfaces as an attempt, not a throw), so this is clean.
    await trace({
      result: 'evaluation_error', winner_member_id: '', evaluated_candidates: '[]', fallthrough_path: '[]',
      error_message: String((err && err.message) || err).slice(0, 300),
    });
    return { ran: false, status: RUN.ERROR_CLEAN, reason: 'evaluation_error', error: String((err && err.message) || err) };
  }
}
