import { describe, it, expect } from 'vitest';
import { classifyRouteMembersForArchival, archivedDestinationName, scopeActionsToRouteGroup } from '../src/lib/routeMemberArchival.js';

// Fixture shaped after the real production MVA campaign this cleanup exists
// for (docs/STATE.md Stage 7): one RouteGroup, six buyers, two RouteMembers
// each. One buyer (Walker) has a real active Delivery/SubDelivery and both
// its RouteMembers already resolve to it; the other five have no Delivery at
// all. Buyer names and ids are fictional, the SHAPE (12 members, 2 per buyer,
// one buyer backed and five not) matches the real diagnosed case exactly.
function buyer(id, name) { return { id, company_name: name }; }
function delivery(id, buyerId, status = 'active') { return { id, buyer_id: buyerId, status, vertical_id: null }; }
function subDelivery(id, deliveryId, active = true) { return { id, delivery_id: deliveryId, active, target_url: 'https://buyer.example/api' }; }
function member(id, over = {}) {
  return {
    id, route_group_id: 'rg1', buyer_id: over.buyer_id, sub_delivery_id: over.sub_delivery_id || null,
    destination_id: null, destination_name: over.destination_name || null, active: over.active !== false,
    priority: 1, weight: 1, price_mode: over.price_mode || 'fixed', fixed_price: over.fixed_price ?? null,
    payout_type: 'flat_cpl', conditional_pricing_enabled: false, filters: null, conditions: null,
    caps: null, budget_caps: null, kpi_metrics: null, transforms: null, ping_config: null,
    delivery_config: null, schedule: null, suppression_list_id: null,
    created_date: over.created_date || '2026-07-19T15:18:22.000Z',
    ...over,
  };
}

const routeGroups = [{ id: 'rg1', campaign_id: 'camp1' }];
const campaigns = [{ id: 'camp1', vertical: 'MVA' }];
const verticals = [];

describe('classifyRouteMembersForArchival', () => {
  it('reproduces the real diagnosed case: 12 members, 1 buyer backed, 5 orphan buyers -> 1 kept, 11 archived', () => {
    const walker = buyer('b-walker', 'Walker Advertising');
    const others = ['b-cofman', 'b-quintessa', 'b-jacoby', 'b-rainwater', 'b-bestcase'].map((id) => buyer(id, id));
    const buyers = [walker, ...others];
    const d1 = delivery('d1', 'b-walker', 'active');
    const sd1 = subDelivery('sd1', 'd1', true);
    const deliveries = [d1];
    const subDeliveries = [sd1];

    const routeMembers = [];
    // Walker: two RouteMembers, both already mapped to the real SubDelivery.
    routeMembers.push(member('rm-walker-1', { buyer_id: 'b-walker', sub_delivery_id: 'sd1', destination_name: 'Walker Advertising', created_date: '2026-07-19T15:18:22.000Z' }));
    routeMembers.push(member('rm-walker-2', { buyer_id: 'b-walker', sub_delivery_id: 'sd1', destination_name: 'Walker Advertising', created_date: '2026-07-19T17:03:36.000Z' }));
    // Five other buyers: two orphan RouteMembers each, no Delivery at all.
    for (const b of others) {
      routeMembers.push(member(`rm-${b.id}-1`, { buyer_id: b.id, destination_name: b.id, created_date: '2026-07-19T15:18:22.000Z' }));
      routeMembers.push(member(`rm-${b.id}-2`, { buyer_id: b.id, destination_name: b.id, created_date: '2026-07-19T17:03:36.000Z' }));
    }

    const result = classifyRouteMembersForArchival({ routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals });

    expect(result.remaining).toEqual(['rm-walker-1']);
    expect(result.actions).toHaveLength(11);
    const walkerDup = result.actions.find((a) => a.route_member_id === 'rm-walker-2');
    expect(walkerDup.code).toBe('EXACT_DUPLICATE');
    expect(walkerDup.kept_route_member_id).toBe('rm-walker-1');
    const orphanCodes = result.actions.filter((a) => a.route_member_id !== 'rm-walker-2').map((a) => a.code);
    expect(orphanCodes.every((c) => c === 'NO_DELIVERY_CONFIGURED')).toBe(true);
  });

  it('does not touch an already-inactive RouteMember', () => {
    const buyers = [buyer('b1', 'B1')];
    const routeMembers = [member('rm1', { buyer_id: 'b1', active: false })];
    const result = classifyRouteMembersForArchival({ routeMembers, routeGroups, campaigns, buyers, deliveries: [], subDeliveries: [], verticals });
    expect(result.actions).toHaveLength(0);
    expect(result.remaining).toEqual([]);
  });

  it('archives a member whose sub_delivery_id resolves to a REAL, active delivery owned by a DIFFERENT buyer (OWNERSHIP_MISMATCH)', () => {
    // This is the shape the display-layer fix (isConfiguredMember in
    // memberDestination.js) also had to close: sub_delivery_id is non-null
    // and resolves to something real, so it looks wired up, but the real
    // send-time resolver (snapshot.js) refuses it as CONFIG_INVALID because
    // the Delivery belongs to a different buyer than the RouteMember.
    const buyerA = buyer('b-a', 'Buyer A');
    const buyerB = buyer('b-b', 'Buyer B');
    const dB = delivery('d-b', 'b-b', 'active');
    const sdB = subDelivery('sd-b', 'd-b', true);
    const routeMembers = [member('rm1', { buyer_id: 'b-a', sub_delivery_id: 'sd-b' })];
    const result = classifyRouteMembersForArchival({
      routeMembers, routeGroups, campaigns, buyers: [buyerA, buyerB], deliveries: [dB], subDeliveries: [sdB], verticals,
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].code).toBe('OWNERSHIP_MISMATCH');
    expect(result.remaining).toEqual([]);
  });

  it('archives a member whose buyer_id does not resolve to any Buyer at all (UNKNOWN_BUYER)', () => {
    const routeMembers = [member('rm1', { buyer_id: 'b-does-not-exist' })];
    const result = classifyRouteMembersForArchival({
      routeMembers, routeGroups, campaigns, buyers: [], deliveries: [], subDeliveries: [], verticals,
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].code).toBe('UNKNOWN_BUYER');
  });

  it('never collapses two active members that differ in any routing-meaningful field, even for the same buyer/sub-delivery', () => {
    const b = buyer('b1', 'B1');
    const d1 = delivery('d1', 'b1', 'active');
    const sd1 = subDelivery('sd1', 'd1', true);
    const routeMembers = [
      member('rm1', { buyer_id: 'b1', sub_delivery_id: 'sd1', priority: 1, created_date: '2026-01-01T00:00:00Z' }),
      member('rm2', { buyer_id: 'b1', sub_delivery_id: 'sd1', priority: 2, created_date: '2026-01-01T01:00:00Z' }),
    ];
    const result = classifyRouteMembersForArchival({ routeMembers, routeGroups, campaigns, buyers: [b], deliveries: [d1], subDeliveries: [sd1], verticals });
    expect(result.actions).toHaveLength(0);
    expect(result.remaining.sort()).toEqual(['rm1', 'rm2']);
  });

  it('a member whose SubDelivery exists but is inactive is NO_DELIVERY_CONFIGURED, not silently kept', () => {
    const b = buyer('b1', 'B1');
    const d1 = delivery('d1', 'b1', 'active');
    const sd1 = subDelivery('sd1', 'd1', false); // inactive
    const routeMembers = [member('rm1', { buyer_id: 'b1', sub_delivery_id: null })];
    const result = classifyRouteMembersForArchival({ routeMembers, routeGroups, campaigns, buyers: [b], deliveries: [d1], subDeliveries: [sd1], verticals });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].code).toBe('NO_DELIVERY_CONFIGURED');
  });

  it('three exact duplicates collapse to one kept and two archived, keeping the earliest', () => {
    const b = buyer('b1', 'B1');
    const d1 = delivery('d1', 'b1', 'active');
    const sd1 = subDelivery('sd1', 'd1', true);
    const routeMembers = [
      member('rm-mid', { buyer_id: 'b1', sub_delivery_id: 'sd1', created_date: '2026-01-01T12:00:00Z' }),
      member('rm-earliest', { buyer_id: 'b1', sub_delivery_id: 'sd1', created_date: '2026-01-01T00:00:00Z' }),
      member('rm-latest', { buyer_id: 'b1', sub_delivery_id: 'sd1', created_date: '2026-01-02T00:00:00Z' }),
    ];
    const result = classifyRouteMembersForArchival({ routeMembers, routeGroups, campaigns, buyers: [b], deliveries: [d1], subDeliveries: [sd1], verticals });
    expect(result.remaining).toEqual(['rm-earliest']);
    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((a) => a.kept_route_member_id === 'rm-earliest')).toBe(true);
  });
});

// Hardening for server/scripts/archive-invalid-route-members.js's --apply
// scope requirement: an --apply run must only ever write RouteMembers in
// the one RouteGroup an operator explicitly named, never leak into a
// RouteGroup nobody has reviewed, and a second run against the same scope
// must be a no-op (idempotent).
describe('scopeActionsToRouteGroup', () => {
  // Two RouteGroups, each with the same "1 backed buyer + 1 orphan buyer"
  // shape, so a scoping bug that leaks across groups would be caught by
  // wrongly picking up rg2's orphan when scoped to rg1, or vice versa.
  const rgA = 'rg-a';
  const rgB = 'rg-b';
  const routeGroupsMixed = [{ id: rgA, campaign_id: 'camp1' }, { id: rgB, campaign_id: 'camp1' }];
  const buyersMixed = [buyer('b-a-orphan', 'Orphan A'), buyer('b-b-orphan', 'Orphan B')];
  const membersMixed = [
    member('rm-a-orphan', { route_group_id: rgA, buyer_id: 'b-a-orphan' }),
    member('rm-b-orphan', { route_group_id: rgB, buyer_id: 'b-b-orphan' }),
  ];

  function classifyMixed(members) {
    return classifyRouteMembersForArchival({
      routeMembers: members, routeGroups: routeGroupsMixed, campaigns, buyers: buyersMixed,
      deliveries: [], subDeliveries: [], verticals,
    });
  }

  it('report-only classification across the full dataset finds both groups\' candidates (safe, read-only)', () => {
    const { actions } = classifyMixed(membersMixed);
    expect(actions.map((a) => a.route_member_id).sort()).toEqual(['rm-a-orphan', 'rm-b-orphan']);
  });

  it('scoping to rg-a returns ONLY rg-a\'s candidate, never rg-b\'s', () => {
    const { actions } = classifyMixed(membersMixed);
    const scoped = scopeActionsToRouteGroup(actions, membersMixed, rgA);
    expect(scoped.map((a) => a.route_member_id)).toEqual(['rm-a-orphan']);
  });

  it('scoping to rg-b returns ONLY rg-b\'s candidate', () => {
    const { actions } = classifyMixed(membersMixed);
    const scoped = scopeActionsToRouteGroup(actions, membersMixed, rgB);
    expect(scoped.map((a) => a.route_member_id)).toEqual(['rm-b-orphan']);
  });

  it('a RouteGroup with no candidates of its own modifies zero rows even though the dataset has candidates elsewhere', () => {
    const emptyGroup = { id: 'rg-empty', campaign_id: 'camp1' };
    const { actions } = classifyRouteMembersForArchival({
      routeMembers: membersMixed, routeGroups: [...routeGroupsMixed, emptyGroup], campaigns,
      buyers: buyersMixed, deliveries: [], subDeliveries: [], verticals,
    });
    const scoped = scopeActionsToRouteGroup(actions, membersMixed, 'rg-empty');
    expect(scoped).toEqual([]);
  });

  it('no routeGroupId at all (the --apply-without---route-group refusal case) scopes to nothing, never falls back to "everything"', () => {
    const { actions } = classifyMixed(membersMixed);
    expect(scopeActionsToRouteGroup(actions, membersMixed, null)).toEqual([]);
    expect(scopeActionsToRouteGroup(actions, membersMixed, undefined)).toEqual([]);
    expect(scopeActionsToRouteGroup(actions, membersMixed, '')).toEqual([]);
  });

  it('second apply is idempotent: once the scoped candidate is archived (active:false), reclassifying finds nothing left to do in that scope', () => {
    const { actions: firstPass } = classifyMixed(membersMixed);
    const scoped = scopeActionsToRouteGroup(firstPass, membersMixed, rgA);
    expect(scoped).toHaveLength(1);

    // Simulate exactly what --apply would have written: active:false on the
    // one archived row, nothing else touched.
    const afterApply = membersMixed.map((m) => (m.id === 'rm-a-orphan' ? { ...m, active: false } : m));
    const { actions: secondPass } = classifyMixed(afterApply);
    const secondScoped = scopeActionsToRouteGroup(secondPass, afterApply, rgA);
    expect(secondScoped).toEqual([]);
    // rg-b's untouched candidate is still correctly found on the full-dataset
    // pass - idempotency in rg-a did not silently affect rg-b.
    expect(secondPass.map((a) => a.route_member_id)).toEqual(['rm-b-orphan']);
  });
});

describe('archivedDestinationName', () => {
  it('appends a marker to an existing name', () => {
    expect(archivedDestinationName('Walker Advertising', 'EXACT_DUPLICATE'))
      .toBe('Walker Advertising (ARCHIVED: EXACT_DUPLICATE - see docs/STATE.md Stage 7)');
  });

  it('produces just the marker when there is no existing name', () => {
    expect(archivedDestinationName(null, 'NO_DELIVERY_CONFIGURED'))
      .toBe('(ARCHIVED: NO_DELIVERY_CONFIGURED - see docs/STATE.md Stage 7)');
    expect(archivedDestinationName('', 'NO_DELIVERY_CONFIGURED'))
      .toBe('(ARCHIVED: NO_DELIVERY_CONFIGURED - see docs/STATE.md Stage 7)');
  });
});
