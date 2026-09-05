// Fixture 12 of 13: WC state inactive.
//
// Positive/negative pair with fixture 11 on the SAME buyer construct. "State"
// here is the buyer's lifecycle STATUS field (evaluateMember step 1: eligible
// only when buyer.status === 'active' AND buyer.active === true - "paused,
// terminated, draft, suspended, unknown state... is ineligible", per
// engine.js's own comment), not a US geographic state - that axis is already
// covered distinctly by fixture 3 (geo excluded, REASON.FILTER_ZIP). Keeping
// these on different REASON codes (BUYER_LIFECYCLE_INELIGIBLE vs FILTER_ZIP)
// is what makes both fixtures real, separately-justified reason codes instead
// of two descriptions of the same one.
import { buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'wc-state-inactive',
  name: 'WC state inactive',
  description: 'The Workers Comp buyer\'s account status is not active (paused), so it is ineligible '
    + 'regardless of an otherwise-matching lead.',
  lead: {
    first_name: 'Synthetic', last_name: 'WcFixture', email: 'synthetic.wc2@example.test',
    mobile: '5555550112', state: 'CA', zip: '94102', vertical: 'WC',
    employer_name: 'Synthetic Employer LLC', date_of_injury: '2026-06-20',
  },
  build() {
    const member = buildMember('rm_wc3d4e5f', {
      buyerId: 'buyer_wc990022', price: 60,
      filters: { verticals: ['WC'], states: ['CA'] },
      // status field says paused; active flag alone is not enough - evaluateMember
      // requires BOTH to read active, matching either alone must still fail.
      buyer: { status: 'paused', active: true },
    });
    return { groups: [buildGroup('grp_wcInactive2', [member])] };
  },
  expected: {
    reasonCode: 'BUYER_LIFECYCLE_INELIGIBLE',
    runStatus: 'no_eligible_member',
    callCount: 0,
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
