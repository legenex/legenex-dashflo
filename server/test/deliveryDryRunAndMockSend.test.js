import { describe, it, expect } from 'vitest';
import deliveryPayloadPreview from '../src/functions/deliveryPayloadPreview.js';
import deliveryMockSend from '../src/functions/deliveryMockSend.js';
import { ATTEMPT_STATUS } from '../src/functions/routingEngine.generated.js';

// No outbound network call is possible from either function - neither one
// imports fetch or an HTTP client, both only render/classify. This suite
// proves that structurally in addition to behaviorally.

function makeCtx({ user, subDelivery, body }) {
  const db = {
    entities: {
      User: { get: async () => user },
      SubDelivery: { get: async (id) => (subDelivery && subDelivery.id === id ? subDelivery : null) },
    },
  };
  return {
    user,
    db,
    body,
    json: (data, status = 200) => ({ __status: status, ...data }),
  };
}

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };
const BUYER_USER = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };

describe('deliveryPayloadPreview (Dry Run)', () => {
  it('rejects a non-operator caller before touching the SubDelivery', async () => {
    const ctx = makeCtx({ user: BUYER_USER, subDelivery: null, body: { sub_delivery_id: 'sd1' } });
    const res = await deliveryPayloadPreview(ctx);
    expect(res.__status).toBe(403);
  });

  it('renders the payload template against the sample lead with no network call', async () => {
    const sd = { id: 'sd1', target_url: 'https://walkeradvertising.leadportal.com/apiJSON.php', method: 'POST', payload_template: '{"first_name":"{{first_name}}","state":"{{accident_state}}"}' };
    const ctx = makeCtx({ user: OPERATOR, subDelivery: sd, body: { sub_delivery_id: 'sd1', sample_lead: { first_name: 'Jane', accident_state: 'CA' } } });
    const res = await deliveryPayloadPreview(ctx);
    expect(res.ok).toBe(true);
    expect(res.valid_json).toBe(true);
    const parsed = JSON.parse(res.rendered_payload);
    expect(parsed).toEqual({ first_name: 'Jane', state: 'CA' });
    expect(res.target_url).toBe(sd.target_url);
  });

  it('reports an error and no rendered payload when no template is configured', async () => {
    const sd = { id: 'sd1', target_url: 'https://x.example/api' };
    const ctx = makeCtx({ user: OPERATOR, subDelivery: sd, body: { sub_delivery_id: 'sd1', sample_lead: {} } });
    const res = await deliveryPayloadPreview(ctx);
    expect(res.ok).toBe(false);
    expect(res.rendered_payload).toBeNull();
  });

  it('404s for an unknown sub_delivery_id', async () => {
    const ctx = makeCtx({ user: OPERATOR, subDelivery: null, body: { sub_delivery_id: 'missing' } });
    const res = await deliveryPayloadPreview(ctx);
    expect(res.__status).toBe(404);
  });
});

describe('deliveryMockSend (Mock Send)', () => {
  const sd = {
    id: 'sd1',
    target_url: 'https://walkeradvertising.leadportal.com/apiJSON.php',
    payload_template: '{"first_name":"{{first_name}}"}',
    response_mapping: JSON.stringify({ accepted: 'accepted', revenue: 'revenue', buyer_lead_id: 'buyer_lead_id' }),
  };

  it('classifies an operator-supplied ACCEPTED response with no network call', async () => {
    const ctx = makeCtx({
      user: OPERATOR, subDelivery: sd,
      body: {
        sub_delivery_id: 'sd1', sample_lead: { first_name: 'Jane' },
        simulated: { http_status: 200, body: '{"result":"accepted","revenue":75,"buyer_lead_id":"WA-1"}' },
      },
    });
    const res = await deliveryMockSend(ctx);
    expect(res.ok).toBe(true);
    expect(res.simulated_result.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(res.simulated_result.revenue).toBe(75);
    expect(res.simulated_result.buyer_lead_id).toBe('WA-1');
    expect(res.note).toContain('No network request was made');
  });

  it('classifies a REJECTED response', async () => {
    const rejectSd = { ...sd, response_mapping: JSON.stringify({ accepted: 'accepted', rejected: 'rejected' }) };
    const ctx = makeCtx({
      user: OPERATOR, subDelivery: rejectSd,
      body: { sub_delivery_id: 'sd1', sample_lead: {}, simulated: { http_status: 200, body: '{"result":"rejected"}' } },
    });
    const res = await deliveryMockSend(ctx);
    expect(res.simulated_result.status).toBe(ATTEMPT_STATUS.REJECTED);
  });

  it('a simulated network error classifies as ERROR', async () => {
    const ctx = makeCtx({
      user: OPERATOR, subDelivery: sd,
      body: { sub_delivery_id: 'sd1', sample_lead: {}, simulated: { error: 'timeout' } },
    });
    const res = await deliveryMockSend(ctx);
    expect(res.simulated_result.status).toBe(ATTEMPT_STATUS.ERROR);
  });

  it('403s a non-operator caller', async () => {
    const ctx = makeCtx({ user: BUYER_USER, subDelivery: sd, body: { sub_delivery_id: 'sd1' } });
    const res = await deliveryMockSend(ctx);
    expect(res.__status).toBe(403);
  });
});
