// Fixture 10 of 13: DNC suppressed.
//
// This is engine.js's own per-buyer route-member suppression list
// (REASON.SUPPRESSED), which the module's neighbor
// server/src/lib/dncEnforcement.js documents explicitly as a DIFFERENT
// mechanism from global do-not-contact screening: "A buyer keeps its own
// list of contacts it does not want. It runs inside routing, per member, and
// a hit only makes that one member ineligible." Global DNC (lib/dnc.js /
// lib/dncEnforcement.js, checked once at intake before routing) is a
// separate concern outside this work unit's read_context (deliveryMockSend.js
// / campaignDeliveryTest.js / the distribution engine) and is not exercised
// here.
//
// Deliberately reproduces the exact field-spelling lesson from
// docs/STATE.md: an earlier suite passed only because every DNC fixture used
// `lead.phone`, never `lead.mobile`, the canonical field - a real bug there
// would have been invisible. matchesSuppression (engine.js) reads
// `lead.mobile || lead.phone`, so this fixture:
//   - sets `mobile` (canonical) to the suppressed number, and
//   - sets `phone` (the non-canonical alias) to a DIFFERENT, non-suppressed
//     number, so the test can only pass if the real code actually reads
//     `mobile` first rather than accidentally matching (or being masked by)
//     `phone`.
// The suppression list entry itself is also formatted differently from the
// lead's own digit-only phone shape (parens/dashes/spaces) to prove the
// digit-normalization in matchesSuppression, not a lucky exact-string match.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

const SUPPRESSED_DIGITS = '5555550187';

export const fixture = {
  id: 'dnc-suppressed',
  name: 'DNC suppressed',
  description: 'The lead\'s canonical mobile number is on the buyer\'s suppression list; '
    + 'a different, non-suppressed value sits in the legacy phone field.',
  lead: {
    ...SYNTHETIC_BASE_LEAD,
    mobile: SUPPRESSED_DIGITS,      // canonical field: suppressed
    phone: '5555550188',            // non-canonical alias: NOT suppressed
  },
  build() {
    const member = buildMember('rm_9a0b1c2d', {
      buyerId: 'buyer_dnc44002',
      // Formatted differently from the lead's own plain-digit shape.
      suppression: ['(555) 555-0187'],
    });
    return { groups: [buildGroup('grp_dnc9910', [member])] };
  },
  expected: {
    reasonCode: 'SUPPRESSED',
    runStatus: 'no_eligible_member',
    callCount: 0, // a suppressed lead must never be contacted, per AGENTS.md invariant 5
    leadStatus: 'unsold',
    finalStatus: 'Unsold',
    code: 'UNSOLD',
  },
};
