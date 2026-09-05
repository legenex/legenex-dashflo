// Fixture 4 of 13: all capped.
//
// Every eligible destination is already at its daily cap. Distinct from
// "all buyers rejected" (fixture 6): here nobody is ever contacted at all
// (the cap gate fires during eligibility, before any HTTP attempt), whereas
// fixture 6's buyers ARE contacted and decline at the response-classification
// layer. Same outward lead_status, two genuinely different real reason codes.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'all-capped',
  name: 'All capped',
  description: 'Two otherwise-eligible buyers are both already at their configured daily cap.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550104' },
  build() {
    const capped = { daily: { limit: 5, count: 5 } }; // count === limit -> next reservation would exceed it
    const m1 = buildMember('rm_d10a7f2c', { buyerId: 'buyer_aa11bb22', priority: 1, caps: capped });
    const m2 = buildMember('rm_e21b8a3d', { buyerId: 'buyer_cc33dd44', priority: 2, caps: capped });
    return { groups: [buildGroup('grp_capA9F1', [m1, m2])] };
  },
  expected: {
    reasonCode: 'CAP_DAILY',
    runStatus: 'no_eligible_member',
    callCount: 0,
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
