// Fixture 6 of 13: all buyers rejected.
//
// Two eligible destinations are BOTH actually contacted (unlike "all capped",
// where nobody is ever contacted) and both genuinely decline at the response-
// classification layer. distributeLead exhausts every ordered destination,
// and toRunStatus resolves this to RUN.REJECTED specifically because a real
// REJECTED response exists in the attempt trace and nothing is ambiguous -
// contrast this with fixture 13 (ambiguous timeout), where the same
// "Exhausted" shape resolves to RUN.AMBIGUOUS instead because the attempt
// trace holds a timeout, not a clean decline.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'all-buyers-rejected',
  name: 'All buyers rejected',
  description: 'Two eligible, reachable buyers are both contacted and both decline the lead.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550106' },
  build(base) {
    const m1 = buildMember('rm_f10c2b9a', {
      buyerId: 'buyer_10203040', priority: 1,
      delivery: { targetUrl: `${base}/reject?bid=BYR-301` },
    });
    const m2 = buildMember('rm_a20d3c8b', {
      buyerId: 'buyer_50607080', priority: 2,
      delivery: { targetUrl: `${base}/reject?bid=BYR-302` },
    });
    return { groups: [buildGroup('grp_allrej77', [m1, m2])] };
  },
  expected: {
    reasonCode: 'rejected',
    runStatus: 'rejected',
    callCount: 2,
    attemptStatuses: ['rejected', 'rejected'],
    // Unlike accepted/duplicate/ambiguous, RUN.REJECTED IS fallback-eligible
    // (modeControl.shouldFallback's default approvedFailureCategories
    // includes 'rejected') - asserted directly against the real function in
    // fixtureOutcomes.test.js, not hand-computed.
    shouldFallback: true,
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
