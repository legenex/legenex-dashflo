// Syncs Meta ad spend for all enabled AdSpendMapping records and writes daily AdSpend rows.
// Feeds true CPL per supplier/source. Can be called manually from the UI or on a schedule.
// Scheduled automation runs with no user; manual calls carry a user and must be admin.
export default async function syncMetaSpend(ctx) {
  try {
    const db = ctx.db;
    // Manual calls carry a user; scheduled calls do not. Require admin when a user is present.
    const user = ctx.user;
    if (user && user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

    const token = ctx.config.integrations.metaAccessToken || ctx.env.META_ACCESS_TOKEN || '';
    if (!token) return ctx.json({ error: 'Meta not connected' }, 400);

    const ver = 'v21.0';
    const mappings = (await db.entities.AdSpendMapping.list()).filter((m) => m.platform === 'meta' && m.enabled);
    let inserted = 0;

    for (const m of mappings) {
      const level = m.match_level === 'ad_set' ? 'adset' : (m.match_level === 'campaign' ? 'campaign' : 'account');
      const node = m.match_level !== 'ad_account' && m.meta_campaign_id ? m.meta_campaign_id : m.ad_account_id;
      if (!node) continue;

      const params = new URLSearchParams({
        level,
        fields: 'spend,impressions,clicks,date_start',
        time_increment: '1',
        date_preset: 'last_7d',
      });
      const url = `https://graph.facebook.com/${ver}/${node}/insights?${params}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) continue;

      for (const row of j.data || []) {
        const date = row.date_start;
        // Upsert: delete same-day rows for this mapping then insert fresh.
        const existing = await db.entities.AdSpend.filter({ mapping_id: m.id, date });
        for (const e of existing) await db.entities.AdSpend.delete(e.id);
        await db.entities.AdSpend.create({
          platform: 'meta',
          mapping_id: m.id,
          date,
          ad_account_id: m.ad_account_id,
          meta_campaign_id: m.meta_campaign_id || '',
          spend: Number(row.spend) || 0,
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          vertical: m.vertical || '',
          brand: m.brand || '',
          supplier_name: m.supplier_name || '',
          cost_source: m.cost_source || '',
        });
        inserted++;
      }
      await db.entities.AdSpendMapping.update(m.id, { last_synced_at: new Date().toISOString() });
    }

    return { success: true, mappings: mappings.length, rows_synced: inserted };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
