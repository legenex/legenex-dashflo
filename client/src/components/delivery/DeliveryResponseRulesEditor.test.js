import { describe, it, expect } from 'vitest';
import { classifyResponse, ATTEMPT_STATUS } from '@/lib/distribution/deliveryAttempt.js';
import { parseResponseMapping } from '@/lib/deliveryResponseMapping';

// Pins the editor's persisted SubDelivery.response_mapping shape against the
// real classifyResponse it feeds in production (via deliveryResolve.js's
// toResponseMapping -> directPost.js).

describe('DeliveryResponseRulesEditor <-> classifyResponse contract', () => {
  it('parses the stored JSON shape', () => {
    const raw = JSON.stringify({ accepted: 'accepted', revenue: 'revenue', buyer_lead_id: 'buyer_lead_id' });
    expect(parseResponseMapping(raw)).toEqual({ accepted: 'accepted', revenue: 'revenue', buyer_lead_id: 'buyer_lead_id' });
    expect(parseResponseMapping('')).toEqual({});
  });

  it('an accept pattern match classifies as ACCEPTED regardless of HTTP status', () => {
    const mapping = parseResponseMapping(JSON.stringify({ accepted: 'accepted' }));
    const status = classifyResponse({
      httpStatus: 200, body: '{"result":"accepted"}',
      mapping: { accept: mapping.accepted },
    });
    expect(status).toBe(ATTEMPT_STATUS.ACCEPTED);
  });

  it('require_accept turns an unmatched 2xx into REJECTED, not a false sale', () => {
    const mapping = parseResponseMapping(JSON.stringify({ accepted: 'sold', require_accept: true }));
    const status = classifyResponse({
      httpStatus: 200, body: '{"result":"pending"}',
      mapping: { accept: mapping.accepted, requireAccept: mapping.require_accept },
    });
    expect(status).toBe(ATTEMPT_STATUS.REJECTED);
  });

  it('duplicate is checked before reject and accept', () => {
    const mapping = parseResponseMapping(JSON.stringify({ accepted: 'ok', rejected: 'error', duplicate: 'dupe' }));
    const status = classifyResponse({
      httpStatus: 200, body: '{"status":"dupe: already sold, error: none, ok: false"}',
      mapping: { accept: mapping.accepted, reject: mapping.rejected, duplicate: mapping.duplicate },
    });
    expect(status).toBe(ATTEMPT_STATUS.DUPLICATE);
  });

  it('with no patterns configured, HTTP status alone decides', () => {
    expect(classifyResponse({ httpStatus: 200, body: '{}', mapping: {} })).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(classifyResponse({ httpStatus: 409, body: '{}', mapping: {} })).toBe(ATTEMPT_STATUS.DUPLICATE);
    expect(classifyResponse({ httpStatus: 500, body: '{}', mapping: {} })).toBe(ATTEMPT_STATUS.ERROR);
    expect(classifyResponse({ httpStatus: 400, body: '{}', mapping: {} })).toBe(ATTEMPT_STATUS.REJECTED);
  });

  it('a network error always classifies as ERROR regardless of mapping', () => {
    expect(classifyResponse({ error: new Error('boom'), mapping: { accept: '.*' } })).toBe(ATTEMPT_STATUS.ERROR);
  });
});
