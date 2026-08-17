// Canonical Google application credential resolver.
//
// Same shape as resolveMetaAppCreds: SystemKey is authoritative, the
// environment is a read-only fallback so an installation keeps working before
// the credential has been entered in Settings > API Keys > System Keys.
//
// Only the Client ID matters for login. It is a public value: the browser must
// receive it to render Google's button, and Google's own documentation treats
// it as non-secret. The Client Secret field exists on the record because a
// later Google integration (Sheets, Ads) that uses the authorization code flow
// will need one, but nothing in the authentication path reads it, and it is
// never projected to a client.

const GOOGLE_PROVIDER = 'google';

export async function resolveGoogleAppCreds(db, env = process.env, configured = {}) {
  let clientId = '';
  let systemKeyId = null;
  let source = 'none';
  let hasSecret = false;

  try {
    const keys = await db.entities.SystemKey.filter({ provider: GOOGLE_PROVIDER, active: true }, '-updated_date', 50);
    const preferred = keys.find((key) => String(key.client_id || '').trim()) || keys[0];
    if (preferred) {
      clientId = String(preferred.client_id || '').trim();
      systemKeyId = preferred.id;
      hasSecret = Boolean(String(preferred.secret || '').trim());
      if (clientId) source = 'system_key';
    }
  } catch {
    // SystemKey may be absent before the additive schema migration has run.
  }

  if (!clientId) {
    clientId = String(configured.clientId || '').trim() || String(env.GOOGLE_CLIENT_ID || '').trim();
    if (clientId) source = 'environment';
  }

  return {
    clientId,
    systemKeyId,
    source,
    hasSecret,
    configured: Boolean(clientId),
  };
}

export default resolveGoogleAppCreds;
