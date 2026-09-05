// Fixture 2 of 13: cascade + tiered price.
//
// The WORK-UNITS.yaml acceptance list names "cascade" and "tiered price" as
// two separate scenarios but enumerates 14 items under a "Thirteen fixtures"
// heading (docs/STATE.md-style off-by-one - verified by literally counting
// the comma-separated list in forge-pack/03-plan/WORK-UNITS.yaml:205, which
// has 14 entries). Recounted against the real engine: "cascade" (a rejected
// first destination falls through to a second) and "tiered price" (the
// winning destination's resolved price differs by tier) are not two
// independently reachable reason codes - they are the SAME mechanism
// (distributeLead's cross-group fallthrough, tried here across two priced
// tiers) observed from two angles. Building them as one fixture that proves
// both properties at once (fallthrough happened AND the resolved price is
// the tier that actually won, not the tier that was tried first) is the
// honest way to land on 13 real, distinct fixtures rather than inventing a
// 14th reason code that does not exist in engine.js's REASON enum.
import { SYNTHETIC_BASE_LEAD, buildMember, buildGroup } from './_helpers.js';

export const fixture = {
  id: 'cascade-tiered-price',
  name: 'Cascade (tier 1 rejects, falls through to tier 2 at a different price)',
  description: 'Tier 1 destination is eligible and reachable but the buyer declines the lead. '
    + 'Routing falls through to tier 2, a different buyer at a different price, which accepts.',
  lead: { ...SYNTHETIC_BASE_LEAD, mobile: '5555550102' },
  build(base) {
    const tier1 = buildMember('rm_3c90e217', {
      buyerId: 'buyer_1a2b3c4d', priority: 1, price: 200,
      filters: { states: ['CA'] },
      delivery: { targetUrl: `${base}/reject?bid=BYR-201` },
    });
    const tier2 = buildMember('rm_9d40f188', {
      buyerId: 'buyer_5e6f7a8b', priority: 1, price: 90,
      filters: { states: ['CA'] },
      delivery: { targetUrl: `${base}/accept?price=90&bid=BYR-202` },
    });
    return {
      groups: [
        buildGroup('grp_tier1_a001', [tier1], { orderIndex: 0 }),
        buildGroup('grp_tier2_b002', [tier2], { orderIndex: 1 }),
      ],
    };
  },
  expected: {
    reasonCode: 'accepted',
    runStatus: 'accepted',
    winnerMemberId: 'rm_9d40f188',
    revenue: 90,
    callCount: 2, // tier 1 WAS contacted (a genuine cascade, not a lucky first hit)
    attemptStatuses: ['rejected', 'accepted'],
    leadStatus: 'sold',
    finalStatus: 'Sold',
    code: 'SOLD',
  },
};
