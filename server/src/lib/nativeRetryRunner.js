// One retry-worker pass against a real database. Shared by the
// operator-triggered HTTP function (nativeRetryWorker.js) and the in-process
// scheduler (nativeRetryScheduler.js) so there is exactly one implementation
// of "how a due native delivery attempt gets resent" rather than two that can
// drift. Checks the distribution_mode gate itself (fresh, since it is DB
// state that can change without a restart); the NATIVE_RETRY_WORKER_ENABLED
// env gate and operator authorization are the caller's responsibility.
//
// The retry send itself goes through reserveAndDeliver - the EXACT same
// cap-reservation / lead-winner-claim / wallet-debit primitive the primary
// send path (distributeRun.js) uses - so a retried delivery is governed by
// identical business rules, not a second, independent billing/cap engine.

import * as engine from '../functions/routingEngine.generated.js';
import { makeTargetValidator } from './ssrfGuard.js';
import { resolveSubDeliveryCredential as resolveCredential } from './subDeliveryCredential.js';

// Fail-closed allowlist, not a bare "!== legacy_only" check: an unrecognized
// or drifted mode string (e.g. a typo, or the historical 'dual' vs
// 'new_primary_with_legacy_fallback' mismatch this repo once had between
// distributionSetMode.js and processLead.js) must leave native retries off,
// the same way processLead.js's own inline allowlist already treats an
// unrecognized value as legacy_only rather than as "anything goes".
const NATIVE_MODES = new Set(engine.MODES.filter((m) => m !== 'legacy_only'));

// The real, strict DNS-resolving validator used in production by default.
// runNativeRetryPass accepts an override (never exercised by any real
// caller - nativeRetryWorker.js and nativeRetryScheduler.js both call this
// with no override, so production always gets the strict default) so a test
// exercising the real (non-test-mode) send path against an isolated local
// mock server is not itself misclassified as an SSRF target: that
// distinction is exactly what ctx.testMode already exists for elsewhere in
// this engine, but a retry send is never testMode by design.
const defaultValidateTarget = makeTargetValidator();

// Resolve the RouteMember/SubDelivery/Delivery graph a stored attempt targets
// and build the minimal member shape reserveAndDeliver needs. Returns null
// for any permanent, non-retryable condition: a missing route_member_id
// (an attempt created before that field existed), a deleted RouteMember, a
// missing/disabled SubDelivery, or a Delivery that is no longer active -
// mirroring the exact fail-closed checks the primary path's own
// snapshot.js/resolveEndpoint already applies, so a retry can never send to
// a destination the operator has since disabled.
//
// Deliberately does NOT swallow exceptions here (repo.js's get() already
// returns null, not a throw, for a genuinely absent row - confirmed by
// reading it - so anything that reaches the caller as a thrown error is a
// REAL transient failure: a DB blip, connection-pool exhaustion). The
// caller (deliverFn, below) is responsible for treating a thrown error as
// transient/retryable and a returned null as permanent - conflating the two
// under one catch-and-return-null previously turned an ordinary transient
// DB hiccup into an immediate, permanent dead-letter (this function's
// caller dead-letters on retryable:false), silently losing a retry that
// only needed the normal backoff schedule.
async function resolveMemberForRetry(db, attempt) {
  if (!attempt.route_member_id) return null;
  const rm = await db.entities.RouteMember.get(attempt.route_member_id);
  if (!rm || rm.active === false) return null;
  const sd = await db.entities.SubDelivery.get(attempt.sub_delivery_id);
  if (!sd || sd.active === false) return null;
  const del = sd.delivery_id ? await db.entities.Delivery.get(sd.delivery_id) : null;
  if (!del || String(del.status) !== 'active') return null;
  const buyer = rm.buyer_id ? await db.entities.Buyer.get(rm.buyer_id) : null;
  const deliveryCfg = engine.resolveSubDeliveryCfg(sd);
  return engine.buildMemberForRetry(rm, buyer, deliveryCfg);
}

// Optional per-lead scoping for the due queue.
//
// Why this exists, stated plainly because it is a safety mechanism and not a
// convenience: runNativeRetryPass is a BATCH worker over every due
// DeliveryAttempt in the system. That is exactly right for its two original
// callers (nativeRetryWorker.js and nativeRetryScheduler.js), whose whole job
// is "drain the due queue". It is wrong for a caller that has already decided,
// per lead, which leads may safely be re-sent and which must never be:
// reapStuckLeads.js classifies a stuck lead as AMBIGUOUS_HOLD,
// EXCLUDED_MIGRATED or ALREADY_SOLD precisely to keep it out of a resend, and
// before this parameter existed its call into this batch pass re-drove those
// leads' attempts anyway, alongside the ones it had approved. The
// classification governed only what was written to the Lead row and shown on
// the Stuck Leads card, never what actually went on the wire.
//
// The shape is an ALLOWLIST, not an exclude list, and that is deliberate. An
// exclude list fails open: a lead the caller forgot to name, or failed to
// classify because a query threw halfway through its scan, is still sent. An
// allowlist fails closed: anything the caller did not explicitly approve is
// simply not in the batch. For a mechanism whose failure mode is a duplicate
// commercial send, fail-closed is the only defensible default.
//
// Backward compatibility is exact. `onlyLeadIds` omitted (or null) returns the
// store untouched, so nativeRetryWorker.js and nativeRetryScheduler.js get
// byte-identical behavior to before: same query, same batch, same limit.
//
// The filter is applied at listDue rather than at deliverFn on purpose. An
// attempt outside the scope is never even claimed, so no lease is taken, no
// lease_version is bumped and no row is written. Scoping a pass cannot leave a
// side effect on the attempts it excluded.
//
// One throughput note, not a safety one: the entity store's listDue reads at
// most `limit` (100) due rows ordered by next_retry_at ascending and this
// filter is applied to that page. A scoped lead whose attempt is not in the
// oldest 100 due rows is simply picked up on a later pass. Ordering is oldest
// first, and a stuck lead's attempt is by definition old, so in practice it
// sorts to the front of that page rather than off the end of it.
function scopeStoreToLeads(store, onlyLeadIds) {
  if (onlyLeadIds === undefined || onlyLeadIds === null) return store;
  const allowed = new Set([].concat(onlyLeadIds).map((id) => String(id)));
  return {
    ...store,
    async listDue(nowMs, limit) {
      const due = await store.listDue(nowMs, limit);
      return (Array.isArray(due) ? due : []).filter((a) => allowed.has(String(a?.lead_id)));
    },
  };
}

export async function runNativeRetryPass(db, { workerId, validateTarget: overrideValidateTarget, onlyLeadIds }) {
  const validateTarget = overrideValidateTarget || defaultValidateTarget;
  const scopedLeadIds = (onlyLeadIds === undefined || onlyLeadIds === null)
    ? null
    : new Set([].concat(onlyLeadIds).map((id) => String(id)));
  const settingsArr = await db.entities.AppSettings.list();
  const mode = String((settingsArr[0] && settingsArr[0].distribution_mode) || 'legacy_only');
  if (!NATIVE_MODES.has(mode)) {
    return { ran: false, reason: `distribution_mode "${mode}" does not enable native delivery; native retries stay off.`, mode };
  }

  const store = db.entities.DeliveryAttempt ? engine.makeEntityAttemptStore(db) : engine.makeInMemoryAttemptStore();
  // Must persist across ticks/invocations, or the breaker never accumulates
  // consecutive failures and never opens.
  const healthStore = db.entities.DestinationHealth ? engine.makeEntityHealthStore(db) : engine.makeInMemoryHealthStore();
  const capStore = db.entities.CapCounter ? engine.makeEntityCapStore(db) : engine.makeInMemoryCasStore();
  const walletStore = db.entities.BuyerWallet ? engine.makeEntityWalletStore(db) : engine.makeInMemoryWalletStore();

  const isLeadSold = (leadId) => engine.isLeadAlreadySold(capStore, leadId);

  const deliverFn = async (attempt) => {
    // Second layer, behind the listDue filter above. Today runRetryWorker only
    // ever calls deliverFn with rows it read from listDue, so this can never
    // fire; it exists so that a future change to the worker loop cannot
    // silently reopen the exact defect this scoping was added to close. It
    // throws rather than returning a failed status because a scoped attempt
    // reaching the send path is an invariant breach, not a delivery outcome,
    // and returning a status here would make runRetryWorker write backoff or
    // dead-letter state onto a row the caller said not to touch.
    if (scopedLeadIds && !scopedLeadIds.has(String(attempt?.lead_id))) {
      throw new Error(`native retry pass is scoped and must not deliver attempt ${attempt?.id} for lead ${attempt?.lead_id}`);
    }
    let member;
    try {
      member = await resolveMemberForRetry(db, attempt);
    } catch {
      // A thrown error here is a real transient failure (DB blip,
      // connection-pool exhaustion), never "genuinely doesn't exist" -
      // resolveMemberForRetry's own comment explains why. Treat it as an
      // ordinary retryable error so the normal backoff schedule gets
      // another chance, instead of permanently dead-lettering a retry that
      // only failed because the database hiccuped.
      return { status: engine.ATTEMPT_STATUS.ERROR, retryable: true };
    }
    if (!member) {
      // Permanent: a deleted/disabled destination, a deactivated parent
      // Delivery, or a structurally invalid RouteMember (no price, bad
      // caps). retryable:false tells runRetryWorker to dead-letter
      // immediately rather than burn the full backoff schedule against a
      // failure no amount of waiting will fix.
      return { status: engine.ATTEMPT_STATUS.ERROR, retryable: false };
    }
    let lead;
    try {
      lead = await db.entities.Lead.get(attempt.lead_id);
    } catch {
      // Same reasoning: never silently send with EMPTY lead data because
      // the fetch itself failed transiently - that would post garbage to a
      // real buyer. Treat as transient and let the normal backoff retry.
      return { status: engine.ATTEMPT_STATUS.ERROR, retryable: true };
    }
    // run_idempotency_key is the bare, non-member-scoped key the primary
    // send stored alongside the combined one, so reserveAndDeliver
    // reconstructs the IDENTICAL outbound Idempotency-Key header a retry of
    // this same logical attempt must reuse (see distributeRun.js). Fall
    // back to idempotency_key for a pre-existing attempt row created before
    // this field existed - matches prior behavior for those rows exactly.
    const runIdempotencyKey = attempt.run_idempotency_key || attempt.idempotency_key;
    const out = await engine.reserveAndDeliver({
      member,
      meta: { attemptNumber: attempt.attempt_number || 1, trigger: 'retry' },
      stores: { attemptStore: store, capStore, walletStore },
      ctx: {
        leadId: attempt.lead_id,
        idempotencyKey: runIdempotencyKey,
        leadData: lead || {},
        nowMs: Date.now(),
        fetchImpl: globalThis.fetch,
        testMode: false,
        resolveCredential: (ref) => resolveCredential(db, ref),
        validateTarget,
        // healthStore intentionally NOT passed here: runRetryWorker's own
        // loop (below) already records health for every attempt it
        // processes, keyed off the stored attempt row. Passing it here too
        // would record the same outcome twice per retry, doubling the
        // circuit breaker's effective failure count.
      },
    });
    return { status: out.status, retryable: out.retryable };
  };

  // now: fresh Date.now() before every claim/settle, not one stale
  // batch-start timestamp - see runRetryWorker's own comment for why this
  // matters once a real backlog (up to 100 due attempts processed
  // sequentially) is in play.
  const outcome = await engine.runRetryWorker(scopeStoreToLeads(store, onlyLeadIds), deliverFn, {
    nowMs: Date.now(), workerId, healthStore, isLeadSold, now: () => Date.now(),
  });
  // scoped_lead_ids is added ONLY when the caller asked for scoping, so the
  // return shape the two pre-existing callers see is unchanged.
  if (scopedLeadIds) return { ran: true, mode, outcome, scoped_lead_ids: [...scopedLeadIds] };
  return { ran: true, mode, outcome };
}
