import { describe, it, expect } from 'vitest';
import duplicateDelivery from '../src/functions/duplicateDelivery.js';

const OPERATOR = { id: 'u1', base_role: 'operator' };

function makeDb({ delivery, subDeliveries = [] }) {
  const created = { deliveries: [], subDeliveries: [] };
  return {
    created,
    entities: {
      Delivery: {
        get: async (id) => (delivery && delivery.id === id ? delivery : null),
        create: async (data) => { const row = { id: `d-${created.deliveries.length + 1}`, ...data }; created.deliveries.push(row); return row; },
      },
      SubDelivery: {
        filter: async ({ delivery_id }) => subDeliveries.filter((s) => s.delivery_id === delivery_id),
        create: async (data) => { const row = { id: `sd-${created.subDeliveries.length + 1}`, ...data }; created.subDeliveries.push(row); return row; },
      },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('duplicateDelivery', () => {
  const delivery = { id: 'd1', buyer_id: 'b1', name: 'Walker - 30 Days', vertical_id: 'v1', status: 'active', notes: 'n' };
  const sub1 = {
    id: 'sd1', delivery_id: 'd1', name: 'Tier 1', active: true, order_index: 0,
    target_url: 'https://buyer.example/api', method: 'POST', encoding: 'json',
    query_params: '', delete_with_body: false,
    headers: '{"X-Env":"prod"}', credential_ref: 'walker_auth', credential_updated_at: '2026-01-01T00:00:00Z',
    field_map: '[]', transforms: '[]', payload_template: '{"a":"{{email}}"}',
    response_mapping: '{"rejected":"\\"errors\\""}', timeout_ms: 8000, retry_policy: '{"max_attempts":3}',
  };
  const sub2 = { id: 'sd2', delivery_id: 'd1', name: 'Tier 3 (ARCHIVED)', active: false, target_url: 'https://buyer.example/api2', method: 'GET' };

  it('creates a new Delivery for the same buyer, always draft, name suffixed Copy', async () => {
    const db = makeDb({ delivery, subDeliveries: [sub1, sub2] });
    const res = await duplicateDelivery(ctxFor(db, { deliveryId: 'd1' }));
    expect(res.success).toBe(true);
    expect(db.created.deliveries).toHaveLength(1);
    const newDelivery = db.created.deliveries[0];
    expect(newDelivery.buyer_id).toBe('b1');
    expect(newDelivery.name).toBe('Walker - 30 Days Copy');
    expect(newDelivery.status).toBe('draft'); // never inherits an active source's status
    expect(newDelivery.vertical_id).toBe('v1');
  });

  it('copies every SubDelivery under the source, including reusable config and the credential_ref pointer', async () => {
    const db = makeDb({ delivery, subDeliveries: [sub1, sub2] });
    const res = await duplicateDelivery(ctxFor(db, { deliveryId: 'd1' }));
    expect(db.created.subDeliveries).toHaveLength(2);
    const copy1 = db.created.subDeliveries.find((s) => s.name === 'Tier 1');
    expect(copy1.delivery_id).toBe(res.deliveryId);
    expect(copy1.method).toBe('POST');
    expect(copy1.headers).toBe('{"X-Env":"prod"}');
    expect(copy1.credential_ref).toBe('walker_auth'); // opaque reference, not a secret - safe to copy
    expect(copy1.payload_template).toBe('{"a":"{{email}}"}');
    expect(copy1.response_mapping).toBe('{"rejected":"\\"errors\\""}');
    expect(copy1.retry_policy).toBe('{"max_attempts":3}');
    const copy2 = db.created.subDeliveries.find((s) => s.name === 'Tier 3 (ARCHIVED)');
    expect(copy2.active).toBe(false);
    expect(copy2.method).toBe('GET');
  });

  it('resets credential_updated_at on the copy (a brand new record, not a just-replaced credential)', async () => {
    const db = makeDb({ delivery, subDeliveries: [sub1] });
    await duplicateDelivery(ctxFor(db, { deliveryId: 'd1' }));
    expect(db.created.subDeliveries[0].credential_updated_at).toBe(null);
  });

  it('404s for an unknown deliveryId', async () => {
    const db = makeDb({ delivery: null, subDeliveries: [] });
    const res = await duplicateDelivery(ctxFor(db, { deliveryId: 'nope' }));
    expect(res.__status).toBe(404);
    expect(res.success).toBe(false);
    expect(db.created.deliveries).toHaveLength(0);
  });

  it('400s when deliveryId is missing', async () => {
    const db = makeDb({ delivery, subDeliveries: [] });
    const res = await duplicateDelivery(ctxFor(db, {}));
    expect(res.__status).toBe(400);
  });

  it('requires an authenticated user', async () => {
    const db = makeDb({ delivery, subDeliveries: [sub1] });
    await expect(duplicateDelivery({ user: null, db, body: { deliveryId: 'd1' }, json: (d, s) => ({ __status: s, ...d }) }))
      .rejects.toThrow();
  });
});
