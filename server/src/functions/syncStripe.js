// Verifies a Stripe secret key and pulls recent balance transactions as
// BankTransaction records (source='stripe'). Credential comes from an ad-hoc
// body.secret_key (verify-on-connect step), else config.integrations.stripeApiKey
// (or STRIPE_API_KEY env). Dedupes on external_id. Runs on demand and on schedule.
export default async function syncStripe(ctx) {
  try {
    const db = ctx.db;

    // Allow scheduled (no user) and admin-triggered runs.
    let isScheduled = false;
    const user = ctx.user;
    if (!user) isScheduled = true;
    else if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    // Allow an ad-hoc key in the body for the "verify on connect" step.
    const body = ctx.body || {};

    let token = body.secret_key;
    let cfg = null;
    if (!token) {
      const cfgList = await db.entities.IntegrationConfig.filter({ name: 'stripe' }).catch(() => []);
      cfg = cfgList[0] || null;
      token = ctx.config.integrations.stripeApiKey || ctx.env.STRIPE_API_KEY;
    }
    if (!token) return ctx.json({ success: false, error: 'Stripe not configured' }, 400);

    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // Verify the key against the Balance endpoint, which the recommended
    // restricted scopes (Balance + Charges read) actually cover. A restricted
    // key with no account scope 403s on /v1/account, so we don't require it.
    const balRes = await fetch('https://api.stripe.com/v1/balance', { headers });
    if (!balRes.ok) {
      const t = await balRes.text();
      return ctx.json({ success: false, error: `Stripe auth error ${balRes.status}: ${t.slice(0, 200)}` }, 400);
    }

    // Best-effort account fetch for display / stored account_id. Not required:
    // restricted keys may not have account read scope.
    let acct = {};
    try {
      const acctRes = await fetch('https://api.stripe.com/v1/account', { headers });
      if (acctRes.ok) acct = await acctRes.json();
    } catch { /* account scope optional */ }

    // If this was just a verify (body key, no stored config), return account info.
    if (body.verify_only) {
      return { success: true, account: { id: acct.id || null, business: acct.business_profile?.name || acct.settings?.dashboard?.display_name || '', country: acct.country || null } };
    }

    // Pull recent balance transactions and ingest as BankTransaction records.
    const existing = await db.entities.BankTransaction.filter({ source: 'stripe' }).catch(() => []);
    const seen = new Set(existing.map((t) => t.external_id).filter(Boolean));

    const txRes = await fetch('https://api.stripe.com/v1/balance_transactions?limit=100', { headers });
    const toCreate = [];
    if (txRes.ok) {
      const txJson = await txRes.json();
      for (const t of (txJson.data || [])) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        toCreate.push({
          source: 'stripe',
          external_id: String(t.id),
          date: new Date((t.created || 0) * 1000).toISOString().slice(0, 10),
          description: t.description || t.type || 'Stripe transaction',
          amount: (Number(t.net) || 0) / 100,
          category: (Number(t.net) || 0) >= 0 ? 'revenue' : '',
        });
      }
    }

    if (toCreate.length) await db.entities.BankTransaction.bulkCreate(toCreate);
    if (cfg?.id) {
      let parsed = {};
      try { parsed = JSON.parse(cfg.config || '{}'); } catch { parsed = {}; }
      await db.entities.IntegrationConfig.update(cfg.id, { config: JSON.stringify({ ...parsed, account_id: acct.id || parsed.account_id || null, last_synced_at: new Date().toISOString() }) });
    }

    return { success: true, ingested: toCreate.length, account: acct.id || null, scheduled: isScheduled };
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
