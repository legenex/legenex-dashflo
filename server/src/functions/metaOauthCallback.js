const settingsUrl = 'https://app.legenex.com/settings?tab=integrations';

// Admin only. Handles the Facebook Login redirect: exchanges the code for a
// short-lived token, then a long-lived token, reads the connected account,
// and merges the result into IntegrationConfig(name="meta").config while
// preserving any existing system_user_token. On success it redirects the
// browser back to the Settings Integrations page; on error it redirects back
// with an error query param.
export default async function metaOauthCallback(ctx) {
  const redirectBack = (extra) =>
    ctx.json(null, 302, { Location: `${settingsUrl}${extra}` });

  try {
    const user = ctx.user;
    if (!user || user.role !== 'admin') {
      return ctx.json({ error: 'Unauthorized' }, 401);
    }

    const db = ctx.db;

    const code = ctx.req.query.code;
    if (!code) {
      return redirectBack('&meta_error=missing_code');
    }

    const appId =
      (ctx.config && ctx.config.integrations && ctx.config.integrations.metaAppId) ||
      ctx.env.META_APP_ID;
    const appSecret =
      (ctx.config && ctx.config.integrations && ctx.config.integrations.metaAppSecret) ||
      ctx.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      return redirectBack('&meta_error=not_configured');
    }

    const ver = 'v21.0';
    const redirectUri = 'https://api.legenex.com/functions/metaOauthCallback';

    // 1. Exchange the authorization code for a short-lived access token.
    const shortParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });
    const shortRes = await fetch(
      `https://graph.facebook.com/${ver}/oauth/access_token?${shortParams.toString()}`,
    );
    const shortJson = await shortRes.json();
    if (shortJson.error || !shortJson.access_token) {
      return redirectBack('&meta_error=token_exchange_failed');
    }

    // 2. Exchange the short-lived token for a long-lived one (~60 days).
    const longParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortJson.access_token,
    });
    const longRes = await fetch(
      `https://graph.facebook.com/${ver}/oauth/access_token?${longParams.toString()}`,
    );
    const longJson = await longRes.json();
    if (longJson.error || !longJson.access_token) {
      return redirectBack('&meta_error=long_token_failed');
    }

    const accessToken = longJson.access_token;
    const expiresIn = Number(longJson.expires_in) || 0;
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // 3. Read the connected account.
    const meRes = await fetch(
      `https://graph.facebook.com/${ver}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    );
    const meJson = await meRes.json();
    if (meJson.error) {
      return redirectBack('&meta_error=account_read_failed');
    }

    // 4. Merge into IntegrationConfig(name="meta"), preserving system_user_token.
    const cfgList = await db.entities.IntegrationConfig.filter({ name: 'meta' });
    const existing = cfgList[0];

    let currentConfig = {};
    if (existing) {
      try { currentConfig = JSON.parse(existing.config || '{}') || {}; } catch { currentConfig = {}; }
    }

    const mergedConfig = {
      ...currentConfig,
      access_token: accessToken,
      token_expires_at: tokenExpiresAt,
      connected_account: { id: meJson.id, name: meJson.name },
      connected_at: new Date().toISOString(),
      system_user_token: currentConfig.system_user_token || null,
    };

    const configString = JSON.stringify(mergedConfig);
    if (existing) {
      await db.entities.IntegrationConfig.update(existing.id, { config: configString });
    } else {
      await db.entities.IntegrationConfig.create({ name: 'meta', config: configString });
    }

    return redirectBack('&meta_connected=1');
  } catch (error) {
    return ctx.json(null, 302, {
      Location: `https://app.legenex.com/settings?tab=integrations&meta_error=${encodeURIComponent(error.message)}`,
    });
  }
}
