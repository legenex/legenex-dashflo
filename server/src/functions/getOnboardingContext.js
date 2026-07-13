import { HttpError, json } from './_runtime.js';

// PUBLIC endpoint. The token is the credential, so there is no operator gate
// and no auth check. Resolves an onboarding token to a strict allowlist of
// display-only fields used to prefill the public /apply form. Never returns
// credentials, email, billing, or any other field. Returns JSON only and never
// logs secrets.
export default async function getOnboardingContext(ctx) {
  try {
    const db = ctx.db;

    const body = ctx.body || {};
    const token = body.token;
    if (!token) return ctx.json({ error: 'token is required' }, 400);

    const list = await db.entities.BuyerOnboarding.filter({ token });
    const onboarding = (Array.isArray(list) ? list : [])[0];
    if (!onboarding) return ctx.json({ error: 'Invalid or expired link.' }, 404);

    if (onboarding.status === 'complete' || onboarding.status === 'cancelled') {
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
