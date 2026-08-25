import { describe, it, expect } from 'vitest';
import distributionConfig from '../src/functions/distributionConfig.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function filterOne(rows) {
  return async ({ id }) => rows.filter((r) => r.id === id);
}

function makeDb({ groups = [], members = [], buyers = [], destinations = [], subDeliveries = [], deliveries = [] } = {}) {
  const created = { audits: [], versions: [], groupUpdates: [] };
  return {
    created,
    entities: {
      User: { get: async () => OPERATOR },
      RouteGroup: {
        filter: async ({ id }) => groups.filter((g) => g.id === id),
        create: async (data) => { const row = { id: `rg-${groups.length + 1}`, ...data }; groups.push(row); return row; },
        update: async (id, patch) => { created.groupUpdates.push({ id, patch }); return { id, ...patch }; },
      },
      RouteMember: { filter: async ({ route_group_id }) => members.filter((m) => m.route_group_id === route_group_id) },
      Buyer: { filter: filterOne(buyers) },
      LeadByteConnector: { filter: filterOne(destinations) },
      SubDelivery: { filter: filterOne(subDeliveries) },
      Delivery: { filter: filterOne(deliveries) },
      RouteConfigVersion: {
        create: async (data) => { const row = { id: `rcv-${created.versions.length + 1}`, ...data }; created.versions.push(row); return row; },
        filter: async () => created.versions,
      },
      DistributionAudit: { create: async (data) => { created.audits.push(data); return data; } },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

const GROUP = { id: 'g1', campaign_id: 'camp1', method: 'priority', order_index: 0 };
const NATIVE_BUYER = { id: 'b1', status: 'active', active: true };
const NATIVE_DELIVERY = { id: 'd1', buyer_id: 'b1', status: 'active' };
const NATIVE_SUB = {
  id: 'sd1', delivery_id: 'd1', active: true, target_url: 'https://buyer.example/post',
  response_mapping: JSON.stringify({ accepted: 'ok' }),
};
const NATIVE_MEMBER = { id: 'm1', route_group_id: 'g1', buyer_id: 'b1', sub_delivery_id: 'sd1', active: true, priority: 1, price_mode: 'fixed', fixed_price: 10 };

describe('distributionConfig: validate/publish load the real SubDelivery/Delivery a native member references', () => {
  it('validate passes for a fully-configured native (sub_delivery_id) member', async () => {
    // Regression: loadConfig() used to fetch only Buyer/LeadByteConnector, so
    // validateConfigForPublish always received an empty subDeliveries/deliveries
    // set and reported "sub-delivery not found" for every native member
    // regardless of how well-configured the real SubDelivery actually was.
    const db = makeDb({
      groups: [GROUP], members: [NATIVE_MEMBER], buyers: [NATIVE_BUYER],
      subDeliveries: [NATIVE_SUB], deliveries: [NATIVE_DELIVERY],
    });
    const res = await distributionConfig(ctxFor(db, { action: 'validate', route_group_id: 'g1' }));
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('publish succeeds end to end for the same native member and creates a RouteConfigVersion', async () => {
    const db = makeDb({
      groups: [GROUP], members: [NATIVE_MEMBER], buyers: [NATIVE_BUYER],
      subDeliveries: [NATIVE_SUB], deliveries: [NATIVE_DELIVERY],
    });
    const res = await distributionConfig(ctxFor(db, { action: 'publish', route_group_id: 'g1' }));
    expect(res.ok).toBe(true);
    expect(db.created.versions).toHaveLength(1);
    expect(db.created.groupUpdates[0].patch.lifecycle).toBe('active');
    expect(db.created.audits).toHaveLength(1);
    expect(db.created.audits[0].action).toBe('publish');
  });

  it('still fails closed with the real, specific reason when the SubDelivery genuinely lacks a response_mapping', async () => {
    const incomplete = { ...NATIVE_SUB, response_mapping: '' };
    const db = makeDb({
      groups: [GROUP], members: [NATIVE_MEMBER], buyers: [NATIVE_BUYER],
      subDeliveries: [incomplete], deliveries: [NATIVE_DELIVERY],
    });
    const res = await distributionConfig(ctxFor(db, { action: 'validate', route_group_id: 'g1' }));
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.detail === 'sub-delivery missing response mapping')).toBe(true);
    // Must be this specific reason, not the generic "sub-delivery not found"
    // the missing-fetch bug produced for every native member.
    expect(res.errors.some((e) => e.detail === 'sub-delivery not found')).toBe(false);
  });

  it('the legacy destination_id path is unaffected', async () => {
    const legacyMember = { id: 'm2', route_group_id: 'g1', buyer_id: 'b1', destination_id: 'dest1', active: true, priority: 1, price_mode: 'fixed', fixed_price: 10 };
    const destination = { id: 'dest1', enabled: true };
    const db = makeDb({ groups: [GROUP], members: [legacyMember], buyers: [NATIVE_BUYER], destinations: [destination] });
    const res = await distributionConfig(ctxFor(db, { action: 'validate', route_group_id: 'g1' }));
    expect(res.valid).toBe(true);
  });
});
