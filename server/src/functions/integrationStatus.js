import { requireUser } from './_runtime.js';

// Reports which integrations are configured for the Integrations tab.
// In the standalone app, "configured" is derived from whether the relevant
// integration secret is present in config (falling back to env), rather than
// from a live connector handshake.
export default async function integrationStatus(ctx) {
  requireUser(ctx);
  try {
    const integrations = ctx.config.integrations || {};
    const env = ctx.env || {};
    const has = (v) => !!(v && String(v).trim());

    // Google-family connectors share the service-account credential.
    const googleReady = has(integrations.googleClientEmail) && has(integrations.googlePrivateKey);

    const status = {
      gmail: googleReady,
      googledrive: googleReady,
      googlesheets: googleReady,
      slack: has(env.SLACK_TOKEN) || has(env.SLACK_BOT_TOKEN),
      googlebigquery: googleReady,
      google_analytics: googleReady,
      whatsapp: has(integrations.whatsappToken) || has(env.WHATSAPP_TOKEN),
      mercury: has(integrations.mercuryApiKey) || has(env.MERCURY_API_KEY),
      stripe: has(integrations.stripeApiKey) || has(env.STRIPE_API_KEY),
      xero: has(integrations.xeroClientId) || has(integrations.xeroClientSecret)
        || has(env.XERO_CLIENT_ID) || has(env.XERO_CLIENT_SECRET),
    };

    return { status };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
