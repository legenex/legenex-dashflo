// Syncs Meta ad spend across every configured token. A system-user token only
// reaches one Business Manager, so config.tokens = [{ id, label, token }] lets
// one account cover ad accounts spread across several Businesses. A lone legacy
// config.access_token is treated as one unlabeled token.
// Writes account-level daily AdSpend rows so the Ad Spend cost dashboard fills
// in automatically. Runs with full data access so the scheduled automation (no
// user) can run it. Sync is account level only to avoid double counting.
export default async function syncMetaSpend(ctx) {
  try {
    const db = ctx.db;
    // Manual calls carry a user token; scheduled calls do not. Require admin when a user is present.
    const user = ctx.user || null;
    if (user && user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

    const cfgList = await db.entities.IntegrationConfig.filter({ name: 'meta' });

    // Resolve tokens: prefer config.tokens, fall back to a single legacy token.
    let tokens = [];
    try {
      const cfg = JSON.parse(cfgList[0]?.config || '{}');
      if (Array.isArray(cfg.tokens) && cfg.tokens.length) {
        tokens = cfg.tokens
          .filter((t) => t && t.token)
          .map((t, i) => ({ id: t.id || `token_${i}`, label: t.label || `Token ${i + 1}`, token: t.token }));
      } else {
        const legacy = cfg.system_user_token || cfg.master_token || cfg.access_token || '';
        if (legacy) tokens = [{ id: 'default', label: 'Default', token: legacy }];
      }
    } catch { tokens = []; }
    if (!tokens.length) return ctx.json({ error: 'Meta not connected' }, 400);

    const ver = 'v21.0';

    // Load every ad-account-level mapping once, indexed by ad_account_id so we
    // can attribute supplier / vertical / brand where a mapping exists.
    const allMappings = await db.entities.AdSpendMapping.list();
    const acctMappingById = {};
    for (const m of allMappings) {
      if (m.platform === 'meta' && m.enabled && m.match_level === 'ad_account' && m.ad_account_id) {
        acctMappingById[m.ad_account_id] = m;
      }
    }

    // Build the deduped account list across all tokens; each account keeps the
    // token that can access it. Note any token that fails to load accounts.
    const accountsById = {};
    const tokenErrors = [];
    for (const t of tokens) {
      const acctUrl = `https://graph.facebook.com/${ver}/me/adaccounts?fields=id,name,account_id,currency&limit=200&access_token=${encodeURIComponent(t.token)}`;
      const acctRes = await fetch(acctUrl);
      const acctJson = await acctRes.json();
      if (acctJson.error) {
        tokenErrors.push({ label: t.label, error: acctJson.error.message || 'Failed to load ad accounts' });
        continue;
      }
      for (const a of acctJson.data || []) {
        if (!accountsById[a.id]) accountsById[a.id] = { id: a.id, name: a.name || a.id, token: t.token, token_label: t.label };
      }
    }

    let inserted = 0;
    let accountsSynced = 0;
    const usedMappingIds = new Set();

    for (const acct of Object.values(accountsById)) {
      const node = acct.id; // act_XXXX
      const accountName = acct.name;
      const mapping = acctMappingById[node];

      const params = new URLSearchParams({
        level: 'account',
        fields: 'spend,impressions,clicks,date_start',
        time_increment: '1',
        date_preset: 'last_30d',
      });
      const url = `https://graph.facebook.com/${ver}/${node}/insights?${params}&access_token=${encodeURIComponent(acct.token)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) {
        tokenErrors.push({ label: acct.token_label, error: `${node}: ${j.error.message}` });
        continue;
      }

      accountsSynced++;

      for (const row of j.data || []) {
        const date = row.date_start;
        // Upsert: delete existing rows for this account + date, then insert fresh.
        const existing = await db.entities.AdSpend.filter({ ad_account_id: node, date });
        for (const e of existing) await db.entities.AdSpend.delete(e.id);
        await db.entities.AdSpend.create({
          platform: 'meta',
          mapping_id: mapping?.id || '',
          date,
          ad_account_id: node,
          meta_campaign_id: '',
          spend: Number(row.spend) || 0,
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          vertical: mapping?.vertical || '',
          brand: mapping?.brand || '',
          supplier_name: mapping?.supplier_name || '',
          cost_source: accountName,
        });
        inserted++;
      }

      if (mapping) usedMappingIds.add(mapping.id);
    }

    // Stamp last_synced_at on every mapping that was used.
    const now = new Date().toISOString();
    for (const id of usedMappingIds) {
      await db.entities.AdSpendMapping.update(id, { last_synced_at: now });
    }

    return {
      success: true,
      accounts_synced: accountsSynced,
      rows_synced: inserted,
      token_errors: tokenErrors,
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
