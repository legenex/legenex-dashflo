// Lists Meta (Facebook) Marketing assets across every configured token.
// Tokens are saved in IntegrationConfig(name="meta") as config.tokens =
// [{ id, label, token }]. For backward compatibility a lone config.access_token
// (or system_user_token / master_token) is treated as one unlabeled token.
// A system-user token only reaches a single Business Manager, so multiple
// tokens let one account cover accounts spread across several Businesses.
// Returns combined accounts, pages and lead forms plus a per-token summary.
export default async function metaAssets(ctx) {
  const user = ctx.user;
  if (!user || user.role !== 'admin') return ctx.json({ error: 'Unauthorized' }, 401);

  try {
    const db = ctx.db;

    const cfgList = await db.entities.IntegrationConfig.filter({ name: 'meta' });
    const cfg = cfgList[0];
    if (!cfg) return ctx.json({ connected: false });

    // Resolve the list of tokens to iterate. Prefer config.tokens; otherwise
    // fall back to a single legacy token so existing setups keep working.
    let tokens = [];
    try {
      const parsed = JSON.parse(cfg.config || '{}');
      if (Array.isArray(parsed.tokens) && parsed.tokens.length) {
        tokens = parsed.tokens
          .filter((t) => t && t.token)
          .map((t, i) => ({ id: t.id || `token_${i}`, label: t.label || `Token ${i + 1}`, token: t.token }));
      } else {
        const legacy = parsed.system_user_token || parsed.master_token || parsed.access_token || '';
        if (legacy) tokens = [{ id: 'default', label: 'Default', token: legacy }];
      }
    } catch { tokens = []; }
    if (!tokens.length) return ctx.json({ connected: false });

    const ver = 'v21.0';
    const g = async (token, path, params) => {
      const url = `https://graph.facebook.com/${ver}/${path}?${params}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.data || j;
    };

    const accountsById = {};
    const pagesById = {};
    const leadForms = [];
    const tokenSummaries = [];
    let firstAccount = null;

    for (const t of tokens) {
      const summary = { id: t.id, label: t.label, valid: false, accounts: 0, error: '' };
      try {
        const me = await g(t.token, 'me', 'fields=id,name');
        summary.valid = true;
        if (!firstAccount) firstAccount = me;

        const adAccounts = await g(t.token, 'me/adaccounts', 'fields=id,name,account_id,currency&limit=200').catch(() => []);
        let reached = 0;
        for (const a of adAccounts || []) {
          reached++;
          if (!accountsById[a.id]) accountsById[a.id] = { ...a, token_id: t.id, token_label: t.label };
        }
        summary.accounts = reached;

        const pages = await g(t.token, 'me/accounts', 'fields=id,name&limit=100').catch(() => []);
        const newPages = [];
        for (const p of pages || []) {
          if (!pagesById[p.id]) { pagesById[p.id] = { ...p, token_id: t.id }; newPages.push(p); }
        }
        // Lead forms per newly seen page (best-effort, first few pages).
        for (const p of newPages.slice(0, 10)) {
          const forms = await g(t.token, `${p.id}/leadgen_forms`, `fields=id,name,status&limit=50`).catch(() => []);
          for (const f of forms || []) leadForms.push({ ...f, page_id: p.id, page_name: p.name });
        }
      } catch (e) {
        summary.error = e.message;
      }
      tokenSummaries.push(summary);
    }

    return ctx.json({
      connected: true,
      account: firstAccount,
      ad_accounts: Object.values(accountsById),
      pages: Object.values(pagesById),
      lead_forms: leadForms,
      tokens: tokenSummaries,
    });
  } catch (error) {
    return ctx.json({ connected: false, error: error.message }, 200);
  }
}
