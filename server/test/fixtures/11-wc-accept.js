// Fixture 11 of 13: WC (Workers Compensation) accept.
//
// Same underlying REASON.ELIGIBLE / ATTEMPT_STATUS.ACCEPTED mechanism as
// fixture 1 (clean accept), deliberately exercised again with a DIFFERENT
// vertical code ('WC' instead of 'MVA') and different lead field shape
// (Workers Comp specific fields, not MVA injury/accident fields) per the
// docs/STATE.md lesson: vary field spelling/shape rather than reusing the one
// convenient lead shape everywhere - a vertical-filter bug that only breaks
// for WC (or only breaks for MVA) would be invisible if every accept fixture
// used the same vertical.
import { buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'wc-accept',
  name: 'WC (Workers Compensation) accept',
  description: 'A Workers Comp buyer accepts a WC-vertical lead with WC-specific fields.',
  lead: {
    first_name: 'Synthetic', last_name: 'WcFixture', email: 'synthetic.wc@example.test',
    mobile: '5555550111', state: 'CA', zip: '94102', vertical: 'WC',
    employer_name: 'Synthetic Employer LLC', date_of_injury: '2026-06-15',
    injury_type: 'Repetitive strain', claim_filed: 'Yes',
  },
  build(base) {
    const member = buildMember('rm_wc0a1b2c', {
      buyerId: 'buyer_wc990011', price: 60,
      filters: { verticals: ['WC'], states: ['CA'] },
      buyer: { status: 'active', active: true },
      delivery: { targetUrl: `${base}/accept?price=60&bid=BYR-WC1` },
    });
    return { groups: [buildGroup('grp_wcAccept1', [member])] };
  },
  expected: {
    reasonCode: 'accepted',
    runStatus: 'accepted',
    winnerMemberId: 'rm_wc0a1b2c',
    revenue: 60,
    callCount: 1,
    leadStatus: 'sold',
    finalStatus: 'Sold',
    code: 'SOLD',
  },
};
