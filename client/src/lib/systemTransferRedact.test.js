import { describe, it, expect } from 'vitest';
import { redactRecord, summariseRedactions } from './systemTransferRedact';
import { REDACTED } from './systemTransfer';

// The bundle is a file that leaves the system. These tests are the contract that
// no credential value can ride out in one.

describe('redactRecord', () => {
  it('replaces named secret fields', () => {
    const { record, redacted } = redactRecord('ApiKey', {
      id: 'x1', key: 'lgnx_live_abc123', key_prefix: 'lgnx_live', supplier_id: 's1',
    });
    expect(record.key).toBe(REDACTED);
    expect(record.key_prefix).toBe('lgnx_live'); // hint survives, it is not the secret
    expect(record.supplier_id).toBe('s1');
    expect(redacted).toContain('key');
  });

  it('leaves empty secret fields alone rather than inventing a value', () => {
    const { record, redacted } = redactRecord('Webhook', { name: 'w', secret: '' });
    expect(record.secret).toBe('');
    expect(redacted).toHaveLength(0);
  });

  it('scrubs authorization out of a JSON headers blob but keeps the shape', () => {
    const { record } = redactRecord('LeadByteConnector', {
      api_name: 'buyer-post',
      // Synthetic placeholder. A credential-shaped literal must not sit in the
      // repository even in a fixture, and the redaction path does not care what
      // the value is.
      headers: JSON.stringify({ 'Content-Type': 'application/json', Authorization: 'Bearer example-token-value' }),
    });
    const parsed = JSON.parse(record.headers);
    expect(parsed['Content-Type']).toBe('application/json');
    expect(parsed.Authorization).toBe(REDACTED);
  });

  it('scrubs a raw line formatted headers blob', () => {
    const { record } = redactRecord('ApiConnector', {
      name: 'c', headers: 'Content-Type: application/json\nX-Api-Key: abc123',
    });
    expect(record.headers).toContain('Content-Type: application/json');
    expect(record.headers).toContain(`X-Api-Key: ${REDACTED}`);
    expect(record.headers).not.toContain('abc123');
  });

  it('scrubs credentials from a destination URL query string but keeps the destination', () => {
    const { record } = redactRecord('LeadByteConnector', {
      api_name: 'c', target_url: 'https://buyer.example.com/post?campaign=mva&api_key=secret123&state=TX',
    });
    expect(record.target_url).toContain('https://buyer.example.com/post');
    expect(record.target_url).toContain('campaign=mva');
    expect(record.target_url).toContain('state=TX');
    expect(record.target_url).not.toContain('secret123');
  });

  it('leaves a clean URL untouched', () => {
    const url = 'https://buyer.example.com/post';
    const { record } = redactRecord('Webhook', { name: 'w', url });
    expect(record.url).toBe(url);
  });

  it('scrubs nested secrets inside an integration config blob', () => {
    const { record } = redactRecord('IntegrationConfig', {
      name: 'stripe',
      config: JSON.stringify({ mode: 'live', auth: { client_secret: 'cs_123', account: 'acct_1' } }),
    });
    const parsed = JSON.parse(record.config);
    expect(parsed.mode).toBe('live');
    expect(parsed.auth.client_secret).toBe(REDACTED);
    expect(parsed.auth.account).toBe('acct_1');
  });

  it('strips distribution_mode so an import can never set the operating mode', () => {
    const { record } = redactRecord('AppSettings', { brand_name: 'Legenex', distribution_mode: 'new_only' });
    expect(record.brand_name).toBe('Legenex');
    expect('distribution_mode' in record).toBe(false);
  });

  it('does not mutate the source record', () => {
    const source = { id: 'x', key: 'real_secret' };
    redactRecord('ApiKey', source);
    expect(source.key).toBe('real_secret');
  });

  it('passes through entities with no secret fields', () => {
    const source = { buyer_code: 'AG1', name: 'Buyer One', active: true };
    const { record, redacted } = redactRecord('Buyer', source);
    expect(record).toEqual(source);
    expect(redacted).toHaveLength(0);
  });
});

describe('summariseRedactions', () => {
  it('counts each scrubbed field for the re-entry checklist', () => {
    const out = summariseRedactions('ApiKey', ['key', 'key', 'headers.Authorization']);
    expect(out[0]).toEqual({ entity: 'ApiKey', field: 'key', count: 2 });
    expect(out).toHaveLength(2);
  });
});
