import { describe, it, expect } from 'vitest';
import { makeTargetValidator, isBlockedIp } from '../src/lib/ssrfGuard.js';

function validatorWithLookup(map) {
  return makeTargetValidator({ lookup: async (hostname) => map[hostname] || [] });
}

describe('isBlockedIp', () => {
  it('blocks the standard private/reserved IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.114.5', '93.184.216.34']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback, unspecified, link-local and unique-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows an ordinary public IPv6 address', () => {
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });

  it('blocks an IPv4-mapped IPv6 address that maps to a private range (dotted-decimal spelling)', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  // Regression: an adversarial review found the dotted-decimal check alone
  // was bypassed, because the WHATWG URL parser (the only thing that ever
  // produces url.hostname for a bracketed IPv6 literal) never emits the
  // dotted-decimal form - it always emits the compressed hex form, verified
  // directly: new URL('http://[::ffff:169.254.169.254]/x').hostname ->
  // '[::ffff:a9fe:a9fe]'. Without handling this shape, EVERY IPv4-mapped
  // literal target bypassed the guard undetected.
  it('blocks the compressed-hex IPv4-mapped spelling the URL parser actually produces', () => {
    expect(isBlockedIp('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254, cloud metadata
    expect(isBlockedIp('::ffff:7f00:1')).toBe(true); // 127.0.0.1, loopback
    expect(isBlockedIp('::ffff:808:808')).toBe(false); // 8.8.8.8, public
  });
});

describe('makeTargetValidator', () => {
  it('allows a public https target that resolves publicly', async () => {
    const validate = validatorWithLookup({ 'buyer.example.com': [{ address: '93.184.216.34', family: 4 }] });
    const out = await validate(new URL('https://buyer.example.com/api'));
    expect(out.ok).toBe(true);
  });

  it('refuses the literal loopback IP directly, without a DNS lookup', async () => {
    const validate = validatorWithLookup({});
    const out = await validate(new URL('https://127.0.0.1/api'));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('private_target');
  });

  it('refuses a bracketed IPv4-mapped IPv6 literal target url end to end, using a real URL object', async () => {
    const validate = validatorWithLookup({});
    const out = await validate(new URL('http://[::ffff:169.254.169.254]/latest/meta-data'));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('private_target');
  });

  it('refuses ::1 and 169.254.169.254 (cloud metadata) directly', async () => {
    const validate = validatorWithLookup({});
    expect((await validate(new URL('https://[::1]/api'))).ok).toBe(false);
    expect((await validate(new URL('http://169.254.169.254/latest/meta-data'))).ok).toBe(false);
  });

  it('refuses localhost and *.localhost by hostname, without a DNS lookup', async () => {
    const validate = validatorWithLookup({});
    expect((await validate(new URL('https://localhost/api'))).ok).toBe(false);
    expect((await validate(new URL('https://foo.localhost/api'))).ok).toBe(false);
  });

  it('refuses a hostname that resolves to a private/RFC1918 address even though the string looks public', async () => {
    const validate = validatorWithLookup({ 'sneaky.example.com': [{ address: '10.1.2.3', family: 4 }] });
    const out = await validate(new URL('https://sneaky.example.com/api'));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('private_target');
  });

  it('refuses a Docker-internal-style hostname resolving to the default bridge network range', async () => {
    const validate = validatorWithLookup({ 'db': [{ address: '172.18.0.5', family: 4 }] });
    const out = await validate(new URL('http://db:5432/'));
    expect(out.ok).toBe(false);
  });

  it('refuses an unsupported scheme outright, before any DNS lookup', async () => {
    const validate = validatorWithLookup({});
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/x']) {
      const out = await validate(new URL(url));
      expect(out.ok, url).toBe(false);
      expect(out.reason).toBe('unsupported_scheme');
    }
  });

  it('refuses a target whose DNS resolution fails', async () => {
    const validate = makeTargetValidator({ lookup: async () => { throw new Error('ENOTFOUND'); } });
    const out = await validate(new URL('https://nowhere.invalid/api'));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('dns_resolution_failed');
  });

  it('accepts a bare public IP literal target directly (no DNS lookup needed)', async () => {
    const validate = validatorWithLookup({});
    const out = await validate(new URL('https://8.8.8.8/api'));
    expect(out.ok).toBe(true);
  });
});
