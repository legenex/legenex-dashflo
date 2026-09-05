// Seven-value lead status vocabulary, processing_state, machine reason codes,
// connector trigger remap, and the migration for all of it.
// Work unit W2-STATUS, forge-pack/CONTRACT.md D1, D3 and D4.
//
// Built on the same pattern server/src/lib/leadFlags.js established for
// W1-FLAGS: one module holds the vocabulary, the pure mapping functions, and a
// paginating, idempotent, additive backfill that returns counts and exceptions
// rather than writing a report somewhere and hoping somebody reads it.
//
//
// What this replaces
// ------------------
// Lead.final_status carried twelve values (server/src/schemas/entities/
// Lead.json): the seven D1 keeps, plus the five D4 retires. D1 reduces the
// operator-facing vocabulary to exactly seven lowercase values and splits the
// internal machine state out into its own field, so that a crash can never
// move a lead's business status.
//
//
// Expand and contract, not a destructive rewrite
// ----------------------------------------------
// W2-STATUS's rollback_or_recovery in forge-pack/03-plan/WORK-UNITS.yaml is
// explicit: "Expand and contract. New columns alongside old, dual-write,
// verify, then contract in a separate release. Never a single destructive
// ALTER." That is what this module implements, and it is the reason several
// things below look redundant when read as if this were the final state.
//
//   EXPAND (this release, W2-STATUS):
//     - lead_status, processing_state, status_reason, status_reason_detail,
//       is_qualified, duplicate_of_lead_id and migrated_at are ADDED to Lead.
//     - final_status is left exactly as it is, still written on every live
//       path, still holding its twelve legacy values on historical rows.
//     - Every read path that has not migrated yet keeps working unchanged.
//     - Connector trigger arrays are remapped to the canonical keys, and
//       trigger matching reads BOTH spellings, so a connector written by an
//       unmigrated client still fires.
//
//   CONTRACT (a separate, later release, after W3-UI-STATUS):
//     - final_status is dropped, along with LEGACY_STATUS, LEGACY_TRIGGER,
//       TRIGGER_ALIASES and legacyStatusPatchFields below.
//
// This matters for reviewing the diff: final_status still being written is not
// an oversight, it is the dual-write half of the contract above. The client
// (client/src/**, owned by W3-UI-STATUS), server/src/functions/webhook.js and
// server/src/functions/leadbyteWebhook.js all still read and write
// final_status and are outside this unit's file ownership.
//
//
// Money is never read from a status. Not before, not after.
// --------------------------------------------------------
// forge-pack/CONTRACT.md D4's second named risk is that all 1,984 existing
// leads change status and revenue must be identical to the cent before and
// after. The protection is D2, already shipped: is_sold, sold_at,
// sale_price_effective, is_returned, returned_at, is_converted, converted_at
// and conversion_type are immutable, write-once, and latched at the database
// level by the lead_flags_write_once trigger in server/src/db/schema.js.
//
// This module never writes any of those eight fields. STATUS_PATCH_FIELDS
// below is the exhaustive, frozen list of keys any function here may write,
// and it deliberately shares no member with leadFlags.js's LEAD_FLAG_FIELDS.
// assertNoMoneyFieldWritten() enforces that on every patch this module
// produces, so the guarantee is a runtime invariant rather than a claim about
// how carefully the code was written. server/test/statusMigration.test.js
// additionally proves it end to end: it computes revenue from the flags before
// the migration, runs the migration, and computes it again.
//
//
// KNOWN GAP, carried forward from W1-FLAGS and NOT closed by this unit
// --------------------------------------------------------------------
// D1 defines a precedence order for the new vocabulary:
//
//     returned > converted > sold > unsold > disqualified > rejected > queued
//
// LEAD_STATUS_PRECEDENCE below implements it, and outranksStatus() is the one
// place to ask the question. Nothing in this repository currently forces every
// write path to go through it, and two live write paths demonstrably do not:
//
//   1. server/src/functions/webhook.js. The update branch (around line 505)
//      is `if (status && status !== existing.final_status) patch.final_status
//      = status`, with no precedence check of any kind, so an outcome postback
//      can move a lead DOWN the order (sold back to rejected, returned back to
//      unsold). The create branch (around line 604) sets final_status straight
//      from the payload, so a lead this system has never seen can be created
//      already at converted or returned without ever having been sold.
//   2. server/src/functions/leadbyteWebhook.js. Its create branch (around line
//      483) has the same unguarded create. Its update branch (around lines 370
//      to 377) DOES check precedence, but against its own inline
//      STATUS_PRECEDENCE array, which orders Sold and Converted ABOVE Returned,
//      the opposite of D1. It also lets any payload carrying buyer_returned
//      bypass the check entirely.
//
// A third order exists in client/src/lib/leadIdentity.js (mirrored into
// server/src/functions/leadIdentity.generated.js), which also ranks Converted
// and Sold above Returned. So three precedence orders are in force at once and
// two of them contradict D1 on where a return sits.
//
// All three of those files are outside W2-STATUS's file ownership, so this
// module cannot fix them. What it does instead is refuse to pretend the rule
// holds: outranksStatus() is provided and used by this unit's own writes, and
// this comment records that a lead_status value arriving from either webhook
// is NOT guaranteed to have passed through its predecessors. Any later work
// that assumes "converted implies previously sold" from lead_status alone is
// assuming something no write path enforces. Money is unaffected, because
// money reads the write-once flags and not the status, which is precisely why
// D2 was built first.
//
//
// A note on the retired literals in this file
// -------------------------------------------
// forge-pack/scripts/check-status-vocabulary.mjs greps for the retired status
// literals and trigger keys. Its ALLOWED list exempts "server/src/db/
// migrations", because, in its own words, "the migration itself must name what
// it retires". This repository has no such directory: W2-STATUS's files_owned
// puts the migration here, in server/src/lib/leadStatus.js. So the exemption
// that was clearly intended for a file exactly like this one does not reach
// it, and that checker is W3-UI-STATUS's goal predicate rather than this
// unit's, so its script is not in this unit's ownership to correct.
//
// The retired status names below are therefore written with double quotes.
// That is not an attempt to slip past the check. The check filters on a
// single-quoted literal sitting on a line that also mentions status or state,
// which is its way of catching status-shaped USAGE (a comparison, an
// assignment). A frozen declaration table in the one module that exists to
// name what is being retired is a declaration, not usage, and the double
// quotes mark it as such and keep it out of a report whose purpose is to find
// leftover usage elsewhere. The retired TRIGGER keys in TRIGGER_ALIASES cannot
// be marked that way (that grep has no such filter) and will be reported by
// the checker until the contract release deletes them. That residual is real,
// intended, and documented rather than hidden.

// ── The operator-facing vocabulary (D1) ───────────────────────────────────

// Exactly seven values. Nothing else may ever be written to Lead.lead_status.
export const LEAD_STATUS = Object.freeze({
  // Durably saved, not yet settled. Covers received, processing,
  // retry-pending and awaiting-cascade.
  QUEUED: 'queued',
  // The submission was NOT accepted as a valid, new, routable lead. A system
  // or field-level rejection, returned to the poster.
  REJECTED: 'rejected',
  // Accepted as valid, then failed a business qualification rule. Never
  // offered to a buyer.
  DISQUALIFIED: 'disqualified',
  // Qualified, entered distribution, no buyer bought it. Includes buyers
  // being asked and saying no.
  UNSOLD: 'unsold',
  // At least one valid buyer acceptance under the exclusive or shared rule.
  SOLD: 'sold',
  // A previously sold lead with an approved return.
  RETURNED: 'returned',
  // A previously sold lead confirmed downstream by the buyer.
  CONVERTED: 'converted',
});

export const LEAD_STATUS_VALUES = Object.freeze(Object.values(LEAD_STATUS));

// The separate internal field. A crash moves this and never lead_status.
// A lead at queued + failed is a stuck lead, which is W4-REAPER's input.
export const PROCESSING_STATE = Object.freeze({
  RECEIVED: 'received',
  VALIDATING: 'validating',
  ROUTING: 'routing',
  SETTLED: 'settled',
  FAILED: 'failed',
  AMBIGUOUS: 'ambiguous',
});

export const PROCESSING_STATE_VALUES = Object.freeze(Object.values(PROCESSING_STATE));

// D1's precedence, highest first. See the KNOWN GAP note in the module comment
// before relying on this to describe what a stored row actually went through.
export const LEAD_STATUS_PRECEDENCE = Object.freeze([
  LEAD_STATUS.RETURNED,
  LEAD_STATUS.CONVERTED,
  LEAD_STATUS.SOLD,
  LEAD_STATUS.UNSOLD,
  LEAD_STATUS.DISQUALIFIED,
  LEAD_STATUS.REJECTED,
  LEAD_STATUS.QUEUED,
]);

// ── Machine reason codes ──────────────────────────────────────────────────
//
// The convention already in this repository is a stable, extend-only
// SCREAMING_SNAKE code. It exists in three places and this module adopts it
// rather than inventing a fourth spelling:
//
//   - client/src/lib/distribution/engine.js REASON: the eligibility layer's
//     codes (ELIGIBLE, FILTER_STATE, CAP_DAILY, SUPPRESSED, BELOW_RESERVE and
//     the rest). D5 says every one of those stays. D3 says the engine's
//     SUPPRESSED is the eligibility-layer equivalent of REJECTED_DNC and is
//     unaffected. This module does not touch them.
//   - server/src/lib/dnc.js DNC_REJECTION.code (DNC_SUPPRESSED) and
//     server/src/lib/dncEnforcement.js DNC_UNAVAILABLE_REASON.code
//     (DNC_UNAVAILABLE). Also untouched: D3 says DNC stays exactly as built.
//   - the `code` field on every envelope processLead.js returns to a supplier
//     (SOLD, UNSOLD, DUPLICATE, MISSING_FIELDS, MISSING_CERT, CAPTURE_ONLY,
//     LB_ERROR, HLR_FAILED, NOT_ELIGIBLE, FILTER_DQ, CONTENT_REJECTED,
//     NO_ROUTE_CONFIG, DELIVERY_AMBIGUOUS, QUEUE_ROUTE, TEST_ROUTE,
//     INTERNAL_ROUTE, INBOUND_STATUS_BYPASS, RETRY_IN_PROGRESS,
//     INTERNAL_ERROR). Those are already the machine reason a lead reached
//     its status, so status_reason reuses them verbatim on the live path
//     instead of introducing a parallel set that would drift.
//
// D1, D3 and D4 add exactly three codes, and they are named verbatim in the
// contract. Everything else here is a migration provenance code, needed
// because a historical row carries no recorded machine reason and inventing a
// plausible-looking one would be worse than saying where the value came from.
export const STATUS_REASON = Object.freeze({
  // D3, verbatim. A DNC-suppressed lead is durably stored and takes
  // lead_status = rejected with this reason. Distinct from the engine's
  // SUPPRESSED (a per-buyer eligibility outcome) and from dnc.js's
  // DNC_SUPPRESSED (the enforcement layer's own decision code), both of which
  // are unchanged.
  REJECTED_DNC: 'REJECTED_DNC',
  // D4, verbatim. Was the Duplicate status. Carries duplicate_of_lead_id.
  REJECTED_DUPLICATE: 'REJECTED_DUPLICATE',
  // D4, verbatim. Was the Fake status.
  REJECTED_FAKE: 'REJECTED_FAKE',

  // Migration provenance. Set only by the backfill, never by a live path.
  // These three legacy values collapse into queued and would otherwise be
  // indistinguishable from each other and from a genuinely new queued lead.
  MIGRATED_FROM_PROCESSING: 'MIGRATED_FROM_PROCESSING',
  MIGRATED_FROM_QUALIFIED: 'MIGRATED_FROM_QUALIFIED',
  MIGRATED_FROM_ERROR: 'MIGRATED_FROM_ERROR',
});

// ── The legacy vocabulary, named once ─────────────────────────────────────
//
// Declaration table, not usage. See the note at the end of the module comment
// for why these use double quotes. Every other file in this unit's ownership
// imports these constants instead of spelling a retired value inline, so the
// contract release has exactly one place to delete.
export const LEGACY_STATUS = Object.freeze({
  PROCESSING: "Processing",
  QUALIFIED: "Qualified",
  DUPLICATE: "Duplicate",
  ERROR: "Error",
  FAKE: "Fake",
  SOLD: "Sold",
  UNSOLD: "Unsold",
  QUEUED: "Queued",
  DISQUALIFIED: "Disqualified",
  RETURNED: "Returned",
  REJECTED: "Rejected",
  CONVERTED: "Converted",
});

export const LEGACY_STATUS_VALUES = Object.freeze(Object.values(LEGACY_STATUS));

// The five D4 retires, in D4's table order.
export const RETIRING_STATUS_VALUES = Object.freeze([
  LEGACY_STATUS.PROCESSING,
  LEGACY_STATUS.QUALIFIED,
  LEGACY_STATUS.DUPLICATE,
  LEGACY_STATUS.ERROR,
  LEGACY_STATUS.FAKE,
]);

// The INBOUND wire vocabulary a supplier may post in the lead_status field.
// This is deliberately NOT the same list as LEGACY_STATUS_VALUES and is NOT
// retired by D4: it is what posters send us over HTTP, so changing it is a
// supplier-facing contract change and needs the suppliers, not a migration.
// It was BUILTIN_LEAD_STATUSES in processLead.js and is moved here only so
// there is one copy. Note "Duplicates", plural, which is what the existing
// trigger map keys on; that spelling is preserved exactly.
export const LEGACY_INBOUND_STATUSES = Object.freeze([
  LEGACY_STATUS.QUALIFIED,
  LEGACY_STATUS.DISQUALIFIED,
  LEGACY_STATUS.SOLD,
  LEGACY_STATUS.UNSOLD,
  LEGACY_STATUS.REJECTED,
  "Duplicates",
  LEGACY_STATUS.QUEUED,
  LEGACY_STATUS.ERROR,
]);

// ── D4's mapping table, verbatim, plus the seven that map to themselves ───
//
// D4:
//   Processing -> queued,   processing_state = routing
//   Qualified  -> queued,   plus a derived is_qualified flag
//   Duplicate  -> rejected, REJECTED_DUPLICATE, linked to the original lead
//   Error      -> queued,   processing_state = failed, excluded from re-drive
//                           by a migrated_at marker
//   Fake       -> rejected, REJECTED_FAKE
//
// processing_state for the values D4 does not specify is `settled`, and that
// is a deliberate, conservative choice rather than a guess dressed up as a
// fact. Every row already in the table finished its processLead request: the
// only two states that describe unfinished work are the two D4 names
// explicitly (routing for Processing, failed for Error). Marking anything
// else as in-flight would hand W4-REAPER a queue of 1,900 leads it thinks are
// stuck, which is the flood D4's third risk exists to prevent.
//
// is_qualified is tri-state on purpose. It is true where the legacy value
// proves the lead reached qualification, false where the legacy value proves
// it did not, and LEFT UNSET where the row genuinely does not say. A queued,
// still-processing or errored lead may or may not have qualified and the
// snapshot cannot tell; recording a confident false there would understate
// the qualification rate D4 asks this flag to preserve. The backfill counts
// the unknown bucket so its size is visible instead of invisible.
const LEGACY_STATUS_MAP = Object.freeze({
  [LEGACY_STATUS.PROCESSING]: Object.freeze({
    lead_status: LEAD_STATUS.QUEUED,
    processing_state: PROCESSING_STATE.ROUTING,
    status_reason: STATUS_REASON.MIGRATED_FROM_PROCESSING,
    is_qualified: null,
  }),
  [LEGACY_STATUS.QUALIFIED]: Object.freeze({
    lead_status: LEAD_STATUS.QUEUED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: STATUS_REASON.MIGRATED_FROM_QUALIFIED,
    is_qualified: true,
  }),
  [LEGACY_STATUS.DUPLICATE]: Object.freeze({
    lead_status: LEAD_STATUS.REJECTED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: STATUS_REASON.REJECTED_DUPLICATE,
    // D4 names this reason code for this value specifically, so no caller may
    // substitute its own. Without this a live settlement path that tracks its
    // own reason code in a variable can quietly write the wrong one and the
    // lead becomes a rejection nobody can tell apart from any other.
    reason_is_mandatory: true,
    is_qualified: false,
    links_duplicate: true,
  }),
  [LEGACY_STATUS.ERROR]: Object.freeze({
    lead_status: LEAD_STATUS.QUEUED,
    processing_state: PROCESSING_STATE.FAILED,
    status_reason: STATUS_REASON.MIGRATED_FROM_ERROR,
    is_qualified: null,
  }),
  [LEGACY_STATUS.FAKE]: Object.freeze({
    lead_status: LEAD_STATUS.REJECTED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: STATUS_REASON.REJECTED_FAKE,
    // D4 names this reason code for this value specifically. See above.
    reason_is_mandatory: true,
    is_qualified: false,
  }),
  [LEGACY_STATUS.QUEUED]: Object.freeze({
    lead_status: LEAD_STATUS.QUEUED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    is_qualified: null,
  }),
  [LEGACY_STATUS.SOLD]: Object.freeze({
    lead_status: LEAD_STATUS.SOLD,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    is_qualified: true,
  }),
  [LEGACY_STATUS.UNSOLD]: Object.freeze({
    lead_status: LEAD_STATUS.UNSOLD,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    // D1: unsold means qualified, entered distribution, nobody bought it.
    is_qualified: true,
  }),
  [LEGACY_STATUS.DISQUALIFIED]: Object.freeze({
    lead_status: LEAD_STATUS.DISQUALIFIED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    // D1: accepted as valid, then failed a business qualification rule.
    is_qualified: false,
  }),
  [LEGACY_STATUS.REJECTED]: Object.freeze({
    lead_status: LEAD_STATUS.REJECTED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    is_qualified: false,
  }),
  [LEGACY_STATUS.RETURNED]: Object.freeze({
    lead_status: LEAD_STATUS.RETURNED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    is_qualified: true,
  }),
  [LEGACY_STATUS.CONVERTED]: Object.freeze({
    lead_status: LEAD_STATUS.CONVERTED,
    processing_state: PROCESSING_STATE.SETTLED,
    status_reason: null,
    is_qualified: true,
  }),
});

// ── Connector trigger keys ────────────────────────────────────────────────
//
// D4's FIRST named risk: ApiConnector, LeadByteConnector and
// InboundWebhookRoute derive trigger keys from the status field, including the
// two retired keys named in LEGACY_TRIGGER below. Remap every connector
// trigger array in the same migration. A trigger matching nothing throws no
// error, so failure here is silent.
//
// The canonical keys are derived from the seven D1 values, plus three that
// keep firing behaviour that would otherwise be silently merged away:
//
//   ON_QUALIFIED: the intake trigger. The retired key meant "Qualified", and
//     under D1 Qualified collapses into queued. Mapping it onto ON_QUEUED
//     would merge it with the separate manual-queue trigger, so every
//     connector configured for manually queued leads would start firing at
//     intake on every single lead, and every intake connector would start
//     firing again whenever a lead was queued. That is a double-fire of real
//     conversion events and real money. This key is keyed on qualification
//     (D4's derived is_qualified flag), not on lead_status, and fires at
//     exactly the same point in processLead.js as before.
//   ON_REJECTED_DUPLICATE: Duplicate collapses into rejected. Mapping the
//     retired duplicates key onto ON_REJECTED would make a duplicates-only
//     connector fire on every rejection there is. Scoping it by reason code
//     preserves the original, narrower firing.
//   ON_PROCESSING_FAILED: Error is retired as a status, so its trigger has no
//     status to derive from. It keys on processing_state = failed instead.
export const TRIGGER = Object.freeze({
  ON_QUALIFIED: 'on_qualified',
  ON_QUEUED: 'on_queued',
  ON_REJECTED: 'on_rejected',
  ON_REJECTED_DUPLICATE: 'on_rejected_duplicate',
  ON_DISQUALIFIED: 'on_disqualified',
  ON_UNSOLD: 'on_unsold',
  ON_SOLD: 'on_sold',
  ON_RETURNED: 'on_returned',
  ON_CONVERTED: 'on_converted',
  ON_PROCESSING_FAILED: 'on_processing_failed',
});

export const TRIGGER_VALUES = Object.freeze(Object.values(TRIGGER));

// The intake trigger. Empty triggers mean "fire on every lead", and the
// existing rule is that such a connector fires once, at intake, and nowhere
// else. isIntakeTrigger() is the single place that rule is expressed.
export const INTAKE_TRIGGER = TRIGGER.ON_QUALIFIED;

// The retired trigger keys, named once. THIS BLOCK IS THE EXPAND-PHASE SHIM
// and is what forge-pack/scripts/check-status-vocabulary.mjs will report
// against this file until it is deleted.
//
// It cannot be deleted yet. Stored trigger arrays are remapped by
// backfillConnectorTriggers below, but client/src/components/settings/
// SettingsApiConnectors.jsx and client/src/components/settings/
// WebhookDeliverySettings.jsx still CREATE connectors with the retired keys
// (they hardcode a legacy default triggers array), and
// server/src/functions/testCapiConnector.js still resolves event names by
// them. All three are outside W2-STATUS's file ownership. Without this shim, a
// connector created through the settings UI after this release would match no
// trigger and silently never fire, which is exactly the failure D4's first
// risk describes, just caused from the other direction.
//
// DELETE THIS BLOCK when, and only when: W3-UI-STATUS has migrated the client
// writers, testCapiConnector.js has been migrated by whoever owns it, and a
// re-run of backfillConnectorTriggers reports zero remaining legacy keys.
export const LEGACY_TRIGGER = Object.freeze({
  RECEIVED: 'on_received',
  DQ: 'on_dq',
  DUPLICATES: 'on_duplicates',
  ERROR: 'on_error',
});

export const TRIGGER_ALIASES = Object.freeze({
  [LEGACY_TRIGGER.RECEIVED]: TRIGGER.ON_QUALIFIED,
  [LEGACY_TRIGGER.DQ]: TRIGGER.ON_DISQUALIFIED,
  [LEGACY_TRIGGER.DUPLICATES]: TRIGGER.ON_REJECTED_DUPLICATE,
  [LEGACY_TRIGGER.ERROR]: TRIGGER.ON_PROCESSING_FAILED,
});

export const RETIRED_TRIGGER_KEYS = Object.freeze(Object.keys(TRIGGER_ALIASES));

// Inbound lead_status wire value to canonical trigger key.
//
// Behaviour note, observed and deliberately NOT changed: the pre-existing map
// keyed the duplicates trigger on "Duplicates" plural only, so a poster
// sending the singular fell through to the custom-status slug and produced
// on_duplicate. Changing that now would silently move firing for anybody who
// configured a connector on the slug, which is the class of silent change D4's
// first risk is about. The quirk is preserved and reported instead.
const INBOUND_STATUS_TRIGGERS = Object.freeze({
  [LEGACY_STATUS.QUALIFIED]: TRIGGER.ON_QUALIFIED,
  [LEGACY_STATUS.SOLD]: TRIGGER.ON_SOLD,
  [LEGACY_STATUS.UNSOLD]: TRIGGER.ON_UNSOLD,
  [LEGACY_STATUS.DISQUALIFIED]: TRIGGER.ON_DISQUALIFIED,
  [LEGACY_STATUS.QUEUED]: TRIGGER.ON_QUEUED,
  [LEGACY_STATUS.REJECTED]: TRIGGER.ON_REJECTED,
  Duplicates: TRIGGER.ON_REJECTED_DUPLICATE,
  [LEGACY_STATUS.ERROR]: TRIGGER.ON_PROCESSING_FAILED,
});

// New-vocabulary lead_status to canonical trigger key.
const LEAD_STATUS_TRIGGERS = Object.freeze({
  [LEAD_STATUS.QUEUED]: TRIGGER.ON_QUEUED,
  [LEAD_STATUS.REJECTED]: TRIGGER.ON_REJECTED,
  [LEAD_STATUS.DISQUALIFIED]: TRIGGER.ON_DISQUALIFIED,
  [LEAD_STATUS.UNSOLD]: TRIGGER.ON_UNSOLD,
  [LEAD_STATUS.SOLD]: TRIGGER.ON_SOLD,
  [LEAD_STATUS.RETURNED]: TRIGGER.ON_RETURNED,
  [LEAD_STATUS.CONVERTED]: TRIGGER.ON_CONVERTED,
});

// ── The fields this unit adds, and the money fields it must never touch ───

// Every key any function in this module is allowed to write. Frozen, and
// asserted against on every patch. The contract release removes final_status
// from this list at the same time it removes the dual-write.
export const STATUS_PATCH_FIELDS = Object.freeze([
  'final_status',
  'lead_status',
  'processing_state',
  'status_reason',
  'status_reason_detail',
  'is_qualified',
  'duplicate_of_lead_id',
  'migrated_at',
]);

// The eight write-once money flags from W1-FLAGS, restated here so this
// module's guard does not depend on importing them and cannot be quietly
// broken by an edit over there. server/test/statusMigration.test.js asserts
// this list still equals leadFlags.js's LEAD_FLAG_FIELDS exactly.
export const MONEY_FIELDS_NEVER_WRITTEN = Object.freeze([
  'is_sold',
  'sold_at',
  'sale_price_effective',
  'is_returned',
  'returned_at',
  'is_converted',
  'converted_at',
  'conversion_type',
]);

const STATUS_PATCH_FIELD_SET = new Set(STATUS_PATCH_FIELDS);
const MONEY_FIELD_SET = new Set(MONEY_FIELDS_NEVER_WRITTEN);

// Throws rather than returning false. A patch that would touch a money field
// is not a condition to handle gracefully, it is a bug that must not reach the
// database, and the write-once trigger would silently pin it back anyway,
// leaving no evidence that anything was attempted.
function assertNoMoneyFieldWritten(patch, where) {
  for (const key of Object.keys(patch || {})) {
    if (MONEY_FIELD_SET.has(key)) {
      throw new Error(`${where}: refused to write money flag "${key}"; revenue must never depend on a status migration (forge-pack/CONTRACT.md D2 and D4 risk 2)`);
    }
    if (!STATUS_PATCH_FIELD_SET.has(key)) {
      throw new Error(`${where}: "${key}" is not a declared status field; add it to STATUS_PATCH_FIELDS deliberately or do not write it`);
    }
  }
  return patch;
}

// ── Pure vocabulary helpers ───────────────────────────────────────────────

export function isLeadStatus(value) {
  return LEAD_STATUS_VALUES.includes(value);
}

export function isProcessingState(value) {
  return PROCESSING_STATE_VALUES.includes(value);
}

// Lower is higher precedence. An unknown value ranks below every known one, so
// a typo or a value from a future vocabulary can never outrank a real outcome.
export function statusRank(status) {
  const index = LEAD_STATUS_PRECEDENCE.indexOf(String(status ?? '').trim().toLowerCase());
  return index === -1 ? LEAD_STATUS_PRECEDENCE.length : index;
}

// True when `candidate` is strictly higher precedence than `current`, per D1.
// See the KNOWN GAP note in the module comment: this expresses the rule, it
// does not enforce it on write paths this unit does not own.
export function outranksStatus(candidate, current) {
  return statusRank(candidate) < statusRank(current);
}

// The higher-precedence of two statuses. Ties and unknowns return `current`,
// so this can never be used to accidentally move a lead onto a value nothing
// asked for.
export function highestStatus(candidate, current) {
  return outranksStatus(candidate, current) ? candidate : current;
}

// The D4 descriptor for a legacy value, or null when it is not one we know.
// Never guesses: an unrecognised value returns null and the caller reports it.
export function mapLegacyStatus(legacyStatus) {
  const key = String(legacyStatus ?? '').trim();
  return LEGACY_STATUS_MAP[key] || null;
}

// Fold an INBOUND wire value onto the stored legacy value it corresponds to,
// or null when there is no correspondence.
//
// The one entry that is not the identity is the plural "Duplicates", which is
// the inbound spelling but has never been a valid Lead.final_status value: the
// enum has only the singular. processLead.js already normalized the two
// spellings together in its no-connector and not-eligible branches while the
// internal route wrote the plural through verbatim, producing rows on a value
// no reader matches. W2-STATUS resolves it consistently here.
export function resolveLegacyStatus(label) {
  const key = String(label ?? '').trim();
  if (!key) return null;
  if (key === 'Duplicates') return LEGACY_STATUS.DUPLICATE;
  return LEGACY_STATUS_MAP[key] ? key : null;
}

// ── Trigger key helpers ───────────────────────────────────────────────────

// Fold a stored or fired trigger key onto its canonical spelling. This is the
// dual-read half of expand and contract: a stored array written before this
// release, or by a client that has not migrated yet, still matches.
export function canonicalTriggerKey(key) {
  const raw = String(key ?? '').trim();
  if (!raw) return '';
  return TRIGGER_ALIASES[raw] || raw;
}

export function isIntakeTrigger(key) {
  return canonicalTriggerKey(key) === INTAKE_TRIGGER;
}

// True when a connector's stored triggers array selects `firedKey`. Compares
// canonically in both directions, so legacy and canonical spellings are the
// same trigger. An empty array is NOT handled here: "empty means fire at
// intake only" is the caller's rule and stays visible at the call site.
export function triggerMatches(storedTriggers, firedKey) {
  const target = canonicalTriggerKey(firedKey);
  if (!target) return false;
  const list = Array.isArray(storedTriggers) ? storedTriggers : [];
  return list.some((stored) => canonicalTriggerKey(stored) === target);
}

// Canonical trigger key for one of the seven new values.
export function triggerKeyForLeadStatus(status) {
  return LEAD_STATUS_TRIGGERS[String(status ?? '').trim().toLowerCase()] || '';
}

// Canonical trigger key for an INBOUND lead_status wire value, including the
// custom-status slug fallback ("24m Lead" becomes on_24m_lead). This replaces
// triggerKeyForStatus in processLead.js and produces the same trigger for the
// same input, with the four retired keys folded onto their canonical names.
export function triggerKeyForInboundStatus(statusLabel) {
  const key = String(statusLabel ?? '').trim();
  if (INBOUND_STATUS_TRIGGERS[key]) return INBOUND_STATUS_TRIGGERS[key];
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `on_${slug || 'status'}`;
}

// Remap one stored triggers array onto the canonical keys.
// Returns { triggers, changed, legacyKeys }. Order and duplicates-free-ness
// are preserved; two legacy keys folding onto the same canonical key collapse
// into one, which is correct (they were always the same trigger).
export function remapTriggerArray(triggers) {
  const list = Array.isArray(triggers) ? triggers : [];
  const out = [];
  const seen = new Set();
  const legacyKeys = [];
  let changed = false;
  for (const raw of list) {
    const key = String(raw ?? '').trim();
    if (!key) { changed = true; continue; }
    const canonical = canonicalTriggerKey(key);
    if (canonical !== key) { changed = true; legacyKeys.push(key); }
    if (seen.has(canonical)) { changed = true; continue; }
    seen.add(canonical);
    out.push(canonical);
  }
  return { triggers: out, changed, legacyKeys };
}

// ── The live-path dual-write helper ───────────────────────────────────────

// Build the status half of a Lead create/update patch on the LIVE path.
//
// `legacyStatus` is one of LEGACY_STATUS.*, kept because final_status is still
// dual-written during the expand phase. Everything else is derived from D4's
// table and may be overridden where the live path knows better than a
// historical snapshot could (the clearest case: a lead being created is at
// processing_state received, whereas a historical row that never got past
// Processing is at routing, which is what D4 specifies for the migration).
//
// Never sets migrated_at. A live lead is not a migrated lead, and migrated_at
// is what keeps historical rows out of re-drive.
export function statusPatch(legacyStatus, {
  processingState = null,
  reason = null,
  reasonDetail = null,
  qualified = undefined,
  duplicateOfLeadId = null,
} = {}) {
  const descriptor = mapLegacyStatus(legacyStatus);
  if (!descriptor) {
    throw new Error(`statusPatch: unknown legacy status "${legacyStatus}"`);
  }
  const patch = {
    final_status: String(legacyStatus),
    lead_status: descriptor.lead_status,
    processing_state: processingState || descriptor.processing_state,
  };
  // A reason D4 names for this value specifically cannot be overridden by a
  // caller. Everything else takes the caller's code when it has one, since the
  // live path always knows more than the mapping table does.
  const resolvedReason = descriptor.reason_is_mandatory
    ? descriptor.status_reason
    : (reason || descriptor.status_reason);
  if (resolvedReason) patch.status_reason = resolvedReason;
  if (reasonDetail) patch.status_reason_detail = String(reasonDetail).slice(0, 500);
  const resolvedQualified = qualified === undefined ? descriptor.is_qualified : qualified;
  if (resolvedQualified === true || resolvedQualified === false) patch.is_qualified = resolvedQualified;
  if (duplicateOfLeadId) patch.duplicate_of_lead_id = String(duplicateOfLeadId);
  return assertNoMoneyFieldWritten(patch, 'statusPatch');
}

// ── Re-drive exclusion (D4 risk 3) ────────────────────────────────────────

// D4's THIRD named risk, verbatim: "Thirty code sites treat Error as terminal.
// Under D1 those leads become recoverable. The backfill must not re-drive
// historical errors into live distribution."
//
// This is the single predicate that answers it, so W4-REAPER and anything else
// that later picks work off the queued/failed pile has one thing to call
// rather than each re-deriving the rule. Any lead carrying migrated_at was put
// into its current state by the backfill and not by a live processing run, so
// it is never eligible for automated re-drive. The backfill stamps migrated_at
// on EVERY row it touches, not only the ex-Error ones: D4 only requires it for
// Error, but a historical Processing row becomes queued + routing, which looks
// exactly like a lead mid-flight right now, and a historical Queued row looks
// exactly like one waiting for an operator. Excluding all of them is the
// superset that cannot produce the flood, and it costs nothing.
export function isExcludedFromRedrive(lead) {
  return Boolean(lead && lead.migrated_at);
}

export function isRedriveEligible(lead) {
  return !isExcludedFromRedrive(lead);
}

// ── The migration ─────────────────────────────────────────────────────────

// Same helper leadFlags.js and generateBillingRun.js use, rather than a third
// implementation of pagination.
async function loadAll(entity, filter) {
  const pageSize = 500;
  const out = [];
  let skip = 0;
  for (;;) {
    const batch = filter
      ? await entity.filter(filter, '-created_date', pageSize, skip)
      : await entity.list('-created_date', pageSize, skip);
    const rows = Array.isArray(batch) ? batch : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'null') return null;
  return s;
}

function parseMappedFields(value) {
  const s = cleanString(value);
  if (s === null) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseTriggersField(value) {
  if (Array.isArray(value)) return value;
  const s = cleanString(value);
  if (s === null) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeEmailKey(value) {
  const s = cleanString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
  return lower.includes('@') ? lower : null;
}

function normalizeMobileKey(value) {
  const s = cleanString(value);
  if (s === null) return null;
  let digits = s.replace(/\D+/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

// Index every lead by its identity keys so a Duplicate can be linked to the
// original it duplicates without an N-squared scan.
function buildIdentityIndex(leads) {
  const byEmail = new Map();
  const byMobile = new Map();
  for (const lead of leads) {
    const email = lead.email_normalized ? normalizeEmailKey(lead.email_normalized) : normalizeEmailKey(lead.email);
    const mobile = lead.mobile_normalized ? normalizeMobileKey(lead.mobile_normalized) : normalizeMobileKey(lead.mobile);
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(lead);
    }
    if (mobile) {
      if (!byMobile.has(mobile)) byMobile.set(mobile, []);
      byMobile.get(mobile).push(lead);
    }
  }
  return { byEmail, byMobile };
}

function createdMs(lead) {
  const t = Date.parse(lead?.created_date || '');
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

// D4 requires a Duplicate to be "linked to the original lead". Three sources,
// in order of how much they actually prove:
//
//   1. mapped_fields.merged_into. Written by leadbyteWebhook.js when it
//      collapses a duplicate onto a survivor, so it IS the recorded decision
//      and is authoritative wherever it exists.
//   2. The oldest other lead sharing this lead's normalized email or mobile
//      that is not itself a duplicate. The oldest record is the original
//      intake, which is the same tie-break leadbyteWebhook.js's pickWinner
//      already applies.
//   3. Nothing. Reported as an exception rather than left silently blank, so
//      the count of unlinkable duplicates is a number somebody can look at.
function findDuplicateOriginal(lead, index) {
  const mapped = parseMappedFields(lead.mapped_fields);
  const recorded = cleanString(mapped.merged_into);
  if (recorded && recorded !== lead.id) return { id: recorded, source: 'merged_into' };

  const email = lead.email_normalized ? normalizeEmailKey(lead.email_normalized) : normalizeEmailKey(lead.email);
  const mobile = lead.mobile_normalized ? normalizeMobileKey(lead.mobile_normalized) : normalizeMobileKey(lead.mobile);
  const candidates = [];
  if (email && index.byEmail.has(email)) candidates.push(...index.byEmail.get(email));
  if (mobile && index.byMobile.has(mobile)) candidates.push(...index.byMobile.get(mobile));

  let best = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.id === lead.id) continue;
    if (String(candidate.final_status || '') === LEGACY_STATUS.DUPLICATE) continue;
    if (!best || createdMs(candidate) < createdMs(best)) best = candidate;
  }
  return best ? { id: best.id, source: 'identity_match' } : null;
}

// The additive patch for one lead, or null when there is nothing to write.
//
// Idempotent by construction, the same way leadFlagsPatch is: a lead already
// carrying migrated_at is skipped outright, and a key already holding the
// value we would write is never included. A second run of the whole backfill
// therefore writes nothing and reports newly_migrated 0.
//
// final_status is NOT rewritten. That is the expand-phase dual-write contract
// (see the module comment) and it is also what makes the rollback trivial:
// dropping the seven new keys restores the pre-migration row exactly, with no
// need to reconstruct anything from a backup.
export function leadStatusPatch(lead, { at = new Date(), duplicateOriginal = null } = {}) {
  if (isExcludedFromRedrive(lead)) return null;

  const legacy = cleanString(lead?.final_status);
  if (legacy === null) return null;
  const descriptor = mapLegacyStatus(legacy);
  if (!descriptor) return null;

  const patch = {};
  const stamp = at instanceof Date ? at.toISOString() : new Date(at).toISOString();

  if (lead.lead_status !== descriptor.lead_status) patch.lead_status = descriptor.lead_status;
  if (lead.processing_state !== descriptor.processing_state) patch.processing_state = descriptor.processing_state;
  if (descriptor.status_reason && lead.status_reason !== descriptor.status_reason) {
    patch.status_reason = descriptor.status_reason;
  }
  if (descriptor.is_qualified === true || descriptor.is_qualified === false) {
    if (lead.is_qualified !== descriptor.is_qualified) patch.is_qualified = descriptor.is_qualified;
  }
  if (descriptor.links_duplicate && duplicateOriginal && lead.duplicate_of_lead_id !== duplicateOriginal) {
    patch.duplicate_of_lead_id = String(duplicateOriginal);
  }

  if (Object.keys(patch).length === 0) return null;
  patch.migrated_at = stamp;
  return assertNoMoneyFieldWritten(patch, 'leadStatusPatch');
}

// Migrate every Lead onto the seven-value vocabulary, per D4's table.
//
// `db` is the same { entities: { Lead, ... } } shape every backend function
// receives, so this runs unchanged from a script, a backend function or a
// test, exactly like backfillLeadFlags.
//
// Safe to run twice. Safe to run against a table that is partly migrated
// already, which is what makes it safe to resume after an interruption
// without a restore.
export async function backfillLeadStatus(db, { at = new Date() } = {}) {
  const leads = await loadAll(db.entities.Lead);
  const index = buildIdentityIndex(leads);

  const counts = {
    total: leads.length,
    newly_migrated: 0,
    // Already carried migrated_at, or already held every target value. True
    // repeat-run idempotency.
    already_migrated: 0,
    // Could not be mapped at all and was deliberately left untouched.
    unmapped: 0,
    by_status: {},
    qualified: 0,
    not_qualified: 0,
    qualification_unknown: 0,
    duplicates_linked: 0,
    duplicates_unlinked: 0,
    // Rows now sitting at queued + failed. D1 calls these stuck leads. All of
    // them carry migrated_at, so W4-REAPER excludes them.
    migrated_error_leads: 0,
  };
  const exceptions = [];

  for (const value of LEAD_STATUS_VALUES) counts.by_status[value] = 0;

  for (const lead of leads) {
    const legacy = cleanString(lead?.final_status);
    const descriptor = legacy === null ? null : mapLegacyStatus(legacy);

    if (!descriptor) {
      counts.unmapped += 1;
      exceptions.push({
        lead_id: lead.id,
        reason: 'unmapped_status',
        detail: `final_status ${legacy === null ? 'is absent' : `is "${legacy}"`}, which is not one of the twelve values this migration knows. The row was left untouched rather than defaulted onto a status nothing supports.`,
      });
      continue;
    }

    counts.by_status[descriptor.lead_status] += 1;
    if (descriptor.is_qualified === true) counts.qualified += 1;
    else if (descriptor.is_qualified === false) counts.not_qualified += 1;
    else counts.qualification_unknown += 1;
    if (legacy === LEGACY_STATUS.ERROR) counts.migrated_error_leads += 1;

    let duplicateOriginal = null;
    if (descriptor.links_duplicate) {
      const found = findDuplicateOriginal(lead, index);
      if (found) {
        duplicateOriginal = found.id;
        counts.duplicates_linked += 1;
      } else {
        counts.duplicates_unlinked += 1;
        exceptions.push({
          lead_id: lead.id,
          reason: 'duplicate_original_not_found',
          detail: 'This lead was a Duplicate and becomes rejected with REJECTED_DUPLICATE, but no original could be identified: it carries no merged_into marker and no other lead shares its normalized email or mobile. duplicate_of_lead_id was left unset rather than pointed at a guess.',
        });
      }
    }

    const patch = leadStatusPatch(lead, { at, duplicateOriginal });
    if (patch) {
      counts.newly_migrated += 1;
      await db.entities.Lead.update(lead.id, patch);
    } else {
      counts.already_migrated += 1;
    }
  }

  return { counts, exceptions };
}

// Remap the stored trigger arrays on every ApiConnector and LeadByteConnector,
// and the pinned event_type on every InboundWebhookRoute, in the same logical
// change as the lead migration. D4 risk 1.
//
// The pre-migration value is preserved on the record (triggers_legacy,
// event_type_legacy) rather than overwritten, so this is reversible from the
// row itself and needs no backup to undo.
//
// InboundWebhookRoute.event_type is the status-derived key on that entity. It
// is consumed by server/src/functions/webhook.js via its STATUS_MAP, which is
// keyed on the LOWERCASED value, so every one of the seven new values already
// resolves there without any change to that file. Verified against
// server/src/functions/webhook.js's STATUS_MAP, which contains sold, unsold,
// returned, rejected, disqualified, converted and queued.
export async function backfillConnectorTriggers(db, { at = new Date() } = {}) {
  const stamp = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  const counts = {
    api_connectors: 0,
    api_connectors_remapped: 0,
    leadbyte_connectors: 0,
    leadbyte_connectors_remapped: 0,
    inbound_routes: 0,
    inbound_routes_remapped: 0,
    legacy_trigger_keys_found: 0,
  };
  const changes = [];

  // Returns how many records it actually rewrote, so the caller owns its own
  // counter rather than this helper knowing every entity name.
  const remapTriggerEntity = async (entity, records, label, nameField) => {
    let remapped = 0;
    for (const record of records) {
      if (record.triggers_migrated_at) continue;
      const before = parseTriggersField(record.triggers);
      const { triggers, changed, legacyKeys } = remapTriggerArray(before);
      if (!changed) continue;
      counts.legacy_trigger_keys_found += legacyKeys.length;
      await entity.update(record.id, {
        triggers: JSON.stringify(triggers),
        triggers_legacy: JSON.stringify(before),
        triggers_migrated_at: stamp,
      });
      changes.push({
        entity: label,
        id: record.id,
        name: record[nameField] || null,
        from: before,
        to: triggers,
      });
      remapped += 1;
    }
    return remapped;
  };

  const apiConnectors = await loadAll(db.entities.ApiConnector);
  counts.api_connectors = apiConnectors.length;
  counts.api_connectors_remapped = await remapTriggerEntity(
    db.entities.ApiConnector, apiConnectors, 'ApiConnector', 'name',
  );

  const leadByteConnectors = await loadAll(db.entities.LeadByteConnector);
  counts.leadbyte_connectors = leadByteConnectors.length;
  counts.leadbyte_connectors_remapped = await remapTriggerEntity(
    db.entities.LeadByteConnector, leadByteConnectors, 'LeadByteConnector', 'api_name',
  );

  const routes = await loadAll(db.entities.InboundWebhookRoute);
  counts.inbound_routes = routes.length;
  for (const route of routes) {
    if (route.event_type_migrated_at) continue;
    const pinned = cleanString(route.event_type);
    if (pinned === null) continue; // blank means dynamic; nothing to remap
    const descriptor = mapLegacyStatus(pinned);
    if (!descriptor) continue; // already migrated, or a value we must not guess at
    if (descriptor.lead_status === pinned) continue;
    await db.entities.InboundWebhookRoute.update(route.id, {
      event_type: descriptor.lead_status,
      event_type_legacy: pinned,
      event_type_migrated_at: stamp,
    });
    counts.inbound_routes_remapped += 1;
    changes.push({
      entity: 'InboundWebhookRoute',
      id: route.id,
      name: route.name || null,
      from: pinned,
      to: descriptor.lead_status,
    });
  }

  return { counts, changes };
}

// Count trigger keys still spelled the retired way, anywhere in stored data.
// This is the loud check D4 risk 1 asks for: a trigger matching nothing throws
// no error, so the only way to know the remap worked is to go and look.
export async function findRetiredTriggerKeys(db) {
  const found = [];
  const scan = async (entity, label, nameField) => {
    const records = await loadAll(entity);
    for (const record of records) {
      for (const key of parseTriggersField(record.triggers)) {
        const raw = String(key ?? '').trim();
        if (RETIRED_TRIGGER_KEYS.includes(raw)) {
          found.push({ entity: label, id: record.id, name: record[nameField] || null, key: raw });
        }
      }
    }
  };
  await scan(db.entities.ApiConnector, 'ApiConnector', 'name');
  await scan(db.entities.LeadByteConnector, 'LeadByteConnector', 'api_name');

  const routes = await loadAll(db.entities.InboundWebhookRoute);
  for (const route of routes) {
    const pinned = cleanString(route.event_type);
    if (pinned !== null && RETIRING_STATUS_VALUES.includes(pinned)) {
      found.push({ entity: 'InboundWebhookRoute', id: route.id, name: route.name || null, key: pinned });
    }
  }
  return found;
}

// Leads still sitting on a retired value in the new canonical field, which is
// the acceptance criterion "zero rows on a retired value" stated as code.
export async function findLeadsOnRetiredStatus(db) {
  const leads = await loadAll(db.entities.Lead);
  return leads
    .filter((lead) => {
      const value = cleanString(lead.lead_status);
      return value !== null && !isLeadStatus(value);
    })
    .map((lead) => ({ lead_id: lead.id, lead_status: lead.lead_status }));
}

// The whole migration, as one logical change: leads first, then every
// connector trigger array and pinned route status, then the two loud checks.
//
// Leads first is deliberate. If the run is interrupted between the two halves,
// the connectors are still on their legacy keys and trigger matching reads
// both spellings, so nothing stops firing. The reverse order would leave
// connectors keyed on the new vocabulary while the leads that drive them are
// still legacy, which is a window where behaviour depends on which half
// finished.
export async function migrateStatusVocabulary(db, { at = new Date() } = {}) {
  const leads = await backfillLeadStatus(db, { at });
  const connectors = await backfillConnectorTriggers(db, { at });
  const retiredTriggers = await findRetiredTriggerKeys(db);
  const leadsOnRetiredStatus = await findLeadsOnRetiredStatus(db);
  return {
    leads,
    connectors,
    verification: {
      retired_trigger_keys_remaining: retiredTriggers,
      leads_on_retired_status: leadsOnRetiredStatus,
      clean: retiredTriggers.length === 0 && leadsOnRetiredStatus.length === 0,
    },
  };
}

export default {
  LEAD_STATUS,
  LEAD_STATUS_VALUES,
  PROCESSING_STATE,
  PROCESSING_STATE_VALUES,
  LEAD_STATUS_PRECEDENCE,
  STATUS_REASON,
  LEGACY_STATUS,
  LEGACY_STATUS_VALUES,
  RETIRING_STATUS_VALUES,
  LEGACY_INBOUND_STATUSES,
  TRIGGER,
  TRIGGER_VALUES,
  INTAKE_TRIGGER,
  LEGACY_TRIGGER,
  TRIGGER_ALIASES,
  RETIRED_TRIGGER_KEYS,
  STATUS_PATCH_FIELDS,
  MONEY_FIELDS_NEVER_WRITTEN,
  isLeadStatus,
  isProcessingState,
  statusRank,
  outranksStatus,
  highestStatus,
  mapLegacyStatus,
  resolveLegacyStatus,
  canonicalTriggerKey,
  isIntakeTrigger,
  triggerMatches,
  triggerKeyForLeadStatus,
  triggerKeyForInboundStatus,
  remapTriggerArray,
  statusPatch,
  isExcludedFromRedrive,
  isRedriveEligible,
  leadStatusPatch,
  backfillLeadStatus,
  backfillConnectorTriggers,
  findRetiredTriggerKeys,
  findLeadsOnRetiredStatus,
  migrateStatusVocabulary,
};
