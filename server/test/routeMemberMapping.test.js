import { describe, it, expect } from 'vitest';
import { planRouteMemberMapping, MAPPING_STATE } from '../src/lib/routeMemberMapping.js';

function baseFixtures(over = {}) {
  return {
    routeMembers: [],
    routeGroups: [{ id: 'g1', campaign_id: 'camp1' }],
    campaigns: [{ campaign_id: 'camp1', vertical: 'MVA' }],
    buyers: [{ id: 'b1', company_name: 'Buyer One' }],
    deliveries: [{ id: 'd1', buyer_id: 'b1', status: 'active', vertical_id: 'MVA' }],
    subDeliveries: [{ id: 'sd1', delivery_id: 'd1', active: true, target_url: 'https://x.test/post' }],
    ...over,
  };
}

describe('planRouteMemberMapping: deterministic READY case', () => {
  it('maps a RouteMember to the one unambiguous candidate SubDelivery', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].state).toBe(MAPPING_STATE.READY);
    expect(plan.rows[0].proposed_sub_delivery_id).toBe('sd1');
    expect(plan.summary[MAPPING_STATE.READY]).toBe(1);
  });

  it('is idempotent: a RouteMember already mapped to a valid, buyer-consistent SubDelivery is READY and untouched', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1', sub_delivery_id: 'sd1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.READY);
    expect(plan.rows[0].proposed_sub_delivery_id).toBe(null); // nothing to propose, already correct
    expect(plan.rows[0].current_sub_delivery_id).toBe('sd1');
  });

  it('an unscoped Delivery (no vertical_id) matches any campaign vertical', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      deliveries: [{ id: 'd1', buyer_id: 'b1', status: 'active', vertical_id: null }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.READY);
  });
});

describe('planRouteMemberMapping: refuses to guess', () => {
  it('two equally valid SubDelivery candidates -> AMBIGUOUS, no proposal', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      deliveries: [
        { id: 'd1', buyer_id: 'b1', status: 'active', vertical_id: 'MVA' },
        { id: 'd2', buyer_id: 'b1', status: 'active', vertical_id: 'MVA' },
      ],
      subDeliveries: [
        { id: 'sd1', delivery_id: 'd1', active: true, target_url: 'https://x.test/a' },
        { id: 'sd2', delivery_id: 'd2', active: true, target_url: 'https://x.test/b' },
      ],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.AMBIGUOUS);
    expect(plan.rows[0].proposed_sub_delivery_id).toBe(null);
    expect(plan.rows[0].candidates).toHaveLength(2);
  });

  it('never proposes a SubDelivery owned by a different buyer, even if it is the only SubDelivery that exists', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      deliveries: [{ id: 'd1', buyer_id: 'someone-else', status: 'active', vertical_id: 'MVA' }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_DELIVERY);
    expect(plan.rows[0].proposed_sub_delivery_id).toBe(null);
  });

  it('a stale existing mapping pointing cross-buyer is reported, never silently corrected or reassigned', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      deliveries: [{ id: 'd1', buyer_id: 'someone-else', status: 'active', vertical_id: 'MVA' }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1', sub_delivery_id: 'sd1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.OWNERSHIP_MISMATCH);
    expect(plan.rows[0].proposed_sub_delivery_id).toBe(null);
  });
});

describe('planRouteMemberMapping: classification coverage', () => {
  it('no Delivery at all for the buyer -> MISSING_DELIVERY', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      deliveries: [], subDeliveries: [],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_DELIVERY);
  });

  it('a Delivery exists but has no active SubDelivery -> MISSING_SUBDELIVERY', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      subDeliveries: [{ id: 'sd1', delivery_id: 'd1', active: false, target_url: 'https://x.test/post' }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_SUBDELIVERY);
  });

  it('a SubDelivery with no target_url is not a usable candidate', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      subDeliveries: [{ id: 'sd1', delivery_id: 'd1', active: true, target_url: '' }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_SUBDELIVERY);
  });

  it('an unresolvable route_group_id -> MISSING_ROUTE', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'nope' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_ROUTE);
  });

  it('a RouteGroup whose campaign does not resolve -> MISSING_ROUTE', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeGroups: [{ id: 'g1', campaign_id: 'ghost-campaign' }],
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_ROUTE);
  });

  it('an unresolvable buyer_id -> UNKNOWN_BUYER', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'ghost-buyer', route_group_id: 'g1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.UNKNOWN_BUYER);
  });

  it('a legacy destination_id-only member is LEGACY_ONLY, never treated as a native mapping candidate', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1', destination_id: 'legacy-connector-1' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.LEGACY_ONLY);
  });

  it('a currently-mapped sub_delivery_id pointing at a deleted SubDelivery -> MISSING_SUBDELIVERY, not silently READY', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [{ id: 'm1', buyer_id: 'b1', route_group_id: 'g1', sub_delivery_id: 'sd-deleted' }],
    }));
    expect(plan.rows[0].state).toBe(MAPPING_STATE.MISSING_SUBDELIVERY);
  });
});

describe('planRouteMemberMapping: summary and scale', () => {
  it('summary counts add up to total across a mixed batch', () => {
    const plan = planRouteMemberMapping(baseFixtures({
      routeMembers: [
        { id: 'm1', buyer_id: 'b1', route_group_id: 'g1' }, // READY
        { id: 'm2', buyer_id: 'ghost', route_group_id: 'g1' }, // UNKNOWN_BUYER
        { id: 'm3', buyer_id: 'b1', route_group_id: 'g1', destination_id: 'legacy-x' }, // LEGACY_ONLY
      ],
    }));
    expect(plan.total).toBe(3);
    const sum = Object.values(plan.summary).reduce((a, b) => a + b, 0);
    expect(sum).toBe(3);
    expect(plan.summary[MAPPING_STATE.READY]).toBe(1);
    expect(plan.summary[MAPPING_STATE.UNKNOWN_BUYER]).toBe(1);
    expect(plan.summary[MAPPING_STATE.LEGACY_ONLY]).toBe(1);
  });

  it('handles a larger batch deterministically (same input, same output, run twice)', () => {
    const members = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, buyer_id: 'b1', route_group_id: 'g1' }));
    const fixtures = baseFixtures({ routeMembers: members });
    const a = planRouteMemberMapping(fixtures);
    const b = planRouteMemberMapping(fixtures);
    expect(a).toEqual(b);
    expect(a.summary[MAPPING_STATE.READY]).toBe(50);
  });
});
