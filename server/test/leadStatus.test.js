import { describe, expect, it } from 'vitest';

/* W2-STATUS: the seven-value vocabulary, processing_state, machine reason
 * codes and the canonical connector trigger keys.
 * forge-pack/CONTRACT.md D1, D3 and D4.
 *
 * These are the PURE parts, so they run with no database. The migration and
 * its money-invariance proof live in server/test/statusMigration.test.js,
 * which needs a real Postgres because the write-once money-flag latch it has
 * to prove nothing disturbed is a database trigger.
 *
 * What is proven here:
 *   1. The vocabulary is exactly D1's seven values, and processing_state is
 *      exactly D1's six, with no extras and none missing.
 *   2. D1's precedence order, including the part that contradicts two live
 *      code paths (returned outranks converted and sold).
 *   3. D4's mapping table, entry by entry, against the literal contract text.
 *   4. Trigger canonicalization, in both directions, including the two merges
 *      that would silently change firing behaviour if they were done naively.
 *   5. statusPatch refuses to write a money flag, or any undeclared field.
 *   6. Every retiring value has somewhere to go and nothing lands outside the
 *      seven.
 */

import {
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
  INTAKE_TRIGGER,
  LEGACY_TRIGGER,
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
  newVocabularyFields,
  leadStatusPatch,
  assertNoMoneyFieldWritten,
  lastLiveActivityMs,
  hasMigrationMarker,
  isExcludedFromRedrive,
  isRedriveEligible,
} from '../src/lib/leadStatus.js';
import { LEAD_FLAG_FIELDS } from '../src/lib/leadFlags.js';

describe('W2-STATUS D1: the seven-value vocabulary', () => {
  it('is exactly the seven values D1 names, in D1 spelling', () => {
    expect([...LEAD_STATUS_VALUES].sort()).toEqual([
      'converted', 'disqualified', 'queued', 'rejected', 'returned', 'sold', 'unsold',
    ]);
    expect(LEAD_STATUS_VALUES).toHaveLength(7);
  });

  it('rejects anything outside the seven, including the five retiring values', () => {
    for (const value of LEAD_STATUS_VALUES) expect(isLeadStatus(value)).toBe(true);
    for (const retired of RETIRING_STATUS_VALUES) expect(isLeadStatus(retired)).toBe(false);
    // The old TitleCase spellings are not the new vocabulary either.
    expect(isLeadStatus('Sold')).toBe(false);
    expect(isLeadStatus('')).toBe(false);
    expect(isLeadStatus(null)).toBe(false);
  });

  it('carries processing_state as a separate field with exactly D1 six values', () => {
    expect([...PROCESSING_STATE_VALUES].sort()).toEqual([
      'ambiguous', 'failed', 'received', 'routing', 'settled', 'validating',
    ]);
    expect(isProcessingState('failed')).toBe(true);
    expect(isProcessingState('sold')).toBe(false);
    // The two vocabularies must not overlap, or a crash could look like a
    // business outcome, which is the exact thing D1 splits them to prevent.
    for (const state of PROCESSING_STATE_VALUES) expect(isLeadStatus(state)).toBe(false);
  });
});

describe('W2-STATUS D1: precedence', () => {
  it('orders returned above converted above sold, exactly as D1 states', () => {
    expect(LEAD_STATUS_PRECEDENCE).toEqual([
      'returned', 'converted', 'sold', 'unsold', 'disqualified', 'rejected', 'queued',
    ]);
  });

  it('ranks every value and puts an unknown value below all of them', () => {
    expect(statusRank(LEAD_STATUS.RETURNED)).toBe(0);
    expect(statusRank(LEAD_STATUS.QUEUED)).toBe(6);
    expect(statusRank('nonsense')).toBeGreaterThan(statusRank(LEAD_STATUS.QUEUED));
    // A retired TitleCase value is unknown to the new order, not silently
    // lowercased into it, so a stale caller cannot outrank anything.
    expect(statusRank('Sold')).toBe(statusRank('Sold'.toLowerCase()));
  });

  it('outranks and highestStatus agree with the order, and never move on a tie', () => {
    expect(outranksStatus(LEAD_STATUS.SOLD, LEAD_STATUS.UNSOLD)).toBe(true);
    expect(outranksStatus(LEAD_STATUS.UNSOLD, LEAD_STATUS.SOLD)).toBe(false);
    expect(outranksStatus(LEAD_STATUS.RETURNED, LEAD_STATUS.CONVERTED)).toBe(true);
    expect(outranksStatus(LEAD_STATUS.SOLD, LEAD_STATUS.SOLD)).toBe(false);
    expect(highestStatus(LEAD_STATUS.QUEUED, LEAD_STATUS.SOLD)).toBe(LEAD_STATUS.SOLD);
    expect(highestStatus(LEAD_STATUS.RETURNED, LEAD_STATUS.SOLD)).toBe(LEAD_STATUS.RETURNED);
    expect(highestStatus('nonsense', LEAD_STATUS.QUEUED)).toBe(LEAD_STATUS.QUEUED);
  });

  it('DISAGREES with the two live webhook precedence orders, on purpose', () => {
    // This is not a curiosity, it is the residual risk this unit surfaces.
    // server/src/functions/leadbyteWebhook.js's inline STATUS_PRECEDENCE and
    // client/src/lib/leadIdentity.js's STATUS_PRECEDENCE both rank Sold and
    // Converted ABOVE Returned. D1 ranks returned highest. This test exists so
    // that anybody who later "fixes" the order to match those files has to
    // read the contract and decide deliberately, rather than discovering the
    // contradiction after a returned lead silently reverts to sold.
    expect(outranksStatus(LEAD_STATUS.RETURNED, LEAD_STATUS.SOLD)).toBe(true);
    expect(outranksStatus(LEAD_STATUS.RETURNED, LEAD_STATUS.CONVERTED)).toBe(true);
  });
});

describe('W2-STATUS D4: the retiring-value mapping table', () => {
  it('maps all twelve legacy values, and only into the seven', () => {
    expect(LEGACY_STATUS_VALUES).toHaveLength(12);
    for (const legacy of LEGACY_STATUS_VALUES) {
      const descriptor = mapLegacyStatus(legacy);
      expect(descriptor, `no mapping for ${legacy}`).toBeTruthy();
      expect(isLeadStatus(descriptor.lead_status)).toBe(true);
      expect(isProcessingState(descriptor.processing_state)).toBe(true);
    }
  });

  it('matches D4 row for row', () => {
    // Processing -> queued, processing_state = routing
    expect(mapLegacyStatus(LEGACY_STATUS.PROCESSING)).toMatchObject({
      lead_status: LEAD_STATUS.QUEUED,
      processing_state: PROCESSING_STATE.ROUTING,
    });
    // Qualified -> queued, plus a derived is_qualified flag
    expect(mapLegacyStatus(LEGACY_STATUS.QUALIFIED)).toMatchObject({
      lead_status: LEAD_STATUS.QUEUED,
      is_qualified: true,
    });
    // Duplicate -> rejected, REJECTED_DUPLICATE, linked to the original lead
    expect(mapLegacyStatus(LEGACY_STATUS.DUPLICATE)).toMatchObject({
      lead_status: LEAD_STATUS.REJECTED,
      status_reason: 'REJECTED_DUPLICATE',
      links_duplicate: true,
    });
    // Error -> queued, processing_state = failed
    expect(mapLegacyStatus(LEGACY_STATUS.ERROR)).toMatchObject({
      lead_status: LEAD_STATUS.QUEUED,
      processing_state: PROCESSING_STATE.FAILED,
    });
    // Fake -> rejected, REJECTED_FAKE
    expect(mapLegacyStatus(LEGACY_STATUS.FAKE)).toMatchObject({
      lead_status: LEAD_STATUS.REJECTED,
      status_reason: 'REJECTED_FAKE',
    });
  });

  it('maps the seven surviving values onto their own lowercase spelling', () => {
    const identity = [
      [LEGACY_STATUS.SOLD, LEAD_STATUS.SOLD],
      [LEGACY_STATUS.UNSOLD, LEAD_STATUS.UNSOLD],
      [LEGACY_STATUS.QUEUED, LEAD_STATUS.QUEUED],
      [LEGACY_STATUS.DISQUALIFIED, LEAD_STATUS.DISQUALIFIED],
      [LEGACY_STATUS.REJECTED, LEAD_STATUS.REJECTED],
      [LEGACY_STATUS.RETURNED, LEAD_STATUS.RETURNED],
      [LEGACY_STATUS.CONVERTED, LEAD_STATUS.CONVERTED],
    ];
    for (const [legacy, expected] of identity) {
      expect(mapLegacyStatus(legacy).lead_status).toBe(expected);
    }
  });

  it('never guesses at an unrecognised value', () => {
    expect(mapLegacyStatus('24m Lead')).toBeNull();
    expect(mapLegacyStatus('')).toBeNull();
    expect(mapLegacyStatus(undefined)).toBeNull();
    expect(resolveLegacyStatus('Nonsense')).toBeNull();
  });

  it('folds the inbound plural Duplicates onto the singular the enum has', () => {
    // The inbound wire vocabulary uses the plural. Lead.final_status's enum
    // only ever had the singular, so the internal route was writing rows on a
    // value no reader matches. resolveLegacyStatus is where that is settled.
    expect(resolveLegacyStatus('Duplicates')).toBe(LEGACY_STATUS.DUPLICATE);
    expect(resolveLegacyStatus(LEGACY_STATUS.SOLD)).toBe(LEGACY_STATUS.SOLD);
  });

  it('records the qualification signal as tri-state rather than a confident guess', () => {
    // Provably qualified.
    expect(mapLegacyStatus(LEGACY_STATUS.QUALIFIED).is_qualified).toBe(true);
    expect(mapLegacyStatus(LEGACY_STATUS.SOLD).is_qualified).toBe(true);
    expect(mapLegacyStatus(LEGACY_STATUS.UNSOLD).is_qualified).toBe(true);
    // Provably not qualified.
    expect(mapLegacyStatus(LEGACY_STATUS.DISQUALIFIED).is_qualified).toBe(false);
    expect(mapLegacyStatus(LEGACY_STATUS.REJECTED).is_qualified).toBe(false);
    expect(mapLegacyStatus(LEGACY_STATUS.DUPLICATE).is_qualified).toBe(false);
    expect(mapLegacyStatus(LEGACY_STATUS.FAKE).is_qualified).toBe(false);
    // Genuinely unknowable from the row.
    expect(mapLegacyStatus(LEGACY_STATUS.PROCESSING).is_qualified).toBeNull();
    expect(mapLegacyStatus(LEGACY_STATUS.ERROR).is_qualified).toBeNull();
    expect(mapLegacyStatus(LEGACY_STATUS.QUEUED).is_qualified).toBeNull();
  });
});

describe('W2-STATUS D3: reason codes', () => {
  it('carries the three codes the contract names, spelled exactly', () => {
    expect(STATUS_REASON.REJECTED_DNC).toBe('REJECTED_DNC');
    expect(STATUS_REASON.REJECTED_DUPLICATE).toBe('REJECTED_DUPLICATE');
    expect(STATUS_REASON.REJECTED_FAKE).toBe('REJECTED_FAKE');
  });

  it('uses the SCREAMING_SNAKE convention the rest of the codebase already uses', () => {
    for (const code of Object.values(STATUS_REASON)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('does not collide with the enforcement layer codes D3 leaves untouched', () => {
    // D3: the engine's SUPPRESSED is the eligibility-layer equivalent and is
    // unaffected; dnc.js's DNC_SUPPRESSED is the enforcement decision code.
    // Neither may be replaced by REJECTED_DNC, they answer different questions.
    const codes = Object.values(STATUS_REASON);
    expect(codes).not.toContain('SUPPRESSED');
    expect(codes).not.toContain('DNC_SUPPRESSED');
    expect(codes).not.toContain('DNC_UNAVAILABLE');
  });
});

describe('W2-STATUS D4 risk 1: connector trigger keys', () => {
  it('derives a canonical key for every one of the seven statuses', () => {
    for (const status of LEAD_STATUS_VALUES) {
      const key = triggerKeyForLeadStatus(status);
      expect(key, `no trigger for ${status}`).toBeTruthy();
      expect(key).toMatch(/^on_/);
    }
    expect(triggerKeyForLeadStatus(LEAD_STATUS.SOLD)).toBe(TRIGGER.ON_SOLD);
    expect(triggerKeyForLeadStatus(LEAD_STATUS.DISQUALIFIED)).toBe(TRIGGER.ON_DISQUALIFIED);
    expect(triggerKeyForLeadStatus('nonsense')).toBe('');
  });

  it('folds every retired key onto its canonical name', () => {
    expect(canonicalTriggerKey(LEGACY_TRIGGER.RECEIVED)).toBe(TRIGGER.ON_QUALIFIED);
    expect(canonicalTriggerKey(LEGACY_TRIGGER.DQ)).toBe(TRIGGER.ON_DISQUALIFIED);
    expect(canonicalTriggerKey(LEGACY_TRIGGER.DUPLICATES)).toBe(TRIGGER.ON_REJECTED_DUPLICATE);
    expect(canonicalTriggerKey(LEGACY_TRIGGER.ERROR)).toBe(TRIGGER.ON_PROCESSING_FAILED);
    // Unchanged keys stay themselves, and a custom key is never mangled.
    expect(canonicalTriggerKey(TRIGGER.ON_SOLD)).toBe(TRIGGER.ON_SOLD);
    expect(canonicalTriggerKey('on_24m_lead')).toBe('on_24m_lead');
    expect(canonicalTriggerKey('')).toBe('');
  });

  it('does NOT merge the intake trigger into the manual-queue trigger', () => {
    // The naive mapping is Qualified -> queued, therefore the intake key
    // becomes on_queued. That would make every manual-queue connector fire at
    // intake on every lead and every intake connector fire again on every
    // queued lead: a double-fire of real conversion events. These two keys
    // stay distinct for exactly that reason.
    expect(canonicalTriggerKey(LEGACY_TRIGGER.RECEIVED)).not.toBe(TRIGGER.ON_QUEUED);
    expect(TRIGGER.ON_QUALIFIED).not.toBe(TRIGGER.ON_QUEUED);
    expect(triggerMatches([LEGACY_TRIGGER.RECEIVED], TRIGGER.ON_QUEUED)).toBe(false);
    expect(triggerMatches([TRIGGER.ON_QUEUED], INTAKE_TRIGGER)).toBe(false);
  });

  it('does NOT merge the duplicates trigger into the general rejected trigger', () => {
    // Same class of mistake: Duplicate -> rejected, so on_duplicates naively
    // becomes on_rejected and a duplicates-only connector starts firing on
    // every rejection there is, including every DNC suppression.
    expect(canonicalTriggerKey(LEGACY_TRIGGER.DUPLICATES)).not.toBe(TRIGGER.ON_REJECTED);
    expect(triggerMatches([LEGACY_TRIGGER.DUPLICATES], TRIGGER.ON_REJECTED)).toBe(false);
    expect(triggerMatches([TRIGGER.ON_REJECTED], TRIGGER.ON_REJECTED_DUPLICATE)).toBe(false);
  });

  it('matches a stored legacy array against a fired canonical key, and the reverse', () => {
    // This dual read is what stops the remap itself from causing D4 risk 1.
    expect(triggerMatches([LEGACY_TRIGGER.RECEIVED], TRIGGER.ON_QUALIFIED)).toBe(true);
    expect(triggerMatches([TRIGGER.ON_QUALIFIED], LEGACY_TRIGGER.RECEIVED)).toBe(true);
    expect(triggerMatches([LEGACY_TRIGGER.DQ], TRIGGER.ON_DISQUALIFIED)).toBe(true);
    expect(triggerMatches([LEGACY_TRIGGER.DUPLICATES], TRIGGER.ON_REJECTED_DUPLICATE)).toBe(true);
    expect(triggerMatches([LEGACY_TRIGGER.ERROR], TRIGGER.ON_PROCESSING_FAILED)).toBe(true);
    expect(triggerMatches([], TRIGGER.ON_SOLD)).toBe(false);
    expect(triggerMatches(null, TRIGGER.ON_SOLD)).toBe(false);
    expect(triggerMatches([TRIGGER.ON_SOLD], '')).toBe(false);
  });

  it('identifies the intake trigger under either spelling', () => {
    expect(isIntakeTrigger(LEGACY_TRIGGER.RECEIVED)).toBe(true);
    expect(isIntakeTrigger(INTAKE_TRIGGER)).toBe(true);
    expect(isIntakeTrigger(TRIGGER.ON_QUEUED)).toBe(false);
    expect(isIntakeTrigger('on_24m_lead')).toBe(false);
  });

  it('reproduces the existing inbound status to trigger behaviour, quirk included', () => {
    expect(triggerKeyForInboundStatus(LEGACY_STATUS.QUALIFIED)).toBe(TRIGGER.ON_QUALIFIED);
    expect(triggerKeyForInboundStatus(LEGACY_STATUS.SOLD)).toBe(TRIGGER.ON_SOLD);
    expect(triggerKeyForInboundStatus(LEGACY_STATUS.DISQUALIFIED)).toBe(TRIGGER.ON_DISQUALIFIED);
    expect(triggerKeyForInboundStatus('Duplicates')).toBe(TRIGGER.ON_REJECTED_DUPLICATE);
    expect(triggerKeyForInboundStatus(LEGACY_STATUS.ERROR)).toBe(TRIGGER.ON_PROCESSING_FAILED);
    // Custom statuses keep their slug, which is how "24m Lead" connectors work.
    expect(triggerKeyForInboundStatus('24m Lead')).toBe('on_24m_lead');
    expect(triggerKeyForInboundStatus('')).toBe('on_status');
    // The preserved pre-existing quirk: only the plural was ever mapped, so
    // the singular still slugs. Changing it would silently move firing for
    // anybody who configured a connector on that slug.
    expect(triggerKeyForInboundStatus(LEGACY_STATUS.DUPLICATE)).toBe('on_duplicate');
  });

  it('keeps the inbound wire vocabulary, which D4 does not retire', () => {
    // These are values suppliers POST to us. Retiring them is a
    // supplier-facing contract change, not a migration.
    expect(LEGACY_INBOUND_STATUSES).toContain('Duplicates');
    expect(LEGACY_INBOUND_STATUSES).toContain(LEGACY_STATUS.ERROR);
    expect(LEGACY_INBOUND_STATUSES).toHaveLength(8);
  });

  it('remaps a trigger array additively, preserving order and collapsing a genuine duplicate', () => {
    const mixed = remapTriggerArray([LEGACY_TRIGGER.RECEIVED, TRIGGER.ON_SOLD, LEGACY_TRIGGER.DQ]);
    expect(mixed.triggers).toEqual([TRIGGER.ON_QUALIFIED, TRIGGER.ON_SOLD, TRIGGER.ON_DISQUALIFIED]);
    expect(mixed.changed).toBe(true);
    expect(mixed.legacyKeys).toEqual([LEGACY_TRIGGER.RECEIVED, LEGACY_TRIGGER.DQ]);

    // Already canonical: nothing to do, so a second migration run is a no-op.
    const clean = remapTriggerArray([TRIGGER.ON_SOLD, TRIGGER.ON_UNSOLD]);
    expect(clean.changed).toBe(false);
    expect(clean.triggers).toEqual([TRIGGER.ON_SOLD, TRIGGER.ON_UNSOLD]);

    // Both spellings of one trigger collapse into one entry: they were always
    // the same trigger, so keeping both would double-fire it.
    const both = remapTriggerArray([LEGACY_TRIGGER.DQ, TRIGGER.ON_DISQUALIFIED]);
    expect(both.triggers).toEqual([TRIGGER.ON_DISQUALIFIED]);

    // A custom key survives untouched.
    expect(remapTriggerArray(['on_24m_lead']).triggers).toEqual(['on_24m_lead']);
    expect(remapTriggerArray([]).triggers).toEqual([]);
    expect(remapTriggerArray(null).triggers).toEqual([]);
  });

  it('lists every retired key so the loud check has something to look for', () => {
    expect([...RETIRED_TRIGGER_KEYS].sort()).toEqual(
      [LEGACY_TRIGGER.RECEIVED, LEGACY_TRIGGER.DQ, LEGACY_TRIGGER.DUPLICATES, LEGACY_TRIGGER.ERROR].sort(),
    );
  });
});

describe('W2-STATUS D4 risk 2: this module can never touch money', () => {
  it('declares exactly the money flags W1-FLAGS owns, and shares none of them', () => {
    expect([...MONEY_FIELDS_NEVER_WRITTEN].sort()).toEqual([...LEAD_FLAG_FIELDS].sort());
    for (const field of STATUS_PATCH_FIELDS) {
      expect(MONEY_FIELDS_NEVER_WRITTEN, `${field} overlaps a money flag`).not.toContain(field);
    }
  });

  it('statusPatch only ever emits declared status fields', () => {
    const patch = statusPatch(LEGACY_STATUS.SOLD, { reason: 'SOLD' });
    for (const key of Object.keys(patch)) expect(STATUS_PATCH_FIELDS).toContain(key);
    expect(patch).toMatchObject({
      final_status: LEGACY_STATUS.SOLD,
      lead_status: LEAD_STATUS.SOLD,
      processing_state: PROCESSING_STATE.SETTLED,
      status_reason: 'SOLD',
      is_qualified: true,
    });
    // Dual-write during the expand phase: the legacy field is still written.
    expect(patch.final_status).toBe(LEGACY_STATUS.SOLD);
    // A live write is never a migrated write.
    expect(patch.migrated_at).toBeUndefined();
  });

  it('statusPatch honours an explicit processing_state and reason override', () => {
    const patch = statusPatch(LEGACY_STATUS.PROCESSING, {
      processingState: PROCESSING_STATE.RECEIVED,
    });
    expect(patch.processing_state).toBe(PROCESSING_STATE.RECEIVED);
    expect(patch.lead_status).toBe(LEAD_STATUS.QUEUED);

    const ambiguous = statusPatch(LEGACY_STATUS.QUEUED, {
      processingState: PROCESSING_STATE.AMBIGUOUS,
      reason: 'DELIVERY_AMBIGUOUS',
    });
    expect(ambiguous.processing_state).toBe(PROCESSING_STATE.AMBIGUOUS);
    expect(ambiguous.status_reason).toBe('DELIVERY_AMBIGUOUS');
  });

  it('statusPatch refuses an unknown legacy status rather than defaulting', () => {
    expect(() => statusPatch('Nonsense')).toThrow(/unknown legacy status/);
  });

  it('refuses to let a caller override the two reason codes D4 names by value', () => {
    // Found by review, not by luck: the LeadByte response parser tracks its
    // own reason code in a local variable and reached the duplicate branch
    // still holding LB_ERROR, which would have stored a duplicate rejection
    // nobody could tell apart from a transport failure. Pinning it in the
    // mapping table makes that whole class of mistake unrepresentable rather
    // than fixing the one call site that happened to have it.
    expect(statusPatch(LEGACY_STATUS.DUPLICATE, { reason: 'LB_ERROR' }).status_reason)
      .toBe(STATUS_REASON.REJECTED_DUPLICATE);
    expect(statusPatch(LEGACY_STATUS.FAKE, { reason: 'ANYTHING_ELSE' }).status_reason)
      .toBe(STATUS_REASON.REJECTED_FAKE);
    // Every other value still takes the caller's code, because the live path
    // knows more than the mapping table does.
    expect(statusPatch(LEGACY_STATUS.QUEUED, { reason: 'MISSING_CERT' }).status_reason)
      .toBe('MISSING_CERT');
    expect(statusPatch(LEGACY_STATUS.REJECTED, { reason: STATUS_REASON.REJECTED_DNC }).status_reason)
      .toBe(STATUS_REASON.REJECTED_DNC);
  });

  it('caps the reason detail so an unbounded string never lands on a lead', () => {
    const patch = statusPatch(LEGACY_STATUS.REJECTED, {
      reason: STATUS_REASON.REJECTED_DNC,
      reasonDetail: 'x'.repeat(2000),
    });
    expect(patch.status_reason_detail).toHaveLength(500);
  });
});

describe('W2-STATUS D4 risk 3: historical failures are never re-driven', () => {
  const MIGRATED = '2026-09-05T00:00:00.000Z';
  const BEFORE = '2026-08-01T00:00:00.000Z';
  const AFTER = '2026-11-20T00:00:00.000Z';

  it('excludes a migrated row whose failed state is the one the migration left it in', () => {
    expect(isExcludedFromRedrive({ migrated_at: MIGRATED })).toBe(true);
    expect(isExcludedFromRedrive({ migrated_at: MIGRATED, processed_at: BEFORE })).toBe(true);
    expect(isExcludedFromRedrive({ migrated_at: MIGRATED, leadbyte_outcome_at: BEFORE })).toBe(true);
    expect(isExcludedFromRedrive({})).toBe(false);
    expect(isExcludedFromRedrive(null)).toBe(false);
    expect(isRedriveEligible({ migrated_at: MIGRATED })).toBe(false);
    expect(isRedriveEligible({ lead_status: 'queued', processing_state: 'failed' })).toBe(true);
  });

  // Adversarial QA finding S3. The predicate used to be
  // Boolean(lead.migrated_at), and migrated_at is permanent and never
  // reconsidered, so a lead that migrated cleanly and then genuinely failed,
  // live, months later carried a marker that made it invisible to W4-REAPER
  // for the rest of its life. Nothing would have logged that it had been
  // skipped: it would simply have sat at queued + failed with nobody coming
  // for it, which is a quieter and worse failure than the flood the marker
  // exists to prevent.
  it('does NOT exclude a row that failed again, for real, AFTER the migration ran', () => {
    const failedAgain = {
      lead_status: 'queued',
      processing_state: 'failed',
      migrated_at: MIGRATED,
      // A live processLead run. processLead.js writes processed_at on every
      // branch it takes, and this module cannot write it: it is not in
      // STATUS_PATCH_FIELDS, so a value later than the stamp can only have
      // come from a live path after the migration.
      processed_at: AFTER,
    };
    expect(isExcludedFromRedrive(failedAgain)).toBe(false);
    expect(isRedriveEligible(failedAgain)).toBe(true);

    // The same via the other live signal: an outcome postback.
    expect(isRedriveEligible({ migrated_at: MIGRATED, leadbyte_outcome_at: AFTER })).toBe(true);
    // And the newest activity wins when a row carries both.
    expect(isRedriveEligible({
      migrated_at: MIGRATED, processed_at: BEFORE, leadbyte_outcome_at: AFTER,
    })).toBe(true);
  });

  it('stays excluded when it cannot tell, because a wrong inclusion delivers real leads to real buyers', () => {
    // Both "cannot tell" shapes resolve to excluded on purpose. The cost of a
    // wrong exclusion is one lead an operator can still find by hand; the cost
    // of a wrong inclusion is redelivering historical leads to buyers.
    expect(isExcludedFromRedrive({ migrated_at: 'not a date', processed_at: AFTER })).toBe(true);
    expect(isExcludedFromRedrive({ migrated_at: MIGRATED, processed_at: 'not a date' })).toBe(true);
    // Exactly-equal timestamps are the migration's own instant, not new work.
    expect(isExcludedFromRedrive({ migrated_at: MIGRATED, processed_at: MIGRATED })).toBe(true);
  });

  it('separates "already migrated" from "not re-drivable", which are different questions', () => {
    // The two used to be the same predicate. Once isExcludedFromRedrive became
    // a time comparison, reusing it for idempotency would have made the
    // backfill re-stamp every migrated row that had since been touched, which
    // would have rewritten provenance on exactly the rows that failed again.
    const migratedThenFailedAgain = {
      id: 'a', final_status: LEGACY_STATUS.ERROR, migrated_at: MIGRATED, processed_at: AFTER,
    };
    expect(hasMigrationMarker(migratedThenFailedAgain)).toBe(true);
    expect(isExcludedFromRedrive(migratedThenFailedAgain)).toBe(false);
    // Still never patched again: the marker is what makes the backfill
    // idempotent, and it is still there.
    expect(leadStatusPatch(migratedThenFailedAgain)).toBeNull();
  });

  it('a migrated lead is never patched again, so a second run cannot re-stamp it', () => {
    const migrated = {
      id: 'a', final_status: LEGACY_STATUS.ERROR, migrated_at: MIGRATED,
    };
    expect(leadStatusPatch(migrated)).toBeNull();
  });

  it('a live failure carries no migrated_at, so recovery CAN pick it up', () => {
    // This is the distinction D1 creates and D4 risk 3 depends on: an Error
    // that just happened is recoverable, a historical Error is not.
    const livePatch = statusPatch(LEGACY_STATUS.ERROR, { reason: 'INTERNAL_ERROR' });
    expect(livePatch.lead_status).toBe(LEAD_STATUS.QUEUED);
    expect(livePatch.processing_state).toBe(PROCESSING_STATE.FAILED);
    expect(livePatch.migrated_at).toBeUndefined();
    expect(isRedriveEligible(livePatch)).toBe(true);
  });

  it('reports the newest live activity, and null when the row records none', () => {
    expect(lastLiveActivityMs({ processed_at: BEFORE })).toBe(Date.parse(BEFORE));
    expect(lastLiveActivityMs({ processed_at: BEFORE, leadbyte_outcome_at: AFTER }))
      .toBe(Date.parse(AFTER));
    expect(lastLiveActivityMs({ leadbyte_outcome_at: BEFORE, processed_at: AFTER }))
      .toBe(Date.parse(AFTER));
    expect(lastLiveActivityMs({})).toBeNull();
    expect(lastLiveActivityMs(null)).toBeNull();
    // updated_date is deliberately NOT a signal: the repository sets it on the
    // migration's own write, so it is always a hair later than the stamp that
    // write laid down, and reading it would mark every migrated row eligible
    // the instant the backfill finished.
    expect(lastLiveActivityMs({ updated_date: AFTER })).toBeNull();
  });
});

describe('W2-STATUS: the live-path helper writes the new fields and never final_status', () => {
  // Adversarial QA finding B2. server/src/functions/webhook.js and
  // server/src/functions/leadbyteWebhook.js call this, and they must be unable
  // to write final_status through it: both files have their own delicate rules
  // about whether final_status may move at all, and a helper that carried it
  // would make writing it on a path that had decided not to a one-character
  // mistake.
  it('emits the new vocabulary and omits final_status entirely', () => {
    const fields = newVocabularyFields(LEGACY_STATUS.SOLD);
    expect(fields).toEqual({
      lead_status: LEAD_STATUS.SOLD,
      processing_state: PROCESSING_STATE.SETTLED,
      is_qualified: true,
    });
    expect('final_status' in fields).toBe(false);
    // And it is the same mapping, not a second copy of it.
    const { final_status: legacyValue, ...rest } = statusPatch(LEGACY_STATUS.SOLD);
    expect(legacyValue).toBe(LEGACY_STATUS.SOLD);
    expect(fields).toEqual(rest);
  });

  it('covers every legacy value, so no live write can produce a null lead_status', () => {
    for (const legacy of LEGACY_STATUS_VALUES) {
      const fields = newVocabularyFields(legacy);
      expect(isLeadStatus(fields.lead_status), `${legacy} produced ${fields.lead_status}`).toBe(true);
      expect(isProcessingState(fields.processing_state)).toBe(true);
      expect(fields.final_status).toBeUndefined();
      expect(fields.migrated_at).toBeUndefined();
    }
  });

  it('never stamps a migration provenance code on a live write', () => {
    // The three MIGRATED_FROM_ codes exist because a HISTORICAL row records no
    // machine reason. A lead created a microsecond ago has not been migrated
    // from anything, and a later reader would take the code at face value.
    // Before this repair, the descriptor fallback meant every lead created by
    // processLead.js carried MIGRATED_FROM_PROCESSING, and the webhook mirror
    // would have spread that to two more live paths.
    for (const legacy of [LEGACY_STATUS.PROCESSING, LEGACY_STATUS.QUALIFIED, LEGACY_STATUS.ERROR]) {
      expect(newVocabularyFields(legacy).status_reason).toBeUndefined();
      expect(statusPatch(legacy).status_reason).toBeUndefined();
    }
    // The backfill, which is the one thing allowed to write them, still does.
    expect(leadStatusPatch({ id: 'p', final_status: LEGACY_STATUS.ERROR }).status_reason)
      .toBe(STATUS_REASON.MIGRATED_FROM_ERROR);
    // And a caller asking for one explicitly is a bug, not a value to accept.
    expect(() => statusPatch(LEGACY_STATUS.ERROR, { reason: STATUS_REASON.MIGRATED_FROM_ERROR }))
      .toThrow(/migration provenance code/);
  });
});

describe('W2-STATUS D4 risk 2: the money guard actually throws', () => {
  // Adversarial QA finding M2. The test that carried this guard's name only
  // re-asserted the two static field lists, so the throw was never executed by
  // anything and a future edit could have emptied the function body without a
  // single test noticing. Every patch this module emits passes through this
  // exact function, so calling it directly IS exercising the production path.
  it('refuses every one of the eight money flags, by name, with the reason', () => {
    for (const moneyField of MONEY_FIELDS_NEVER_WRITTEN) {
      expect(
        () => assertNoMoneyFieldWritten({ lead_status: LEAD_STATUS.SOLD, [moneyField]: true }, 'test'),
        `${moneyField} was allowed through`,
      ).toThrow(new RegExp(`refused to write money flag "${moneyField}"`));
    }
  });

  it('refuses a field that is neither a money flag nor a declared status field', () => {
    expect(() => assertNoMoneyFieldWritten({ revenue: 100 }, 'test'))
      .toThrow(/is not a declared status field/);
    expect(() => assertNoMoneyFieldWritten({ buyer_id: 'b1' }, 'test'))
      .toThrow(/is not a declared status field/);
  });

  it('lets a legitimate status patch through unchanged, so the guard is not just a wall', () => {
    const patch = { lead_status: LEAD_STATUS.SOLD, processing_state: PROCESSING_STATE.SETTLED };
    expect(assertNoMoneyFieldWritten(patch, 'test')).toBe(patch);
    // Every real emitter goes through it, so a money key cannot survive one.
    for (const key of Object.keys(statusPatch(LEGACY_STATUS.SOLD, { reason: 'SOLD' }))) {
      expect(MONEY_FIELDS_NEVER_WRITTEN).not.toContain(key);
    }
    for (const key of Object.keys(leadStatusPatch({ id: 'g', final_status: LEGACY_STATUS.SOLD }))) {
      expect(MONEY_FIELDS_NEVER_WRITTEN).not.toContain(key);
    }
  });
});

describe('W2-STATUS: leadStatusPatch is additive and idempotent', () => {
  const at = new Date('2026-09-05T10:00:00.000Z');

  it('produces the D4 patch for a retiring value and stamps migrated_at', () => {
    const patch = leadStatusPatch({ id: 'l1', final_status: LEGACY_STATUS.ERROR }, { at });
    expect(patch).toEqual({
      lead_status: LEAD_STATUS.QUEUED,
      processing_state: PROCESSING_STATE.FAILED,
      status_reason: STATUS_REASON.MIGRATED_FROM_ERROR,
      migrated_at: at.toISOString(),
    });
    // It never rewrites final_status: the legacy value stays put, which is
    // what makes the rollback "drop the new keys" and nothing more.
    expect(patch.final_status).toBeUndefined();
  });

  // Adversarial QA finding S2. This used to assert null, on the reasoning that
  // a row with nothing to change is a row with nothing to write. The flaw is
  // what the marker then means: this row WAS examined by the migration and WAS
  // confirmed correct, and it came out indistinguishable from a row the
  // migration never reached. Claim 4 of the unit is that every migrated row
  // carries migrated_at, and it was silently false for exactly the rows a
  // reader would most want to ask about, which since finding B2 was fixed is
  // every lead a live webhook wrote before the migration got to it.
  it('stamps a row that already held every target value, because examined IS migrated', () => {
    const alreadyThere = {
      id: 'l2',
      final_status: LEGACY_STATUS.SOLD,
      lead_status: LEAD_STATUS.SOLD,
      processing_state: PROCESSING_STATE.SETTLED,
      is_qualified: true,
    };
    const patch = leadStatusPatch(alreadyThere, { at });
    // The marker, and ONLY the marker. Nothing is rewritten, so the additive
    // guarantee and the "rollback is dropping the new keys" plan both hold.
    expect(patch).toEqual({ migrated_at: at.toISOString() });
  });

  it('returns null for an unmapped or absent final_status rather than guessing', () => {
    expect(leadStatusPatch({ id: 'l3', final_status: '24m Lead' }, { at })).toBeNull();
    expect(leadStatusPatch({ id: 'l4' }, { at })).toBeNull();
  });

  it('links a duplicate only when an original was actually found', () => {
    const withOriginal = leadStatusPatch(
      { id: 'l5', final_status: LEGACY_STATUS.DUPLICATE },
      { at, duplicateOriginal: 'original-1' },
    );
    expect(withOriginal.duplicate_of_lead_id).toBe('original-1');
    expect(withOriginal.status_reason).toBe(STATUS_REASON.REJECTED_DUPLICATE);

    const withoutOriginal = leadStatusPatch(
      { id: 'l6', final_status: LEGACY_STATUS.DUPLICATE },
      { at },
    );
    expect(withoutOriginal.duplicate_of_lead_id).toBeUndefined();
    expect(withoutOriginal.status_reason).toBe(STATUS_REASON.REJECTED_DUPLICATE);
  });

  it('only ever emits declared status fields, for every legacy value', () => {
    for (const legacy of LEGACY_STATUS_VALUES) {
      const patch = leadStatusPatch({ id: `x-${legacy}`, final_status: legacy }, { at });
      if (!patch) continue;
      for (const key of Object.keys(patch)) {
        expect(STATUS_PATCH_FIELDS, `${legacy} wrote ${key}`).toContain(key);
        expect(MONEY_FIELDS_NEVER_WRITTEN, `${legacy} wrote money flag ${key}`).not.toContain(key);
      }
    }
  });
});
