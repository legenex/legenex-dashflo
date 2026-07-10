import { requireUser, HttpError, json } from './_runtime.js';

// Admin only. Builds the Facebook Login dialog URL. When called directly in the
// browser (GET) it redirects there with a 302. When called via the SDK (which
// sends the auth header) it returns the URL as JSON so the frontend can perform
// a top-level navigation itself. redirect_uri is fixed to the metaOauthCallback
// function. A random state value is sent for basic CSRF protection.
export default async function metaOauthStart(ctx) {
  try {
    const user = requireUser(ctx);
    if (!user || user.role !== 'admin') {
      return ctx.json({ error: 'Unauthorized' }, 401);
    }

    const appId =
      ctx.config?.integrations?.metaAppId || ctx.env?.META_APP_ID;
    if (!appId) {
      return ctx.json({ error: 'META_APP_ID is not configured' }, 500);
    }

    const redirectUri = 'https://api.legenex.com/functions/metaOauthCallback';
    const state = crypto.randomUUID();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: 'ads_read,ads_management,business_management',
      response_type: 'code',
      state,
    });

    const dialogUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;

    // If the caller expects JSON (SDK invoke from the dashboard), return the URL
    // so the frontend can navigate the top-level window to Facebook itself.
    const accept = ctx.req?.headers?.accept || '';
    if (accept.includes('application/json')) {
      return ctx.json({ url: dialogUrl });
    }

    return ctx.json(null, 302, { Location: dialogUrl });
  } catch (error) {
    if (error instanceof HttpError) {
      return ctx.json({ error: error.message }, error.status);
    }
    return ctx.json({ error: error.message }, 500);
  }
}
