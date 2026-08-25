import { describe, it, expect } from 'vitest';
import deliveryHistory from '../src/functions/deliveryHistory.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeDb(attempts) {
  return {
    entities: {
      User: { get: async () => OPERATOR },
      DeliveryAttempt: {
        async filter(q) {
          return attempts.filter((a) => Object.entries(q).every(([k, v]) => a[k] === v));
        },
      },
    },
  };
}

describe('deliveryHistory: operator-safe DeliveryAttempt read', () => {
  it('403s a non-operator (e.g. a buyer portal account)', async () => {
    const buyerUser = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };
    const db = makeDb([]);
    db.entities.User.get = async () => buyerUser;
    const res = await deliveryHistory({
      user: buyerUser, db, body: { sub_delivery_id: 'sd1' }, json: (d, s = 200) => ({ __status: s, ...d }),
    });
    expect(res.__status).toBe(403);
  });

  it('400s without a sub_delivery_id', async () => {
    const db = makeDb([]);
    const res = await deliveryHistory({ user: OPERATOR, db, body: {}, json: (d, s = 200) => ({ __status: s, ...d }) });
    expect(res.__status).toBe(400);
  });

  it('returns only the safe allowlisted fields, never request_meta/response_meta/credential material', async () => {
    const attempts = [{
      id: 'a1', sub_delivery_id: 'sd1', lead_id: 'lead-1', status: 'accepted', http_status: 200,
      attempt_number: 1, is_primary: true, trigger: 'primary', error_class: null, next_retry_at: null,
      created_date: '2026-08-25T00:00:00Z', started_at: '2026-08-25T00:00:00Z', completed_at: '2026-08-25T00:00:01Z',
      request_meta: '{"headers":{"Authorization":"Bearer live-secret"}}',
      response_meta: '{"body_excerpt":"raw response body"}',
      route_member_id: 'rm1', idempotency_key: 'idem-1', run_idempotency_key: 'idem-1',
    }];
    const db = makeDb(attempts);
    const res = await deliveryHistory({
      user: OPERATOR, db, body: { sub_delivery_id: 'sd1' }, json: (d, s = 200) => ({ __status: s, ...d }),
    });
    expect(res.attempts).toHaveLength(1);
    const a = res.attempts[0];
    expect(a.status).toBe('accepted');
    expect(a.http_status).toBe(200);
    expect(a.lead_id).toBe('lead-1');
    expect(a.request_meta).toBeUndefined();
    expect(a.response_meta).toBeUndefined();
    expect(a.route_member_id).toBeUndefined();
    expect(a.idempotency_key).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('live-secret');
    expect(JSON.stringify(res)).not.toContain('raw response body');
  });

  it('only returns attempts for the requested sub_delivery_id', async () => {
    const attempts = [
      { id: 'a1', sub_delivery_id: 'sd1', lead_id: 'lead-1', status: 'accepted' },
      { id: 'a2', sub_delivery_id: 'sd2', lead_id: 'lead-2', status: 'rejected' },
    ];
    const db = makeDb(attempts);
    const res = await deliveryHistory({
      user: OPERATOR, db, body: { sub_delivery_id: 'sd1' }, json: (d, s = 200) => ({ __status: s, ...d }),
    });
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0].id).toBe('a1');
  });
});
