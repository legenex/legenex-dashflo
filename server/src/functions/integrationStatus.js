import { requireUser } from './_runtime.js';
import { parseConfig } from '../lib/integrationConfig.js';

// Reports which integrations are configured for the Integrations tab.
// In the standalone app, "configured" is derived from whether the relevant
// integration secret is present in config (falling back to env), rather than
// from a live connector handshake.

// `ctx.config.integrations.*` is populated once from process.env at server
// startup (see server/src/config.js) and never from the database, so it can
// never see a credential an operator saved through Settings > Integrations,
// which writes to the IntegrationConfig entity via saveIntegrationConfig.
// Without this, Stripe (and any other DB-only integration) shows
// "Not connected" here even while syncStripe.js uses the stored credential
// successfully. Checked by presence of any non-empty value, not a specific
// field name, so this does not need to track each provider's exact secret
// key name.
async function hasDbConfig(db, name) {
  try {
    const rows = await db.entities.IntegrationConfig.filter({ name });
    const { config } = parseConfig(rows[0]?.config);
    return Object.values(config).some((v) => v !== '' && v !== null && v !== undefined);
  } catch {
    return false;
  }
}

export default async function integrationStatus(ctx) {
  requireUser(ctx);
  try {
    const integrations = ctx.config.integrations || {};
    const env = ctx.env || {};
    const has = (v) => !!(v && String(v).trim());

    // Google-family connectors share the service-account credential.
    const googleReady = has(integrations.googleClientEmail) && has(integrations.googlePrivateKey);

    const [whatsappDb, mercuryDb, stripeDb, xeroDb] = await Promise.all([
      hasDbConfig(ctx.db, 'whatsapp'),
      hasDbConfig(ctx.db, 'mercury'),
      hasDbConfig(ctx.db, 'stripe'),
      hasDbConfig(ctx.db, 'xero'),
    ]);

    const status = {
      gmail: googleReady,
      googledrive: googleReady,
      googlesheets: googleReady,
      slack: has(env.SLACK_TOKEN) || has(env.SLACK_BOT_TOKEN),
      googlebigquery: googleReady,
      google_analytics: googleReady,
      whatsapp: whatsappDb || has(integrations.whatsappToken) || has(env.WHATSAPP_TOKEN),
      mercury: mercuryDb || has(integrations.mercuryApiKey) || has(env.MERCURY_API_KEY),
      stripe: stripeDb || has(integrations.stripeApiKey) || has(env.STRIPE_API_KEY),
      xero: xeroDb || has(integrations.xeroClientId) || has(integrations.xeroClientSecret)
        || has(env.XERO_CLIENT_ID) || has(env.XERO_CLIENT_SECRET),
    };

    return { status };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
