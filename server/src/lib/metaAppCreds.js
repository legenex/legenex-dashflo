// Canonical Meta application credential resolver.
//
// SystemKey is authoritative. IntegrationConfig(meta_app) and environment
// variables are read-only compatibility fallbacks so an existing installation
// keeps connecting until its credential record has been imported or saved in
// Settings > API Keys > System Keys. No code writes the legacy location.

export async function resolveMetaAppCreds(db, env = process.env) {
  let appId = '';
  let appSecret = '';
  let source = 'none';
  let systemKeyId = null;

  try {
    const keys = await db.entities.SystemKey.filter({ provider: 'meta', active: true }, '-updated_date', 50);
    const preferred = keys.find((k) => String(k.client_id || '').trim() && String(k.secret || '').trim())
      || keys.find((k) => String(k.env_var || '').toUpperCase() === 'META_APP_SECRET')
      || keys[0];
    if (preferred) {
      appId = String(preferred.client_id || '').trim();
      appSecret = String(preferred.secret || '').trim();
      systemKeyId = preferred.id;
      if (appId || appSecret) source = 'system_key';
    }
  } catch { /* SystemKey may not exist before the additive schema migration. */ }

  if (!appId || !appSecret) {
    try {
      const rows = await db.entities.IntegrationConfig.filter({ name: 'meta_app' });
      const legacy = JSON.parse(rows[0]?.config || '{}');
      if (!appId) appId = String(legacy.app_id || '').trim();
      if (!appSecret) appSecret = String(legacy.app_secret || '').trim();
      if ((appId || appSecret) && source === 'none') source = 'legacy_read_only';
    } catch { /* keep looking */ }
  }

  if (!appId) appId = String(env.META_APP_ID || '').trim();
  if (!appSecret) appSecret = String(env.META_APP_SECRET || '').trim();
  if ((appId || appSecret) && source === 'none') source = 'environment';

  return {
    appId,
    appSecret,
    source,
    systemKeyId,
    configured: Boolean(appId && appSecret),
  };
}

export default resolveMetaAppCreds;
