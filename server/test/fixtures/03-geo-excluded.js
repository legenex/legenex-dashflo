// Fixture 3 of 13: geo excluded.
//
// The buyer's zip allowlist does not include the lead's zip. Uses FILTER_ZIP
// specifically (not FILTER_STATE) so it stays distinct from the "WC state
// inactive" fixture, which exercises the buyer LIFECYCLE status field, not a
// geographic filter - the two must not collapse onto the same REASON code.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'geo-excluded',
  name: 'Geo excluded',
  description: 'Buyer only accepts leads from a specific zip allowlist; the lead\'s zip is outside it.',
  // Realistic zip that is genuinely outside the buyer's allowlist below, not
  // merely a different single digit of the same fictional zip.
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550103', zip: '75201', state: 'TX', accident_state: 'TX' },
  build() {
    const member = buildMember('rm_2a71c9e0', {
      buyerId: 'buyer_c4d5e6f7', price: 80,
      filters: { zips: ['90210', '90211', '90212'] },
    });
    return { groups: [buildGroup('grp_c00110', [member])] };
  },
  expected: {
    reasonCode: 'FILTER_ZIP',
    runStatus: 'no_eligible_member',
    callCount: 0,
    // No explicit RUN.NO_ELIGIBLE branch in processLead.js's native handling
    // (processLead.js:2445-2506) - it falls to the generic legacyOff branch
    // (processLead.js:2495-2504): lead_status 'unsold', final_status
    // 'Unsold', code 'UNSOLD'.
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
