// Google ID token verification.
//
// These exercise the real verifier against locally generated RSA keys. Nothing
// here reaches Google: the JWKS is injected, which is what the `jwks` parameter
// exists for. Invariant 6, tests never use live endpoints.
//
// Every check the verifier makes gets a test that fails without it. A verifier
// is only worth what its negative cases prove, and the dangerous failures here
// are silent ones: a token that is accepted when it should not be hands
// somebody else's identity to a caller.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyGoogleIdToken,
  createJwksCache,
  GoogleIdentityError,
  GOOGLE_LOGIN_SCOPES,
} from '../src/lib/googleIdentity.js';

const CLIENT_ID = '1234567890-dashflo.apps.googleusercontent.com';
const OTHER_CLIENT = '9999999999-somebodyelse.apps.googleusercontent.com';

let keyPair;
let otherKeyPair;
let jwks;

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Build and sign a token the way Google does, so the verifier is exercised
// against the real structure rather than a convenient stand-in.
function makeToken({
  claims = {},
  kid = 'test-key-1',
  alg = 'RS256',
  key = keyPair.privateKey,
  signature = null,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg, kid, typ: 'JWT' });
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '110248495921238986420',
    email: 'operator@example.test',
    email_verified: true,
    name: 'Ada Lovelace',
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const input = `${header}.${body}`;
  const sig = signature ?? crypto.sign('RSA-SHA256', Buffer.from(input, 'utf8'), key).toString('base64url');
  return `${input}.${sig}`;
}

beforeAll(() => {
  keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  otherKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };
  // The fetch returns the same key set the cache is seeded with, so a forced
  // refetch for an unknown kid still finds nothing and the verifier reports an
  // unknown signing key rather than a transport failure. That is the real
  // shape: Google is reachable, the key simply is not one of its own.
  jwks = createJwksCache({
    fetchImpl: async () => ({ ok: true, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: [jwk] }) }),
  });
  jwks._seed([jwk]);
});

describe('a valid Google token', () => {
  it('returns the identity, keyed on the stable subject rather than the email', async () => {
    const identity = await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, jwks });
    expect(identity.sub).toBe('110248495921238986420');
    expect(identity.email).toBe('operator@example.test');
    expect(identity.emailVerified).toBe(true);
    expect(identity.name).toBe('Ada Lovelace');
  });

  it('lowercases and trims the email so account matching is stable', async () => {
    const identity = await verifyGoogleIdToken(
      makeToken({ claims: { email: '  Operator@Example.TEST ' } }),
      { clientId: CLIENT_ID, jwks },
    );
    expect(identity.email).toBe('operator@example.test');
  });

  it('accepts either issuer spelling Google uses', async () => {
    for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
      const identity = await verifyGoogleIdToken(makeToken({ claims: { iss } }), { clientId: CLIENT_ID, jwks });
      expect(identity.sub, iss).toBeTruthy();
    }
  });

  it('accepts an audience delivered as a single entry array', async () => {
    const identity = await verifyGoogleIdToken(makeToken({ claims: { aud: [CLIENT_ID] } }), { clientId: CLIENT_ID, jwks });
    expect(identity.sub).toBeTruthy();
  });

  it('reports the hosted domain when the account is in a Workspace', async () => {
    const identity = await verifyGoogleIdToken(makeToken({ claims: { hd: 'dashflo.io' } }), { clientId: CLIENT_ID, jwks });
    expect(identity.hostedDomain).toBe('dashflo.io');
  });
});

describe('a token that must be refused', () => {
  async function refusal(token, options = {}) {
    try {
      await verifyGoogleIdToken(token, { clientId: CLIENT_ID, jwks, ...options });
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleIdentityError);
      return error.code;
    }
    throw new Error('token was accepted when it should have been refused');
  }

  it('refuses a token signed by a key that is not Google', async () => {
    // The forgery that matters. Everything else about the token is correct.
    expect(await refusal(makeToken({ key: otherKeyPair.privateKey }))).toBe('BAD_SIGNATURE');
  });

  it('refuses a tampered payload even though the signature is well formed', async () => {
    const token = makeToken();
    const [header, , signature] = token.split('.');
    const forged = b64({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'attacker',
      email: 'owner@example.test', email_verified: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await refusal(`${header}.${forged}.${signature}`)).toBe('BAD_SIGNATURE');
  });

  it('refuses alg none, which is the classic JWT bypass', async () => {
    const header = b64({ alg: 'none', kid: 'test-key-1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'x', email: 'x@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 60 });
    expect(await refusal(`${header}.${body}.`)).toBe('MALFORMED_TOKEN');
    expect(await refusal(`${header}.${body}.aaaa`)).toBe('BAD_ALGORITHM');
  });

  it('refuses HS256, so the public key cannot be used as a shared secret', async () => {
    const header = b64({ alg: 'HS256', kid: 'test-key-1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'x', email: 'x@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 60 });
    const pub = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    const mac = crypto.createHmac('sha256', pub).update(`${header}.${body}`).digest('base64url');
    expect(await refusal(`${header}.${body}.${mac}`)).toBe('BAD_ALGORITHM');
  });

  it('refuses a token minted for a different application', async () => {
    expect(await refusal(makeToken({ claims: { aud: OTHER_CLIENT, azp: OTHER_CLIENT } }))).toBe('BAD_AUDIENCE');
  });

  it('refuses a token whose authorized party is somebody else', async () => {
    // aud names us, azp names another client. Without the azp check this
    // would pass.
    expect(await refusal(makeToken({ claims: { azp: OTHER_CLIENT } }))).toBe('BAD_AUDIENCE');
  });

  it('refuses a token from an issuer that is not Google', async () => {
    expect(await refusal(makeToken({ claims: { iss: 'https://accounts.google.com.attacker.example' } }))).toBe('BAD_ISSUER');
  });

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await refusal(makeToken({ claims: { iat: past, exp: past + 3600 } }))).toBe('TOKEN_EXPIRED');
  });

  it('refuses a token issued implausibly far in the future', async () => {
    const ahead = Math.floor(Date.now() / 1000) + 86400;
    expect(await refusal(makeToken({ claims: { iat: ahead, exp: ahead + 3600 } }))).toBe('TOKEN_NOT_YET_VALID');
  });

  it('refuses an unverified email, which proves nothing about who is signing in', async () => {
    expect(await refusal(makeToken({ claims: { email_verified: false } }))).toBe('EMAIL_NOT_VERIFIED');
    expect(await refusal(makeToken({ claims: { email_verified: 'false' } }))).toBe('EMAIL_NOT_VERIFIED');
  });

  it('accepts the string form of email_verified, which some Google surfaces send', async () => {
    const identity = await verifyGoogleIdToken(makeToken({ claims: { email_verified: 'true' } }), { clientId: CLIENT_ID, jwks });
    expect(identity.emailVerified).toBe(true);
  });

  it('refuses a token with no email or no subject', async () => {
    expect(await refusal(makeToken({ claims: { email: '' } }))).toBe('NO_EMAIL');
    expect(await refusal(makeToken({ claims: { sub: '' } }))).toBe('NO_SUBJECT');
  });

  it('refuses a token signed by an unknown key id', async () => {
    expect(await refusal(makeToken({ kid: 'rotated-away' }))).toBe('UNKNOWN_SIGNING_KEY');
  });

  it('refuses a nonce that does not match this login attempt', async () => {
    expect(await refusal(makeToken({ claims: { nonce: 'from-another-attempt' } }), { expectedNonce: 'this-attempt' }))
      .toBe('BAD_NONCE');
    expect(await refusal(makeToken(), { expectedNonce: 'this-attempt' })).toBe('BAD_NONCE');
  });

  it('accepts a matching nonce', async () => {
    const identity = await verifyGoogleIdToken(
      makeToken({ claims: { nonce: 'this-attempt' } }),
      { clientId: CLIENT_ID, jwks, expectedNonce: 'this-attempt' },
    );
    expect(identity.sub).toBeTruthy();
  });

  it('refuses malformed input rather than throwing something unhelpful', async () => {
    for (const bad of ['', '   ', 'not-a-jwt', 'a.b', 'a.b.c.d', '..']) {
      const code = await refusal(bad);
      expect(['MISSING_TOKEN', 'MALFORMED_TOKEN'], bad).toContain(code);
    }
  });

  it('refuses to verify anything when no Client ID is configured', async () => {
    try {
      await verifyGoogleIdToken(makeToken(), { clientId: '', jwks });
      throw new Error('accepted without a client id');
    } catch (error) {
      expect(error.code).toBe('NOT_CONFIGURED');
    }
  });
});

describe('signing key retrieval', () => {
  it('refetches once when a key id is unknown, which is what rotation looks like', async () => {
    let calls = 0;
    const stale = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'about-to-rotate-out', use: 'sig' };
    const rotated = { ...otherKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rotated-in', use: 'sig' };
    const cache = createJwksCache({
      // First read is the key set from before the rotation, second is after.
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: true,
          headers: { get: () => 'public, max-age=3600' },
          json: async () => ({ keys: calls === 1 ? [stale] : [rotated] }),
        };
      },
    });
    const identity = await verifyGoogleIdToken(
      makeToken({ kid: 'rotated-in', key: otherKeyPair.privateKey }),
      { clientId: CLIENT_ID, jwks: cache },
    );
    expect(identity.sub).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('caches, so a second verification does not refetch', async () => {
    let calls = 0;
    const jwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig' };
    const cache = createJwksCache({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: [jwk] }) };
      },
    });
    await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, jwks: cache });
    await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, jwks: cache });
    expect(calls).toBe(1);
  });

  it('reports an unavailable key set rather than accepting the token', async () => {
    const cache = createJwksCache({ fetchImpl: async () => ({ ok: false, headers: { get: () => null }, json: async () => ({}) }) });
    await expect(verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, jwks: cache }))
      .rejects.toMatchObject({ code: 'JWKS_UNAVAILABLE' });
  });
});

describe('login scope policy', () => {
  it('asks for identity only, never Gmail, Drive, Calendar, Ads or Sheets', () => {
    expect(GOOGLE_LOGIN_SCOPES).toEqual(['openid', 'email', 'profile']);
    const joined = GOOGLE_LOGIN_SCOPES.join(' ');
    for (const forbidden of ['gmail', 'drive', 'calendar', 'contacts', 'adwords', 'spreadsheets']) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
  });
});
