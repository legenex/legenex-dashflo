// Pulls transactions from the Mercury bank API and ingests them as BankTransaction records.
// Credential comes from config.integrations.mercuryApiKey (or MERCURY_API_KEY env).
// Optional IntegrationConfig(name='mercury') stores { account_id?, last_synced_at }.
// Dedupes on external_id (Mercury transaction id). Runs on demand and on schedule.
export default async function syncMercury(ctx) {
  try {
    const db = ctx.db;

    // Allow scheduled (no user) and admin-triggered runs.
    let isScheduled = false;
    const user = ctx.user;
    if (!user) isScheduled = true;
    else if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    const token = ctx.config.integrations.mercuryApiKey || ctx.env.MERCURY_API_KEY;
    if (!token) return ctx.json({ success: false, error: 'Mercury not configured' }, 400);

    // Optional stored config for account preference + last-synced tracking.
    const cfgList = await db.entities.IntegrationConfig.filter({ name: 'mercury' }).catch(() => []);
    const cfg = cfgList[0] || null;
    let parsed = {};
    if (cfg) { try { parsed = JSON.parse(cfg.config || '{}'); } catch { parsed = {}; } }

    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // Always resolve real accounts from the API. The configured account_id may
    // be an actual id OR a human-typed name/nickname (as entered in the UI), so
    // match it against id/name/nickname and fall back to all accounts.
    const accRes = await fetch('https://api.mercury.com/api/v1/accounts', { headers });
    if (!accRes.ok) {
      const t = await accRes.text();
      return ctx.json({ success: false, error: `Mercury accounts error ${accRes.status}: ${t.slice(0, 200)}` }, 400);
    }
    const accJson = await accRes.json();
    const allAccounts = (accJson.accounts || accJson || []).filter((a) => a && a.id);

    let accountIds = [];
    const want = (parsed.account_id || '').trim();
    if (want) {
      const match = allAccounts.filter((a) =>
        a.id === want ||
        (a.name && a.name.toLowerCase() === want.toLowerCase()) ||
        (a.nickname && a.nickname.toLowerCase() === want.toLowerCase())
      );
      accountIds = (match.length ? match : allAccounts).map((a) => a.id);
    } else {
      accountIds = allAccounts.map((a) => a.id);
    }

    // Existing external_ids for dedupe.
    const existing = await db.entities.BankTransaction.filter({ source: 'mercury' }).catch(() => []);
    const seen = new Set(existing.map((t) => t.external_id).filter(Boolean));

    const toCreate = [];
    const errors = [];
    for (const accId of accountIds) {
      const txRes = await fetch(`https://api.mercury.com/api/v1/account/${accId}/transactions?limit=500`, { headers });
      if (!txRes.ok) {
        const t = await txRes.text();
        errors.push(`account ${accId}: ${txRes.status} ${t.slice(0, 120)}`);
        continue;
      }
      const txJson = await txRes.json();
      const list = txJson.transactions || txJson || [];
      for (const t of list) {
        const extId = t.id || t.transactionId;
        if (!extId || seen.has(extId)) continue;
        seen.add(extId);
        const amount = Number(t.amount) || 0;
        toCreate.push({
          source: 'mercury',
          external_id: String(extId),
          date: String(t.postedAt || t.createdAt || '').slice(0, 10),
          description: t.bankDescription || t.counterpartyName || t.note || '',
          amount,
        });
      }
    }

    if (toCreate.length) await db.entities.BankTransaction.bulkCreate(toCreate);
    if (cfg?.id) await db.entities.IntegrationConfig.update(cfg.id, { config: JSON.stringify({ ...parsed, last_synced_at: new Date().toISOString() }) });

    if (toCreate.length === 0 && errors.length) {
      return ctx.json({ success: false, error: errors.join('; '), accounts: accountIds.length }, 400);
    }
    return { success: true, ingested: toCreate.length, accounts: accountIds.length, errors, scheduled: isScheduled };
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
