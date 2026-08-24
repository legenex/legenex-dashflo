import { describe, it, expect } from 'vitest';
import { resolveTokenValue, applyTransform, resolveTemplate, buildPayloadFromTemplate } from './payloadTemplate.js';

// Pure extraction from testWebhookDelivery.js - behavior must be unchanged.
describe('payloadTemplate resolver', () => {
  it('resolves canonical field aliases', () => {
    expect(resolveTokenValue('first_name', { firstname: 'Jane' })).toBe('Jane');
    expect(resolveTokenValue('mobile', { phone1: '5551234567' })).toBe('5551234567');
    expect(resolveTokenValue('accident_state', { state: 'CA' })).toBe('CA');
  });

  it('falls back to a direct property lookup for unknown tokens', () => {
    expect(resolveTokenValue('type_of_injury', { type_of_injury: 'Back injury' })).toBe('Back injury');
    expect(resolveTokenValue('nothing_here', {})).toBe('');
  });

  it('applies transforms: lowercase, uppercase, trim, phone_us, sha256', async () => {
    expect(await applyTransform('  ABC  ', 'trim')).toBe('ABC');
    expect(await applyTransform('ABC', 'lowercase')).toBe('abc');
    expect(await applyTransform('abc', 'uppercase')).toBe('ABC');
    expect(await applyTransform('5551234567', 'phone_us')).toBe('15551234567');
    const hash = await applyTransform('test@example.com', 'sha256');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolveTemplate substitutes {{token}} and {{token|transform}} in place, escaping JSON specials', async () => {
    const tmpl = '{"email":"{{email|lowercase}}","name":"{{first_name}}"}';
    const out = await resolveTemplate(tmpl, { email: 'Jane@Example.com', first_name: 'Jane "J" Doe' });
    const parsed = JSON.parse(out);
    expect(parsed.email).toBe('jane@example.com');
    expect(parsed.name).toBe('Jane "J" Doe');
  });

  it('buildPayloadFromTemplate returns parsed JSON when the template is valid', async () => {
    const out = await buildPayloadFromTemplate('{"a":"{{first_name}}"}', { first_name: 'Jane' });
    expect(out).toEqual({ a: 'Jane' });
  });

  it('buildPayloadFromTemplate returns the data unchanged when no template is set', async () => {
    const data = { a: 1 };
    expect(await buildPayloadFromTemplate('', data)).toBe(data);
    expect(await buildPayloadFromTemplate(null, data)).toBe(data);
  });

  it('chained transforms apply left to right', async () => {
    const out = await resolveTemplate('{{email|trim|lowercase}}', { email: '  JANE@X.COM  ' });
    expect(out).toBe('jane@x.com');
  });
});
