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

// Callback and opener origins come from the canonical deployment configuration.
// A browser-provided host must never turn the OAuth code flow into an open
// redirect when the dashboard moves between domains.
import { functionUrl, resolveBaseUrl } from '../lib/urls.js';
import { resolveMetaAppCreds } from '../lib/metaAppCreds.js';

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
    const { appId } = await resolveMetaAppCreds(db, ctx.env);
    if (!appId) {
      return ctx.json({ error: 'META_APP_ID is not configured' }, 500);
    }

    const body = ctx.body || {};
    const configuredRedirectUri = functionUrl('metaOauthCallback', '', ctx.env);
    const bodyRedirect = typeof body.redirect_uri === 'string' ? body.redirect_uri.replace(/\/+$/, '') : '';
    const redirectUri = bodyRedirect === configuredRedirectUri ? bodyRedirect : configuredRedirectUri;
    const canonicalOrigin = resolveBaseUrl('', ctx.env);
    const origin = String(body.origin || '').replace(/\/+$/, '') === canonicalOrigin ? canonicalOrigin : '';

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
