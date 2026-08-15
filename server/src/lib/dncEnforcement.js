// Global do-not-contact enforcement. The intake-facing half of task I2.
//
// lib/dnc.js holds the pure rules: normalization, keyed hashing, the effective
// window, scope, and the decision over an already-fetched candidate set. This
// module is the one place that turns those rules into a decision about a real
// lead, by looking the hashes up in the database.
//
// It exists so that "enforcement is identical across every real intake source"
// is a property of one function rather than a habit repeated in each caller.
// Supplier HTTP, Meta, owned forms, calls, CSV and recovery jobs all call this.
//
// Relationship to the other suppression in this system
// ----------------------------------------------------
// There are two, and they are not the same thing:
//
//   - Global DNC, here. A person asked not to be contacted at all. It runs as
//     the first business validation after durable capture, before routing, and
//     a hit means the lead is never contacted or delivered to anyone.
//   - Route member suppression, in lib/distribution/engine.js. A buyer keeps
//     its own list of contacts it does not want. It runs inside routing, per
//     member, and a hit only makes that one member ineligible; the lead can
//     still be sold to a different buyer.
//
// Neither replaces the other, and this module deliberately does not touch the
// routing engine. See dncEnforcement.test.js, which asserts both still hold.
//
// Failing closed without losing the lead
// --------------------------------------
// Two requirements pull in opposite directions here. Losing a paid lead is
// catastrophic, and contacting somebody who opted out is a legal and ethical
// failure. So when the list cannot be consulted, this returns UNAVAILABLE
// rather than guessing. UNAVAILABLE is not a rejection and not a pass: the
// receipt is already durable at this point, so the caller holds the lead as
// retryable. Nothing is delivered, and nothing is thrown away.

import {
  DNC_REJECTION,
  contactHashesFor,
  evaluateSuppression,
  hasDncKey,
} from './dnc.js';

export const DNC_DECISION = {
  // No entry in force covers this lead. Continue processing.
  CLEAR: 'clear',
  // An entry in force covers it. Terminal: never contacted, never delivered.
  SUPPRESSED: 'suppressed',
  // The list could not be consulted. Hold as retryable; do not deliver.
  UNAVAILABLE: 'unavailable',
};

export const DNC_UNAVAILABLE_REASON = {
  code: 'DNC_UNAVAILABLE',
  message:
    'The do-not-contact list could not be consulted, so this lead is held rather than delivered. '
    + 'It remains retryable and nothing has been sent.',
};

// A lead carrying no parseable phone and no parseable email cannot be matched
// against the list, and also cannot be contacted through either channel. That
// is not a DNC failure, so it passes here and is left to field validation,
// which is what actually rejects an unusable lead. Reported so it is visible.
export const DNC_NO_CONTACT = 'no_checkable_contact';

function uniqueHashes(hashes) {
  const seen = new Set();
  const out = [];
  for (const h of hashes) {
    if (!h.hash || seen.has(h.hash)) continue;
    seen.add(h.hash);
    out.push(h);
  }
  return out;
}

// Looks up every candidate entry for a lead's contact hashes.
//
// Entries are fetched by hash, never by raw value, so the query itself carries
// no contact data. Each returned entry is tagged with the kind it matched, so
// a rejection can say which field hit without echoing the value back.
async function fetchCandidates(db, hashes) {
  const entries = [];
  for (const { kind, hash } of hashes) {
    const rows = await db.entities.DncEntry.filter({ contact_hash: hash });
    for (const row of rows || []) {
      entries.push({ ...row, contact_kind: row.contact_kind || kind });
    }
  }
  return entries;
}

// The single global do-not-contact check.
//
// `lead` needs only phone and email. `context` carries vertical and campaign_id
// when a narrower-scoped entry has to be evaluated. `at` is the instant the
// effective window is judged against, injectable so the window is testable.
//
// Returns a decision object. It never throws for an expected condition: a
// missing key and a database failure are both real operating states that the
// caller has to handle, and an exception here would be caught somewhere that
// cannot tell them apart.
export async function checkLeadSuppression({ db, lead = {}, context = {}, at = new Date() } = {}) {
  if (!hasDncKey()) {
    return {
      decision: DNC_DECISION.UNAVAILABLE,
      suppressed: false,
      retryable: true,
      reason: DNC_UNAVAILABLE_REASON.code,
      message: DNC_UNAVAILABLE_REASON.message,
      detail: 'DNC_HASH_KEY is not configured',
      checked: [],
    };
  }

  if (!db?.entities?.DncEntry?.filter) {
    return {
      decision: DNC_DECISION.UNAVAILABLE,
      suppressed: false,
      retryable: true,
      reason: DNC_UNAVAILABLE_REASON.code,
      message: DNC_UNAVAILABLE_REASON.message,
      detail: 'no DncEntry repository available',
      checked: [],
    };
  }

  let hashes;
  let unresolvable;
  try {
    ({ hashes, unresolvable } = contactHashesFor(lead));
  } catch (err) {
    // hashValue throws when the key disappears between the check above and
    // here. Treated as unavailable, never as clear.
    return {
      decision: DNC_DECISION.UNAVAILABLE,
      suppressed: false,
      retryable: true,
      reason: DNC_UNAVAILABLE_REASON.code,
      message: DNC_UNAVAILABLE_REASON.message,
      detail: err.name,
      checked: [],
    };
  }

  const candidates = uniqueHashes(hashes);
  const checkedKinds = candidates.map((h) => h.kind);

  if (candidates.length === 0) {
    return {
      decision: DNC_DECISION.CLEAR,
      suppressed: false,
      retryable: false,
      reason: null,
      message: null,
      detail: DNC_NO_CONTACT,
      checked: [],
      unresolvable,
    };
  }

  let entries;
  try {
    entries = await fetchCandidates(db, candidates);
  } catch (err) {
    // A database failure must not read as "not suppressed". Holding the lead
    // is recoverable; delivering to somebody who opted out is not.
    return {
      decision: DNC_DECISION.UNAVAILABLE,
      suppressed: false,
      retryable: true,
      reason: DNC_UNAVAILABLE_REASON.code,
      message: DNC_UNAVAILABLE_REASON.message,
      detail: err.name || 'lookup failed',
      checked: checkedKinds,
    };
  }

  const verdict = evaluateSuppression({ entries, context, at });

  if (verdict.suppressed) {
    return {
      decision: DNC_DECISION.SUPPRESSED,
      suppressed: true,
      retryable: false,
      reason: DNC_REJECTION.code,
      message: DNC_REJECTION.message,
      matched: verdict.matched,
      entry_id: verdict.entry_id,
      entry_reason: verdict.entry_reason,
      checked: checkedKinds,
      unresolvable,
    };
  }

  return {
    decision: DNC_DECISION.CLEAR,
    suppressed: false,
    retryable: false,
    reason: null,
    message: null,
    checked: checkedKinds,
    unresolvable,
  };
}

// True when the decision permits the lead to continue toward routing and
// delivery. Only CLEAR does. Written as a function so no caller has to
// remember that UNAVAILABLE is also a stop.
export function mayContinue(decision) {
  return decision?.decision === DNC_DECISION.CLEAR;
}

// The audit record for a suppression, safe to persist and to export.
//
// Requirement: suppressed leads are retained with a stable rejection reason and
// remain auditable. Requirement: no raw contact reaches logs or exports. Both
// are satisfied by recording which field matched and which entry did it, and
// nothing else.
export function suppressionAudit(decision) {
  if (!decision?.suppressed) return null;
  return {
    reason_code: decision.reason,
    reason_message: decision.message,
    matched_field: decision.matched || null,
    dnc_entry_id: decision.entry_id || null,
    entry_reason: decision.entry_reason || null,
  };
}

export default {
  DNC_DECISION,
  DNC_UNAVAILABLE_REASON,
  DNC_NO_CONTACT,
  checkLeadSuppression,
  mayContinue,
  suppressionAudit,
};
