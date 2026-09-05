// Derived money flags. Work unit W1-FLAGS, forge-pack/CONTRACT.md D2.
//
// The problem
// -----------
// Every revenue, GP, CPL and ROAS number in this app has been computed by
// asking `final_status` a question ("does it equal Sold?"). `final_status`
// is not a stable fact about money, it is a workflow field that legitimately
// moves over a lead's lifetime: Sold -> Returned when a buyer sends one back,
// Sold -> Converted when a buyer confirms one downstream (see the
// precedence chains in server/src/functions/leadbyteWebhook.js and
// server/src/lib/leadIdentity.js). The instant either of those happens, any
// report that filters on final_status === 'Sold' silently loses that lead,
// and every revenue/GP/CPL/ROAS figure built on it quietly drifts, exactly
// as forge-pack/CONTRACT.md section 4 D2 describes: "every conversion that
// arrives decrements Sold and Revenue, quietly, weeks after launch."
//
// It gets worse than a read-time filter. server/src/functions/webhook.js
// treats `revenue` as a MUTABLE_OUTCOME_FIELD: a later outcome postback (a
// resale, a corrected buyer report) can overwrite Lead.revenue in place, so
// even the number itself is not stable once captured. And 28 Aug 2026 found
// generateBillingRun.js filtering on Lead.buyer_id, a field that only ever
// held a buyer_code string in production, so every buyer billing preview
// silently returned zero leads (see docs/STATE.md and the buyer_record_id
// fix in server/src/lib/buyerIdentity.js). That is the same failure mode:
// money math depending on a field whose meaning or population can shift
// under it. This module exists so is_sold/sale_price_effective never can.
//
// The fix
// -------
// Compute eight flags ONCE, from whatever fields currently determine "did
// this lead sell, for how much, was it later returned or converted" -
// final_status, revenue, buyer_conversion, and any approved ReturnRequest -
// and then make every one of them immutable. Once is_sold is true it can
// never be cleared again by any later status change, webhook, or re-run of
// this same backfill; once sale_price_effective is set it can never change,
// so a later resale-style postback can no longer move the number money
// reporting actually reads. Immutability is enforced in two independent
// layers, deliberately redundant:
//
//   1. Here (leadFlagsPatch): never even attempt to write over an
//      already-set flag, so an ordinary caller of this module cannot
//      regress it and a second backfill run is a true no-op.
//   2. server/src/db/schema.js (the lead_flags_write_once trigger): a
//      database-level latch that holds even against a caller that bypasses
//      this module entirely - raw SQL, a future hand-rolled Lead.update(),
//      code that does not exist yet. Repo.update() in server/src/db/repo.js
//      does a blind top-level JSONB merge for every entity, so nothing in
//      that generic path knows these eight keys are special; the trigger is
//      the one place that can make "no code path can ever clear it" actually
//      true rather than merely "no code path we thought to check."
//
// What "sold" means today, without an event log
// -----------------------------------------------
// Production leads are flat rows with a single current final_status, not an
// event-sourced history of every status they ever passed through. There is
// no way to ask "was this lead Sold at 3pm before becoming Returned at 5pm"
// from the row alone. This system's own precedence rules say we shouldn't
// need to: forge-pack/CONTRACT.md D1 defines `returned` as "a PREVIOUSLY
// SOLD lead with an approved return" and `converted` as "a PREVIOUSLY SOLD
// lead confirmed downstream" - Returned and Converted are, by this system's
// own definition, states a lead only reaches by first being Sold. So for a
// one-time backfill against the current snapshot, "was this lead ever sold"
// is treated as: final_status is currently Sold, Returned, or Converted.
// Anything else (Disqualified, Rejected, Unsold, Duplicate, Error, Fake,
// Qualified, Queued, Processing - the full pre-W2-STATUS twelve-value enum)
// never sold.
//
// That precedence assumption is NOT actually enforced by every live write
// path, and a snapshot backfill has no way to tell the difference.
// server/src/functions/webhook.js's create branch (~line 604) and update
// branch (~line 505) set final_status directly with no precedence guard at
// all, and server/src/functions/leadbyteWebhook.js's create branch (a lead
// this system has never seen before) also sets final_status directly with
// no guard - only its existing-lead update branch (~line 365-376) checks
// precedence before accepting a new final_status. So a lead can reach
// Converted or Returned today WITHOUT ever having been Sold, and this
// module cannot see that from the row alone: there is no per-transition
// history to consult, only the current final_status. Because is_sold is
// permanently immutable once true (see "The fix" below), backfilling such a
// lead locks in a wrong is_sold=true forever with no code-level correction
// path afterwards.
//
// This module cannot close that gap - webhook.js and leadbyteWebhook.js are
// a different work unit's file ownership, and changing whether is_sold gets
// set for Converted/Returned leads would mean redesigning the whole
// "Returned/Converted implies Sold" premise, which is out of scope here.
// What it does instead is refuse to hide the risk: backfillLeadFlags emits a
// `precedence_unverified` exception (see below, counted in
// counts.precedence_unverified) for every Converted/Returned lead that has
// no independent corroborating evidence - a genuine positive captured
// revenue value - that it was ever actually sold. The absence of a reliable
// corroborating signal IS the finding: such rows are surfaced and counted so
// a human can review them, rather than letting anyone assume this backfill's
// is_sold values are all independently verified when, for this specific
// class of row, they cannot be.
//
// Timestamps are similarly best-effort against the fields that exist today.
// processed_at is written once by processLead.js at first settlement and is
// never touched again by either outcome webhook, so it is the closest thing
// to a stable "when this lead was first processed" mark and is used for
// sold_at. leadbyte_outcome_at is overwritten by EVERY later outcome
// postback (see leadbyteWebhook.js / webhook.js), so it is a reasonable
// proxy for returned_at/converted_at (those only happen via a later
// postback) but not for sold_at on a lead that has since moved past Sold.
// This is a real, disclosed precision limit of backfilling from a snapshot
// with no per-transition history, not a defect in this module.

// The eight flags this unit adds, in schema order. Exported so callers
// (tests, future reporting code) never have to hand-copy this list.
export const LEAD_FLAG_FIELDS = Object.freeze([
  'is_sold',
  'sold_at',
  'sale_price_effective',
  'is_returned',
  'returned_at',
  'is_converted',
  'converted_at',
  'conversion_type',
]);

const BOOLEAN_FLAG_FIELDS = new Set(['is_sold', 'is_returned', 'is_converted']);

// final_status values that mean "this lead was, at some point, sold" -
// see the module comment above for why Returned/Converted qualify.
const EVER_SOLD_STATUSES = new Set(['Sold', 'Returned', 'Converted']);

// Treat blank, dash and the literal string "null" as absent, matching the
// cleaning convention already used by leadbyteWebhook.js and webhook.js so a
// merge-field placeholder like "{buyer_conversion}" never becomes real data.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'null') return null;
  if (/^\{.*\}$/.test(s)) return null;
  return s;
}

function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// First field on `lead` (checked in order) that parses to a real instant,
// returned as an ISO string. Falls back to created_date, which every lead
// carries, so a timestamp flag is never left null purely for want of a
// better source once its boolean flag is true.
function firstTimestamp(lead, keys) {
  for (const key of keys) {
    const raw = clean(lead?.[key]);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

// True when `returnRequest` is an approved ReturnRequest for this lead. Kept
// as its own predicate so the two return signals below stay legible.
function isApprovedReturn(returnRequest) {
  return !!returnRequest && returnRequest.status === 'approved';
}

// True when `lead` carries independent evidence that it was actually sold,
// beyond final_status itself. See the module comment above for why this
// matters: webhook.js and leadbyteWebhook.js's create paths can set
// final_status to Converted/Returned with no prior Sold, so for those two
// statuses specifically, final_status alone is not proof of a sale. A
// genuine positive captured revenue value is the only other sale signal
// this schema carries on the row (it is also the source of
// sale_price_effective, see computeLeadFlags below), so it is what "was
// this really sold" is checked against here. Zero, negative, and missing
// revenue are all treated as "no corroboration" - a placeholder or reversed
// value proves nothing about a real sale.
function hasSaleCorroboration(lead) {
  const revenue = toFiniteNumber(lead?.revenue);
  return revenue !== null && revenue > 0;
}

// Compute the flag values a lead SHOULD have right now, from its current
// fields plus (optionally) the approved ReturnRequest for it, if one was
// looked up by the caller. Pure: makes no database call and writes nothing.
//
// `returnRequest` is optional and independent of final_status === 'Returned'
// on purpose. Two return signals exist in this system side by side:
//   - the inline one leadbyteWebhook.js/webhook.js record straight onto the
//     lead when a buyer reports a return (final_status becomes 'Returned'),
//   - the formal ReturnRequest workflow generateBillingRun.js already treats
//     as authoritative for billing ("not billable" is driven by an approved
//     ReturnRequest, never by final_status).
// Either one is sufficient evidence of an approved return; a lead can be
// returned by whichever path actually ran for it in production.
export function computeLeadFlags(lead, { returnRequest = null } = {}) {
  const status = String(lead?.final_status || '');
  const everSold = EVER_SOLD_STATUSES.has(status);

  const capturedRevenue = toFiniteNumber(lead?.revenue);
  const isSold = everSold;
  // A lead can be genuinely Sold with no usable revenue value at all (see
  // processLead.js: revenue_source lands on 'unknown' when neither the
  // per-buyer sum nor the response-root revenue parsed). sale_price_effective
  // stays null there rather than silently defaulting to zero, matching the
  // "never price at zero silently" convention already used by
  // generateBillingRun.js's unpriced-lead handling.
  const salePriceEffective = isSold ? capturedRevenue : null;
  const soldAt = isSold
    ? firstTimestamp(lead, ['processed_at', 'leadbyte_outcome_at', 'updated_date', 'created_date'])
    : null;

  const returnedByStatus = status === 'Returned';
  const returnedByRequest = isApprovedReturn(returnRequest);
  const isReturned = returnedByStatus || returnedByRequest;
  const returnedAt = isReturned
    ? (clean(returnRequest?.resolved_date)
      || firstTimestamp(lead, ['leadbyte_outcome_at', 'updated_date', 'created_date']))
    : null;

  const isConverted = status === 'Converted';
  const convertedAt = isConverted
    ? firstTimestamp(lead, ['leadbyte_outcome_at', 'updated_date', 'created_date'])
    : null;
  const conversionType = isConverted ? (clean(lead?.buyer_conversion) || 'converted') : null;

  return {
    is_sold: isSold,
    sold_at: soldAt,
    sale_price_effective: salePriceEffective,
    is_returned: isReturned,
    returned_at: returnedAt,
    is_converted: isConverted,
    converted_at: convertedAt,
    conversion_type: conversionType,
  };
}

// True when `lead` already carries a "set" value for this flag field, using
// the same set/unset rule the database trigger uses (see schema.js): a
// boolean is set only once it is true, everything else is set once it is
// non-null. This is what makes leadFlagsPatch and the backfill idempotent
// and write-once at the application layer, independent of the DB trigger.
export function isFlagSet(lead, field) {
  const value = lead?.[field];
  if (BOOLEAN_FLAG_FIELDS.has(field)) return value === true;
  return value !== null && value !== undefined;
}

// The additive patch to write for one lead, or null when there is nothing
// to write. Never includes a key that is already set on `lead`, so calling
// this twice against the same stored row (a second backfill run, a stray
// duplicate call) produces null the second time - the backfill's
// idempotency guarantee lives here, not just in the "did I already visit
// this id" bookkeeping around the loop.
export function leadFlagsPatch(lead, computed) {
  const patch = {};
  for (const field of LEAD_FLAG_FIELDS) {
    if (isFlagSet(lead, field)) continue; // already locked in; never touch it again
    const value = computed[field];
    const meaningful = BOOLEAN_FLAG_FIELDS.has(field) ? value === true : value !== null && value !== undefined;
    if (!meaningful) continue; // nothing new and real to record yet
    patch[field] = value;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// Page through an entity list/filter so a full-table backfill works past
// whatever default page size the repo layer uses. Mirrors the same helper in
// generateBillingRun.js deliberately, rather than inventing a second one.
async function loadAll(entity, filter) {
  const pageSize = 500;
  const out = [];
  let skip = 0;
  while (true) {
    const batch = filter
      ? await entity.filter(filter, '-created_date', pageSize, skip)
      : await entity.list('-created_date', pageSize, skip);
    out.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

// Run the backfill over every Lead reachable through `db.entities`, writing
// only additive patches (leadFlagsPatch already guarantees a set flag is
// never included). Safe to run twice: the second run's counts.newly_flagged
// is 0 and no already-flagged lead is written to again.
//
// `db` is the same `{ entities: { Lead, ReturnRequest, ... } }` shape every
// backend function in this repo receives (see server/src/db/repo.js
// entitiesNamespace and how generateBillingRun.js/buyerIdentity.js consume
// it), so this runs unchanged whether it is invoked from a one-off script, a
// backend function, or a test.
export async function backfillLeadFlags(db) {
  const leads = await loadAll(db.entities.Lead);
  const returnRequests = await loadAll(db.entities.ReturnRequest);

  // Index the latest APPROVED ReturnRequest per lead. A lead can accumulate
  // more than one ReturnRequest over time (a rejected request, then a later
  // approved one); only an approved one is evidence of an actual return, and
  // if more than one is somehow approved the most recently resolved wins.
  const approvedByLead = new Map();
  for (const r of returnRequests) {
    if (r.status !== 'approved' || !r.lead_id) continue;
    const prior = approvedByLead.get(r.lead_id);
    if (!prior) { approvedByLead.set(r.lead_id, r); continue; }
    const priorTime = Date.parse(prior.resolved_date || '') || 0;
    const thisTime = Date.parse(r.resolved_date || '') || 0;
    if (thisTime >= priorTime) approvedByLead.set(r.lead_id, r);
  }

  const counts = {
    total: leads.length,
    newly_flagged: 0,
    // An ever-sold lead whose flags were already fully set - true repeat-run
    // idempotency, distinct from a lead that was never sold at all (below).
    already_flagged: 0,
    // Never sold, returned or converted: no flag has anything to record, on
    // this run or any future one, so it is never confused with "already
    // flagged" bookkeeping above.
    not_applicable: 0,
    sold: 0,
    sold_unknown_price: 0,
    // Converted/Returned leads with no independent corroborating evidence
    // (a genuine positive revenue value) that they were ever actually Sold.
    // See the module comment's "What 'sold' means today" section: webhook.js
    // and leadbyteWebhook.js's create paths can set final_status straight to
    // Converted/Returned with no prior Sold and no precedence guard, and this
    // backfill cannot verify precedence from a snapshot alone. This count
    // exists to surface that gap for human review, not to hide it.
    precedence_unverified: 0,
    returned: 0,
    converted: 0,
  };
  const exceptions = [];

  for (const lead of leads) {
    const returnRequest = approvedByLead.get(lead.id) || null;
    const computed = computeLeadFlags(lead, { returnRequest });
    const everMeaningful = computed.is_sold || computed.is_returned || computed.is_converted;
    const status = String(lead?.final_status || '');

    if (computed.is_sold) {
      counts.sold += 1;
      if (computed.sale_price_effective === null) {
        counts.sold_unknown_price += 1;
        exceptions.push({
          lead_id: lead.id,
          reason: 'sold_with_unknown_price',
          detail: 'final_status indicates a sale but no usable revenue value was ever captured; sale_price_effective left null rather than priced at zero.',
        });
      }
      // Converted/Returned is only proof of a prior sale if this system's
      // precedence rules were actually enforced when the row was written.
      // They were not, on every path (see the module comment): flag it
      // rather than silently trusting is_sold=true for this row.
      if ((status === 'Converted' || status === 'Returned') && !hasSaleCorroboration(lead)) {
        counts.precedence_unverified += 1;
        exceptions.push({
          lead_id: lead.id,
          reason: 'precedence_unverified',
          detail: `final_status is ${status}, which this backfill treats as proof of a prior sale per forge-pack/CONTRACT.md D1 - but webhook.js's create/update branches and leadbyteWebhook.js's create branch can write this status with no precedence guard, so it may never have actually been Sold. No corroborating positive revenue value was found on this row to independently support the sale. is_sold was still set to true (consistent with the rest of this backfill's ever-sold definition), but this row could not be verified from the snapshot alone and should be reviewed.`,
        });
      }
    }
    if (computed.is_returned) counts.returned += 1;
    if (computed.is_converted) counts.converted += 1;

    const patch = leadFlagsPatch(lead, computed);
    if (patch) {
      counts.newly_flagged += 1;
      await db.entities.Lead.update(lead.id, patch);
    } else if (everMeaningful) {
      counts.already_flagged += 1;
    } else {
      counts.not_applicable += 1;
    }
  }

  return { counts, exceptions };
}

// Revenue, the D2 way: sum sale_price_effective where is_sold and not
// is_returned. A converted lead is still is_sold and not is_returned, so it
// still counts, at its original price - forge-pack/CONTRACT.md D2's whole
// point. Leads with is_sold but a null sale_price_effective (see
// sold_unknown_price above) contribute 0, the same "known gap, never a
// silent guess" treatment generateBillingRun.js already gives unpriced
// leads, rather than throwing or fabricating a number.
export function revenueFromFlags(leads) {
  let total = 0;
  for (const lead of leads) {
    if (!lead || lead.is_sold !== true || lead.is_returned === true) continue;
    total += Number(lead.sale_price_effective) || 0;
  }
  return Math.round(total * 100) / 100;
}

export default {
  LEAD_FLAG_FIELDS,
  computeLeadFlags,
  isFlagSet,
  leadFlagsPatch,
  backfillLeadFlags,
  revenueFromFlags,
};
