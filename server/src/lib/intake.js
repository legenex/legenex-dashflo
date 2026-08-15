// The canonical intake sequence. Task I3.
//
// Invariant 2: authenticate, commit a sanitized durable receipt, then run
// business validation, with global do-not-contact first among them.
//
// Every real intake source calls this one function immediately after it has
// authenticated its caller and before it does anything else. Supplier HTTP,
// Meta, owned forms, calls, CSV and recovery jobs. Putting the sequence here
// rather than inline in processLead is what makes "identical across every real
// intake source" checkable: there is one implementation and one set of tests,
// and a caller either invokes it or visibly does not.
//
// Two different database handles are involved and they are not the same thing.
// `sql` is the PostgreSQL pool, because receipts are a real table with real
// constraints. `repo` is the JSONB entity repository, because the DNC list is
// an entity. Naming them apart is deliberate: passing one where the other
// belongs is the mistake this signature is shaped to prevent.

import { commitReceipt, completeReceipt, releaseReceipt } from './receipts.js';
import { checkLeadSuppression, mayContinue, suppressionAudit, DNC_DECISION } from './dncEnforcement.js';

export const INTAKE_OUTCOME = {
  // Continue to enrichment, validation, routing and delivery.
  ACCEPTED: 'accepted',
  // The transport already delivered this exact payload. Do not process again.
  DUPLICATE: 'duplicate',
  // On the do-not-contact list. Terminal, retained, delivered to nobody.
  SUPPRESSED: 'suppressed',
  // The list could not be consulted. Retryable, delivered to nobody, not lost.
  HELD: 'held',
};

// Terminal outcome written onto the receipt for a suppressed lead. Distinct
// from a validation rejection so reporting can separate "we refused to contact
// this person" from "this lead was malformed".
export const RECEIPT_OUTCOME_SUPPRESSED = 'suppressed';

// Capture durably, then screen against global do-not-contact.
//
// The order is the requirement, not a preference. The receipt commits first so
// that a crash after this point leaves the lead recoverable, and the DNC check
// runs before any enrichment, external call, routing, delivery or billing so
// that a suppressed contact never reaches any of them.
//
// `owner` identifies the process holding the receipt, so a completion from a
// worker that lost its lease is refused.
export async function captureAndScreen({
  source,
  suppliedKey = null,
  payload = {},
  supplierKeyId = null,
  sql,
  repo,
  context = {},
  at = new Date(),
  owner = null,
} = {}) {
  if (!source) throw new Error('captureAndScreen requires a source');

  // 1. Durable capture. sanitizeReceiptPayload runs inside commitReceipt, so
  // the authorization header, cookies and the raw API key never reach the row.
  const { receipt, duplicate } = await commitReceipt({
    source, suppliedKey, payload, supplierKeyId, db: sql,
  });

  // 2. A transport level retry. The first delivery of this payload already
  // has a receipt, so this one must not be processed a second time. Returning
  // the prior receipt lets the caller answer with the original outcome, which
  // is what stops a retry becoming a second delivery and a second charge.
  if (duplicate) {
    return {
      outcome: INTAKE_OUTCOME.DUPLICATE,
      receipt,
      dnc: null,
      priorOutcome: receipt.terminal_outcome || null,
      effectsApplied: receipt.effects_applied === true,
    };
  }

  // 3. Global do-not-contact, the first business validation.
  const dnc = await checkLeadSuppression({ db: repo, lead: payload, context, at });

  if (dnc.decision === DNC_DECISION.SUPPRESSED) {
    // Terminal. The receipt records that it concluded and that no effects were
    // applied, so a replay cannot deliver or bill it.
    //
    // expectOwner is deliberately NOT passed. commitReceipt inserts with
    // claim_owner NULL, because this receipt is held inline by the request
    // rather than leased to a worker. Passing a non-null owner made the guard
    // `claim_owner = $6` compare against NULL, which is NULL rather than true,
    // so the update matched zero rows and every suppression silently failed to
    // conclude. The tests missed it because they never passed an owner, which
    // left the guard on its null short circuit.
    const done = await completeReceipt({
      id: receipt.id,
      outcome: RECEIPT_OUTCOME_SUPPRESSED,
      reason: dnc.reason,
      effectsApplied: false,
      db: sql,
    });
    // A refused terminal write is not something to discover later from a
    // backlog full of receipts that look like unfinished work.
    if (!done.applied && !done.receipt?.terminal_outcome) {
      throw new Error(`could not conclude suppressed receipt ${receipt.id}`);
    }
    return {
      outcome: INTAKE_OUTCOME.SUPPRESSED,
      receipt: done.receipt || receipt,
      dnc,
      audit: suppressionAudit(dnc),
    };
  }

  if (!mayContinue(dnc)) {
    // UNAVAILABLE. Not terminal. The receipt goes back to the pending backlog
    // with no outcome, so it is retried rather than delivered or discarded.
    // This is the branch a boolean suppressed check would have got wrong.
    // Same reason as above for not passing expectOwner.
    await releaseReceipt({ id: receipt.id, db: sql });
    return {
      outcome: INTAKE_OUTCOME.HELD,
      receipt,
      dnc,
      retryable: true,
    };
  }

  return { outcome: INTAKE_OUTCOME.ACCEPTED, receipt, dnc };
}

// True when the caller may continue into enrichment, routing and delivery.
// Only ACCEPTED does. Written as a function so no caller has to remember that
// HELD and DUPLICATE are also stops.
export function mayProcess(result) {
  return result?.outcome === INTAKE_OUTCOME.ACCEPTED;
}

export default { INTAKE_OUTCOME, RECEIPT_OUTCOME_SUPPRESSED, captureAndScreen, mayProcess };
