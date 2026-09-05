// Fixture 13 of 13: ambiguous timeout.
//
// The one eligible destination accepts the connection and then never
// responds; deliverDirectPost's own AbortController fires a real timeout
// (errorClass 'timeout'), which distributeRun.js's toRunStatus explicitly
// classifies as RUN.AMBIGUOUS rather than a clean miss, specifically so
// processLead.js never re-sends the same lead to a second destination when
// the first buyer's true outcome (did they receive it before the timeout?)
// is unknown - re-sending would risk a duplicate commercial send, which this
// codebase treats as a never-acceptable failure mode (modeControl.js:
// shouldFallback returns false for 'ambiguous').
//
// This fixture uses only ONE configured destination, matching the property
// that is actually, verifiably true of the current code: routing stops and
// nothing else is ever contacted. See fixtureOutcomes.test.js's
// "KNOWN GAP" block for a second, closely related, empirically-verified
// finding this fixture set deliberately does NOT paper over: a genuinely
// ambiguous outcome from ONE destination does not stop distributeLead from
// contacting a SECOND, differently-configured destination within the SAME
// run (proven by direct execution against the real code, not asserted here
// because fixing it is outside this work unit's file ownership).
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'ambiguous-timeout',
  name: 'Ambiguous timeout',
  description: 'The only eligible destination accepts the TCP connection and never responds; '
    + 'the real client-side timeout fires before any response is read.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550113' },
  build(base) {
    const member = buildMember('rm_amb6f7a8', {
      buyerId: 'buyer_amb00099',
      delivery: { targetUrl: `${base}/hang?bid=BYR-AMB1`, timeoutMs: 100 },
    });
    return { groups: [buildGroup('grp_ambT9901', [member])] };
  },
  expected: {
    errorClass: 'timeout',
    runStatus: 'ambiguous',
    callCount: 1, // the ONLY configured destination; nothing else exists to cascade to
    // shouldFallback('ambiguous') must be false: an ambiguous native result
    // must never trigger a second (legacy) send attempt at the same lead.
    shouldFallback: false,
    // processLead.js's real native-path mapping for RUN.AMBIGUOUS
    // (processLead.js:2477-2492): lead_status 'queued', final_status
    // 'Queued', code 'DELIVERY_AMBIGUOUS'. This branch returns UNCONDITIONALLY
    // - even in new_primary_with_legacy_fallback mode - so an ambiguous
    // native result never falls through to the legacy relay code just below
    // it (processLead.js:2495-2506).
    leadStatus: 'queued',
    finalStatus: 'Queued',
    code: 'DELIVERY_AMBIGUOUS',
  },
};
