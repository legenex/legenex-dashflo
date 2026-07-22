const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

// Operator authorization, mirroring src/lib/distribution/operatorAuth.js: admins
// and operators holding a management permission are allowed; portal (buyer or
// supplier) accounts are rejected.
function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Fallback callback URL (Legenex production custom domain). The wizard normally
// passes the current host's callback URL so the flow works on any domain,
// including preview environments.
const DEFAULT_REDIRECT_URI = 'https://api.legenex.com/functions/metaOauthCallback';

// Loads the Meta app credentials from IntegrationConfig(name='meta_app') first
// (set via the in-app credentials field), falling back to environment vars.
async function loadMetaAppCreds(db, env) {
  let appId = '';
  let appSecret = '';
  try {
    const list = await db.entities.IntegrationConfig.filter({ name: 'meta_app' });
    const cfg = JSON.parse(list[0]?.config || '{}');
    appId = String(cfg.app_id || '').trim();
    appSecret = String(cfg.app_secret || '').trim();
  } catch { /* ignore */ }
  if (!appId) appId = env.META_APP_ID || '';
  if (!appSecret) appSecret = env.META_APP_SECRET || '';
  return { appId, appSecret };
}

// Operator only. Builds the Facebook Login dialog URL for the connect popup.
// The frontend passes its own origin and the current-host callback URL; both
// are stored with the single-use CSRF state so the callback can verify the
// request and reuse the exact same redirect_uri in the token exchange. Scope is
// ads_read + business_management only.
export default async function metaOauthStart(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) {
      return ctx.json({ error: 'Unauthorized' }, 401);
    }

    const db = ctx.db;
    const { appId } = await loadMetaAppCreds(db, ctx.env);
    if (!appId) {
      return ctx.json({ error: 'META_APP_ID is not configured' }, 500);
    }

    const body = ctx.body || {};
    const bodyRedirect = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    const redirectUri = (bodyRedirect.startsWith('https://') && bodyRedirect.endsWith('/functions/metaOauthCallback'))
      ? bodyRedirect
      : DEFAULT_REDIRECT_URI;
    const origin = (typeof body.origin === 'string' && body.origin.startsWith('https://')) ? body.origin : '';

    const state = crypto.randomUUID();

    // Persist the state plus origin and redirect_uri so the callback can verify
    // and reuse them. Keep only entries from the last hour so the record never
    // grows unbounded.
    const cutoff = Date.now() - 3600000;
    const stateList = await db.entities.IntegrationConfig.filter({ name: 'meta_oauth_state' });
    const record = stateList[0] || null;
    let states = [];
    try { states = JSON.parse(record?.config || '{}').states || []; } catch { states = []; }
    states = states.filter(s => s && s.created_at > cutoff).slice(-19);
    states.push({ state, created_at: Date.now(), origin, redirect_uri: redirectUri });
    const payload = JSON.stringify({ states });
    if (record) await db.entities.IntegrationConfig.update(record.id, { config: payload });
    else await db.entities.IntegrationConfig.create({ name: 'meta_oauth_state', config: payload });

    // Lead form access needs extra scopes. Kept opt-in so the default connect
    // flow keeps the smallest scope set and is not made harder to approve.
    const baseScope = 'ads_read,business_management';
    const leadFormScope = 'pages_show_list,leads_retrieval,pages_read_engagement';
    const scope = body.include_lead_forms ? `${baseScope},${leadFormScope}` : baseScope;

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope,
      response_type: 'code',
      state,
    });

    const dialogUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;

    // Returned so the frontend opens the popup itself, and so the exact
    // redirect_uri to whitelist in the Meta app is visible to the caller.
    return { url: dialogUrl, redirect_uri: redirectUri };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
