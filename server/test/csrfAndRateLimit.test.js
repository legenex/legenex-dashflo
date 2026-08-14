import { describe, it, expect, beforeEach } from 'vitest';
import { verifySameOrigin, allowedOrigins } from '../src/middleware/csrf.js';
import { consume, resetRateLimits } from '../src/middleware/rateLimit.js';

// Cookie-authenticated writes must prove they came from our own origin, and
// anonymous auth endpoints must be bounded so a password or an OTP cannot be
// brute forced.

const OURS = new Set(['https://dash.example.com']);

describe('same origin verification', () => {
  it('allows safe methods regardless of origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const r = verifySameOrigin({
        method, origin: 'https://evil.example', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
      });
      expect(r.ok, method).toBe(true);
    }
  });

  it('refuses a cross-site cookie-authenticated write', () => {
    const r = verifySameOrigin({
      method: 'POST', origin: 'https://evil.example', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cross-site/);
  });

  it('allows a same-origin cookie-authenticated write', () => {
    const r = verifySameOrigin({
      method: 'POST', origin: 'https://dash.example.com', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
    });
    expect(r.ok).toBe(true);
  });

  it('falls back to the referer when there is no origin header', () => {
    const ok = verifySameOrigin({
      method: 'POST', referer: 'https://dash.example.com/settings', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
    });
    expect(ok.ok).toBe(true);

    const bad = verifySameOrigin({
      method: 'POST', referer: 'https://evil.example/x', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
    });
    expect(bad.ok).toBe(false);
  });

  it('refuses a cookie-authenticated write with neither header', () => {
    const r = verifySameOrigin({
      method: 'POST', hasCookieAuth: true, hasHeaderAuth: false, allowed: OURS,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Origin or Referer/);
  });

  it('leaves header-authenticated and unauthenticated traffic alone', () => {
    // A supplier posting a lead with an API key sends no cookie. A cross-site
    // page cannot read a bearer token, so neither is a forgery risk.
    const supplier = verifySameOrigin({
      method: 'POST', hasCookieAuth: false, hasHeaderAuth: false, allowed: OURS,
    });
    expect(supplier.ok).toBe(true);

    const bearer = verifySameOrigin({
      method: 'POST', origin: 'https://anywhere.example', hasCookieAuth: true, hasHeaderAuth: true, allowed: OURS,
    });
    expect(bearer.ok).toBe(true);
  });
});

describe('allowed origins', () => {
  it('derives the origin from the configured public base url', () => {
    const set = allowedOrigins({ publicBaseUrl: 'https://dash.example.com/app' });
    expect(set.has('https://dash.example.com')).toBe(true);
  });

  it('is empty when nothing is configured', () => {
    expect(allowedOrigins({ publicBaseUrl: '' }).size).toBe(0);
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateLimits());

  it('allows up to the limit and refuses beyond it', () => {
    for (let i = 0; i < 5; i++) {
      expect(consume('login:1.2.3.4', 5, 60_000).allowed, `attempt ${i + 1}`).toBe(true);
    }
    const blocked = consume('login:1.2.3.4', 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts each key independently', () => {
    for (let i = 0; i < 5; i++) consume('login:1.2.3.4', 5, 60_000);
    expect(consume('login:1.2.3.4', 5, 60_000).allowed).toBe(false);
    // A different address is unaffected.
    expect(consume('login:5.6.7.8', 5, 60_000).allowed).toBe(true);
  });

  it('lets the window expire', () => {
    const start = 1_000_000;
    for (let i = 0; i < 5; i++) consume('otp:a', 5, 1000, start);
    expect(consume('otp:a', 5, 1000, start + 500).allowed).toBe(false);
    expect(consume('otp:a', 5, 1000, start + 1500).allowed).toBe(true);
  });

  it('bounds an attacker varying only the account name', () => {
    // The per address limit still bites even when each attempt targets a
    // different email, because that key has no email dimension.
    for (let i = 0; i < 10; i++) consume('login:9.9.9.9', 10, 60_000);
    expect(consume('login:9.9.9.9', 10, 60_000).allowed).toBe(false);
  });
});
