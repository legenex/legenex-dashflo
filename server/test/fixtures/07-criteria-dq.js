// Fixture 7 of 13: criteria disqualification (DQ).
//
// Exercises the NATIVE routing engine's buyer qualification condition tree
// (engine.js's evaluateMember step 4, evaluated through the real
// evalConditionTree from conditions.js) - REASON.QUALIFICATION_FAILED.
//
// This is a deliberately different mechanism from processLead.js's LEGACY
// LeadByteConnector-filter disqualification path (processLead.js:2343-2360,
// final_status:'Disqualified'), which lives entirely inside processLead.js's
// own non-exported connectorMatchesFilters/connectorMatchesConditions
// helpers and is out of reach of this fixture set (processLead.js is
// read-only reference for this work unit; its LeadByteConnector-filter DQ
// path is a separate legacy concept documented here, not silently conflated
// with the engine's own QUALIFICATION_FAILED). The native engine's own
// terminal status for a QUALIFICATION_FAILED-only candidate set is 'unsold',
// not 'Disqualified' - asserted honestly below rather than borrowing the
// legacy label for a different mechanism.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'criteria-dq',
  name: 'Criteria disqualification (DQ)',
  description: 'Buyer only accepts leads with a confirmed injury; this lead has none confirmed.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550107', injury_confirmed: 'no' },
  build() {
    const member = buildMember('rm_7c04d1e9', {
      buyerId: 'buyer_90a8b7c6',
      conditions: { field: 'injury_confirmed', operator: 'equals', value: 'yes' },
    });
    return { groups: [buildGroup('grp_dq3300', [member])] };
  },
  expected: {
    reasonCode: 'QUALIFICATION_FAILED',
    runStatus: 'no_eligible_member',
    callCount: 0,
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
