// Fixture 1 of 13: clean accept.
//
// One eligible, in-schedule, uncapped MVA buyer whose destination accepts on
// the first attempt. The baseline positive case every other fixture is
// contrasted against.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'clean-accept',
  name: 'Clean accept',
  description: 'A single eligible MVA buyer accepts the lead on the first attempt.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550101' },
  build(base) {
    const member = buildMember('rm_8f21a0c4', {
      buyerId: 'buyer_7a1f3c90', price: 125,
      filters: { states: ['CA', 'NV'], verticals: ['MVA'] },
      delivery: { targetUrl: `${base}/accept?price=125&bid=BYR-101` },
    });
    return { groups: [buildGroup('grp_e401aa11', [member])] };
  },
  expected: {
    // Real engine-level ground truth (asserted directly against the running
    // code, not hand-computed): ATTEMPT_STATUS.ACCEPTED for the one attempt,
    // RUN.ACCEPTED for the overall run.
    reasonCode: 'accepted',
    runStatus: 'accepted',
    winnerMemberId: 'rm_8f21a0c4',
    revenue: 125,
    callCount: 1,
    // processLead.js's real native-path mapping for RUN.ACCEPTED
    // (processLead.js:2445-2461): lead_status 'sold', final_status 'Sold',
    // code 'SOLD'.
    leadStatus: 'sold',
    finalStatus: 'Sold',
    code: 'SOLD',
  },
};
