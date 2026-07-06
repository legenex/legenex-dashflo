// Verifies Xero credentials and pulls invoices/payments as reference data.
// Xero uses an OAuth2 access token (paste a token from the Xero developer app /
// custom connection). The token may arrive ad-hoc in body.access_token, else it
// is read from the stored IntegrationConfig(name='xero') or from
// config.integrations.xeroClientSecret (or XERO_CLIENT_SECRET / XERO_ACCESS_TOKEN
// env). Verify hits /connections to resolve the tenant, then reads invoices.
// Runs on demand and on schedule.
export default async function syncXero(ctx) {
  try {
    const db = ctx.db;

    let isScheduled = false;
    const user = ctx.user;
    if (!user) isScheduled = true;
    else if (user.role !== 'admin') return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};

    let token = body.access_token;
    let tenantId = body.tenant_id;
    let cfg = null;
    if (!token) {
      const cfgList = await db.entities.IntegrationConfig.filter({ name: 'xero' }).catch(() => []);
      cfg = cfgList[0] || null;
      let parsed = {};
      if (cfg) { try { parsed = JSON.parse(cfg.config || '{}'); } catch { parsed = {}; } }
      token = parsed.access_token || ctx.config.integrations.xeroClientSecret || ctx.env.XERO_CLIENT_SECRET || ctx.env.XERO_ACCESS_TOKEN;
      tenantId = tenantId || parsed.tenant_id;
    }
    if (!token) return ctx.json({ success: false, error: 'Xero not configured' }, 400);

    const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // Resolve tenant if not supplied.
    let tenantName = '';
    if (!tenantId) {
      const connRes = await fetch('https://api.xero.com/connections', { headers: authHeaders });
      if (!connRes.ok) {
        const t = await connRes.text();
        return ctx.json({ success: false, error: `Xero auth error ${connRes.status}: ${t.slice(0, 200)}` }, 400);
      }
      const conns = await connRes.json();
      if (!Array.isArray(conns) || conns.length === 0) {
        return ctx.json({ success: false, error: 'No Xero organisations found for this token' }, 400);
      }
      tenantId = conns[0].tenantId;
      tenantName = conns[0].tenantName || '';
    }

    if (body.verify_only) {
      return { success: true, tenant: { id: tenantId, name: tenantName } };
    }

    // Pull ACCPAY/ACCREC invoices as reference (light sync).
    const invHeaders = { ...authHeaders, 'Xero-tenant-id': tenantId };
    const invRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices?page=1', { headers: invHeaders });
    let invoiceCount = 0;
    if (invRes.ok) {
      const invJson = await invRes.json();
      invoiceCount = (invJson.Invoices || []).length;
    }

    if (cfg?.id) {
      let parsed = {};
      try { parsed = JSON.parse(cfg.config || '{}'); } catch { parsed = {}; }
      await db.entities.IntegrationConfig.update(cfg.id, { config: JSON.stringify({ ...parsed, tenant_id: tenantId, last_synced_at: new Date().toISOString() }) });
    }

    return { success: true, invoices: invoiceCount, tenant: tenantId, scheduled: isScheduled };
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}
