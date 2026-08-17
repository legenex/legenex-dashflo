// Google-issued identity verification.
//
// Flow
// ----
// DashFlo uses the Google Identity Services ID token flow, not the
// authorization code flow. The browser renders Google's button, Google returns
// a signed ID token (a JWT) to the page, the page posts that token to
// POST /api/auth/google, and this module proves it.
//
// That choice is deliberate and is driven by what login actually needs:
//
//   - Login needs identity, nothing else. openid, email and profile are the
//     only scopes involved, and the ID token already carries all three. No
//     Google API is ever called on the user's behalf, so there is no access
//     token to obtain and no refresh token to store.
//   - The ID token flow needs no Client Secret. There is therefore no secret
//     to leak to the browser, none to rotate, and none to store on the VPS for
//     login purposes. The authorization code flow would require one purely to
//     exchange a code for tokens we would then throw away.
//   - It needs no Authorized Redirect URI, only an Authorized JavaScript
//     Origin, so there is one less production URL to keep in step with nginx.
//
// If DashFlo later needs to call a Google API as the user (Sheets, Ads), that
// is a separate authorization concern with its own consent screen and its own
// credential, and it must not be folded into login.
//
// What is verified
// ----------------
// Everything below is checked before an identity is returned. A token that
// fails any check is rejected with a stable reason and the token itself is
// never logged.
//
//   1. structure         three base64url segments, decodable header and body
//   2. algorithm         RS256 only, taken from the header and pinned
//   3. signing key       header kid must match a key in Google's live JWKS
//   4. signature         RSA-SHA256 over the exact signing input
//   5. issuer            accounts.google.com or https://accounts.google.com
//   6. audience          aud equals our Client ID exactly
//   7. authorized party  azp equals our Client ID when present
//   8. expiry            exp in the future, iat not implausibly ahead
//   9. nonce             equals the nonce the server issued, when one is bound
//  10. verified email    email_verified is true and an email is present
//
// The provider identity is `sub`, Google's stable subject identifier. It is
// the only field that identifies the Google account durably: an email address
// can be changed or reassigned within a Workspace domain, so trusting email as
// the identity would let a reassigned address inherit somebody else's account.
// Email is used to *find* a candidate DashFlo account once, at link time, and
// never again after `sub` is recorded.

import crypto from 'node:crypto';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// The only scopes login asks for. Anything beyond identity belongs to a
// separate integration with its own consent, not to authentication.
export const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'];

// Tolerance for clock skew between this host and Google, in seconds.
const CLOCK_SKEW_SECONDS = 120;

// Floor and ceiling for how long a fetched JWKS is reused, regardless of what
// the response's cache-control says. Google rotates keys roughly daily.
const JWKS_MIN_TTL_MS = 60_000;
const JWKS_MAX_TTL_MS = 6 * 60 * 60_000;
const JWKS_DEFAULT_TTL_MS = 60 * 60_000;

export class GoogleIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleIdentityError';
    this.code = code;
  }
}

function decodeSegment(segment, label) {
  try {
    const json = Buffer.from(String(segment), 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new GoogleIdentityError('MALFORMED_TOKEN', `Google token ${label} is not readable`);
  }
}

// ── JWKS ────────────────────────────────────────────────────────────────────

function ttlFromCacheControl(header) {
  const match = /max-age\s*=\s*(\d+)/i.exec(String(header || ''));
  if (!match) return JWKS_DEFAULT_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return JWKS_DEFAULT_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, seconds * 1000));
}

// A JWKS cache with a single in-flight fetch. Two simultaneous logins after a
// key rotation must not both go to Google.
export function createJwksCache({ url = GOOGLE_JWKS_URL, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let keys = null;
  let expiresAt = 0;
  let inFlight = null;

  async function load() {
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch {
      // A DNS or socket failure must surface as a typed, caller-safe error.
      // Letting the raw transport error escape leaks host detail into a login
      // response and skips the audit path, which classifies by code.
      throw new GoogleIdentityError('JWKS_UNAVAILABLE', 'Could not reach Google to read its signing keys');
    }
    if (!response || !response.ok) {
      throw new GoogleIdentityError('JWKS_UNAVAILABLE', 'Could not read Google signing keys');
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new GoogleIdentityError('JWKS_UNAVAILABLE', 'Google signing key set is empty');
    }
    keys = body.keys;
    expiresAt = now() + ttlFromCacheControl(response.headers?.get?.('cache-control'));
    return keys;
  }

  return {
    // `force` refetches once when a kid is unknown, which is what a key
    // rotation looks like from here. It does not retry in a loop.
    async get({ force = false } = {}) {
      if (!force && keys && now() < expiresAt) return keys;
      if (!inFlight) {
        inFlight = load().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    // Test seam. Never called by the request path.
    _seed(seededKeys, ttlMs = JWKS_DEFAULT_TTL_MS) {
      keys = seededKeys;
      expiresAt = now() + ttlMs;
    },
  };
}

const defaultJwksCache = createJwksCache();

function keyForKid(keys, kid) {
  return keys.find((key) => key && key.kid === kid && (key.kty === 'RSA') && (!key.use || key.use === 'sig'));
}

// ── Verification ────────────────────────────────────────────────────────────

function verifySignature(token, jwk) {
  const [header, body, signature] = token.split('.');
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new GoogleIdentityError('BAD_SIGNING_KEY', 'Google signing key could not be read');
  }
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${body}`, 'utf8'),
    publicKey,
    Buffer.from(String(signature), 'base64url'),
  );
}

function assertClaims(claims, { clientId, expectedNonce, nowSeconds }) {
  if (!GOOGLE_ISSUERS.has(String(claims.iss || ''))) {
    throw new GoogleIdentityError('BAD_ISSUER', 'Google token issuer is not recognised');
  }

  // aud may legitimately be a string or a single-entry array.
  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
  if (!audiences.includes(String(clientId))) {
    throw new GoogleIdentityError('BAD_AUDIENCE', 'Google token was not issued for this application');
  }

  // azp is the party the token was released to. Google sets it on ID tokens
  // from the Identity Services button. When present it must be us as well,
  // otherwise a token minted for another client that happens to list our
  // audience would pass.
  if (claims.azp != null && String(claims.azp) !== String(clientId)) {
    throw new GoogleIdentityError('BAD_AUDIENCE', 'Google token was released to another application');
  }

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new GoogleIdentityError('TOKEN_EXPIRED', 'Google token has expired');
  }

  const iat = Number(claims.iat);
  if (Number.isFinite(iat) && iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new GoogleIdentityError('TOKEN_NOT_YET_VALID', 'Google token is not valid yet');
  }

  // Nonce binding. Only enforced when the caller issued one, and compared in
  // constant time so a mismatch reveals nothing by timing.
  if (expectedNonce) {
    const presented = Buffer.from(String(claims.nonce || ''), 'utf8');
    const expected = Buffer.from(String(expectedNonce), 'utf8');
    const ok = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
    if (!ok) throw new GoogleIdentityError('BAD_NONCE', 'Google token nonce does not match this login attempt');
  }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) {
    throw new GoogleIdentityError('NO_EMAIL', 'Google token carries no email address');
  }
  // Google encodes email_verified as a boolean or the string "true" depending
  // on the surface. An unverified address proves nothing about who is signing
  // in, so it is refused rather than trusted.
  const verified = claims.email_verified === true || String(claims.email_verified) === 'true';
  if (!verified) {
    throw new GoogleIdentityError('EMAIL_NOT_VERIFIED', 'This Google account has no verified email address');
  }

  const sub = String(claims.sub || '').trim();
  if (!sub) {
    throw new GoogleIdentityError('NO_SUBJECT', 'Google token carries no subject identifier');
  }

  return { sub, email, verified };
}

// Verify a Google ID token and return the identity it proves.
//
// `jwks` is injectable so tests exercise the real verification path against
// locally generated keys instead of reaching Google. Invariant 6: tests never
// use live endpoints.
export async function verifyGoogleIdToken(token, {
  clientId,
  expectedNonce = null,
  jwks = defaultJwksCache,
  now = () => Date.now(),
} = {}) {
  if (!clientId) {
    throw new GoogleIdentityError('NOT_CONFIGURED', 'Google sign-in is not configured on this server');
  }
  const raw = String(token ?? '').trim();
  if (!raw) throw new GoogleIdentityError('MISSING_TOKEN', 'No Google token was supplied');

  const parts = raw.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new GoogleIdentityError('MALFORMED_TOKEN', 'Google token is not a well formed JWT');
  }

  const header = decodeSegment(parts[0], 'header');
  // The algorithm is pinned rather than taken as a hint. Accepting whatever
  // the header names is how "alg: none" and HS256-with-the-public-key forgeries
  // get in.
  if (String(header.alg) !== 'RS256') {
    throw new GoogleIdentityError('BAD_ALGORITHM', 'Google token is not signed with RS256');
  }
  const kid = String(header.kid || '');
  if (!kid) throw new GoogleIdentityError('BAD_ALGORITHM', 'Google token names no signing key');

  let keys = await jwks.get();
  let jwk = keyForKid(keys, kid);
  if (!jwk) {
    // Unknown kid is what a key rotation looks like. Refetch once.
    keys = await jwks.get({ force: true });
    jwk = keyForKid(keys, kid);
  }
  if (!jwk) throw new GoogleIdentityError('UNKNOWN_SIGNING_KEY', 'Google token was signed by an unknown key');

  if (!verifySignature(raw, jwk)) {
    throw new GoogleIdentityError('BAD_SIGNATURE', 'Google token signature did not verify');
  }

  const claims = decodeSegment(parts[1], 'body');
  const nowSeconds = Math.floor(now() / 1000);
  const { sub, email } = assertClaims(claims, { clientId, expectedNonce, nowSeconds });

  return {
    sub,
    email,
    emailVerified: true,
    name: String(claims.name || '').trim(),
    givenName: String(claims.given_name || '').trim(),
    picture: String(claims.picture || '').trim(),
    // Workspace domain, absent for consumer gmail.com accounts. Exposed so an
    // installation can restrict sign-in to its own domain.
    hostedDomain: String(claims.hd || '').trim(),
  };
}

export default {
  GOOGLE_JWKS_URL,
  GOOGLE_ISSUERS,
  GOOGLE_LOGIN_SCOPES,
  GoogleIdentityError,
  createJwksCache,
  verifyGoogleIdToken,
};
