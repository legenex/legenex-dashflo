import { HttpError, json } from './_runtime.js';

// In memory IP rate limiter, matching the one submitBuyerOnboarding already
// uses. Per warm instance, best effort. A short window is enough to blunt
// brute-force token guessing without a persistent store (GAP-62: this was the
// one public onboarding endpoint left without a limiter).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;
const ipHits = new Map();

function clientIp(req) {
  const headers = (req && req.headers) || {};
  const fwd = headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return headers['x-real-ip'] || (req && req.ip) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > RATE_MAX;
}

// An onboarding link is secure (128-bit token) and revocable (an operator sets
// status to 'cancelled'), but was never actually time-bound. Enforce the
// expiry the "Invalid or expired link" wording already promised: a link older
// than this is treated exactly like a revoked one, using the platform's own
// created_date timestamp so no schema change is needed.
const ONBOARDING_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isOnboardingLinkExpired(record) {
  const createdMs = record && record.created_date ? new Date(record.created_date).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return false; // never block on a missing/unparseable timestamp
  return Date.now() - createdMs > ONBOARDING_LINK_TTL_MS;
}

// PUBLIC endpoint. The token is the credential, so there is no operator gate
// and no auth check. Resolves an onboarding token to a strict allowlist of
// display-only fields used to prefill the public /apply form. Never returns
// credentials, email, billing, or any other field. Returns JSON only and never
// logs secrets.
export default async function getOnboardingContext(ctx) {
  try {
    const db = ctx.db;

    if (rateLimited(clientIp(ctx.req))) {
      return ctx.json(
        { error: 'Too many requests from this network. Please wait a moment and try again.' },
        429,
      );
    }

    const body = ctx.body || {};
    const token = body.token;
    if (!token) return ctx.json({ error: 'token is required' }, 400);

    const list = await db.entities.BuyerOnboarding.filter({ token });
    const onboarding = (Array.isArray(list) ? list : [])[0];
    if (!onboarding) return ctx.json({ error: 'Invalid or expired link.' }, 404);

    if (onboarding.status === 'complete' || onboarding.status === 'cancelled' || isOnboardingLinkExpired(onboarding)) {
      return ctx.json({ error: 'This onboarding link is no longer active.' }, 410);
    }

    const buyer = onboarding.buyer_id
      ? await db.entities.Buyer.get(onboarding.buyer_id).catch(() => null)
      : null;

    return {
      company_name: (buyer && buyer.company_name) || onboarding.company_name || '',
      vertical: (buyer && buyer.vertical) || '',
      client_type: (buyer && buyer.client_type) || '',
      buyer_code: (buyer && buyer.buyer_code) || '',
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
