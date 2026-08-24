import { describe, it, expect } from 'vitest';
import ensureDeliveryRouteMember from '../src/functions/ensureDeliveryRouteMember.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeDb({ subDelivery, delivery, campaigns = [], existingMembers = [] }) {
  const created = { routeGroups: [], routeMembers: [] };
  return {
    created,
    entities: {
      User: { get: async () => OPERATOR },
      SubDelivery: { get: async (id) => (subDelivery && subDelivery.id === id ? subDelivery : null) },
      Delivery: { get: async (id) => (delivery && delivery.id === id ? delivery : null) },
      RouteMember: {
        filter: async ({ sub_delivery_id }) => existingMembers.filter((m) => m.sub_delivery_id === sub_delivery_id),
        create: async (data) => { const row = { id: `rm-${created.routeMembers.length + 1}`, ...data }; created.routeMembers.push(row); return row; },
      },
      Campaign: { filter: async ({ vertical }) => campaigns.filter((c) => c.vertical === vertical) },
      RouteGroup: {
        create: async (data) => { const row = { id: `rg-${created.routeGroups.length + 1}`, ...data }; created.routeGroups.push(row); return row; },
      },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('ensureDeliveryRouteMember', () => {
  const subDelivery = { id: 'sd1', delivery_id: 'd1', name: 'Primary' };
  const delivery = { id: 'd1', buyer_id: 'b1', name: 'Walker native', vertical_id: 'MVA' };
  const mvaCampaign = { id: 'camp1', vertical: 'MVA', name: 'MVA' };

  it('creates a dedicated RouteGroup that is inactive/draft by construction', async () => {
    const db = makeDb({ subDelivery, delivery, campaigns: [mvaCampaign] });
    const res = await ensureDeliveryRouteMember(ctxFor(db, { sub_delivery_id: 'sd1' }));
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(db.created.routeGroups).toHaveLength(1);
    expect(db.created.routeGroups[0].active).toBe(false);
    expect(db.created.routeGroups[0].lifecycle).toBe('draft');
    expect(res.route_member.sub_delivery_id).toBe('sd1');
    expect(res.route_member.buyer_id).toBe('b1');
  });

  it('is idempotent: a second call reuses the existing RouteMember and creates nothing new', async () => {
    const db = makeDb({
      subDelivery, delivery, campaigns: [mvaCampaign],
      existingMembers: [{ id: 'rm-existing', sub_delivery_id: 'sd1', buyer_id: 'b1' }],
    });
    const res = await ensureDeliveryRouteMember(ctxFor(db, { sub_delivery_id: 'sd1' }));
    expect(res.created).toBe(false);
    expect(res.route_member.id).toBe('rm-existing');
    expect(db.created.routeGroups).toHaveLength(0);
    expect(db.created.routeMembers).toHaveLength(0);
  });

  it('refuses with a clear error when the delivery has no vertical set', async () => {
    const noVertical = { ...delivery, vertical_id: null };
    const db = makeDb({ subDelivery, delivery: noVertical, campaigns: [mvaCampaign] });
    const res = await ensureDeliveryRouteMember(ctxFor(db, { sub_delivery_id: 'sd1' }));
    expect(res.__status).toBe(409);
    expect(res.error).toContain('vertical');
  });

  it('refuses with a clear error when no Campaign exists for the vertical', async () => {
    const db = makeDb({ subDelivery, delivery, campaigns: [] });
    const res = await ensureDeliveryRouteMember(ctxFor(db, { sub_delivery_id: 'sd1' }));
    expect(res.__status).toBe(409);
    expect(res.error).toContain('Campaign');
  });

  it('404s for an unknown sub_delivery_id', async () => {
    const db = makeDb({ subDelivery: null, delivery, campaigns: [mvaCampaign] });
    const res = await ensureDeliveryRouteMember(ctxFor(db, { sub_delivery_id: 'missing' }));
    expect(res.__status).toBe(404);
  });
});
