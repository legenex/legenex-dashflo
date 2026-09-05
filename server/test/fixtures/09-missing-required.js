// Fixture 9 of 13: missing required field.
//
// Buyer requires date_of_birth and trustedform_url. This lead carries a real
// trustedform_url (matching the TRUSTEDFORM_RE gate shape) but no
// date_of_birth at all - the exact "one field present, one field absent"
// shape missingRequiredFields must catch, not a lead missing every field
// (which would be a much weaker, less adversarial test).
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'missing-required',
  name: 'Missing required field',
  description: 'Buyer requires date_of_birth; this lead has trustedform_url but no date_of_birth.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550109', date_of_birth: undefined },
  requiredFields: ['date_of_birth', 'trustedform_url'],
  build() {
    const member = buildMember('rm_6f0e1d2c', {
      buyerId: 'buyer_req99001',
      filters: { required_fields: ['date_of_birth', 'trustedform_url'] },
    });
    return { groups: [buildGroup('grp_req8820', [member])] };
  },
  expected: {
    reasonCode: 'MISSING_REQUIRED_FIELDS',
    runStatus: 'no_eligible_member',
    callCount: 0,
    missingFields: ['date_of_birth'],
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
