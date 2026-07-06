// Lists Meta (Facebook) Marketing assets using a stored long-lived access token.
// Returns businesses, ad accounts, pages and lead forms so the UI can map them.
export default async function metaAssets(ctx) {
  try {
    const user = ctx.user;
    if (!user || user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

    const token = ctx.config.integrations.metaAccessToken || ctx.env.META_ACCESS_TOKEN || '';
    if (!token) return { connected: false };

    const ver = 'v21.0';
    const g = async (path, params) => {
      const url = `https://graph.facebook.com/${ver}/${path}?${params}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.data || j;
    };

    // Verify token + fetch assets in parallel-ish (Graph doesn't batch here).
    const me = await g('me', 'fields=id,name');
    const businesses = await g('me/businesses', 'fields=id,name&limit=50').catch(() => []);
    const adAccounts = await g('me/adaccounts', 'fields=id,name,account_id,currency&limit=200').catch(() => []);
    const pages = await g('me/accounts', 'fields=id,name&limit=100').catch(() => []);

    // Lead forms per page (best-effort, first few pages).
    const leadForms = [];
    for (const p of (pages || []).slice(0, 10)) {
      const forms = await g(`${p.id}/leadgen_forms`, `fields=id,name,status&limit=50`).catch(() => []);
      for (const f of forms || []) leadForms.push({ ...f, page_id: p.id, page_name: p.name });
    }

    return {
      connected: true,
      account: me,
      businesses: businesses || [],
      ad_accounts: adAccounts || [],
      pages: pages || [],
      lead_forms: leadForms,
    };
  } catch (error) {
    return ctx.json({ connected: false, error: error.message }, 200);
  }
}
