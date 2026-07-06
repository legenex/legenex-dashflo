import { json } from './_runtime.js';
import { getFunction } from './index.js';

// Inbound call webhook for Ringba and TrueCall. Each call source has its own
// endpoint key (?key=...). Incoming call events are mapped from the call payload
// to our lead schema and ingested through processLead, so validation, dedup,
// CAPI and revenue all run there. Leads appear in the leads views with
// source = the call provider.
//
// URL: /api/functions/callWebhook?key=<webhook_key>
// The key identifies which LeadSource (and therefore provider + mapping +
// supplier/campaign attribution) this event belongs to.

function parseJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { const p = JSON.parse(val); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

// Read a value from the payload by dotted path (supports nested Ringba shapes).
function getPath(obj, path) {
  if (!path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

export default async function callWebhook(ctx) {
  try {
    const db = ctx.db;

    if (ctx.req.method === 'GET') return ctx.json({ status: 'ok' }, 200);
    if (ctx.req.method !== 'POST') return ctx.json({ error: 'Method not allowed' }, 405);

    const key = (ctx.req.query && ctx.req.query.key) || '';
    if (!key) return ctx.json({ error: 'Missing key' }, 401);

    const sources = await db.entities.LeadSource.filter({ webhook_key: key });
    const source = (sources || []).find(s => s.kind === 'ringba' || s.kind === 'truecall');
    if (!source) return ctx.json({ error: 'Invalid key' }, 401);
    if (!source.enabled) return ctx.json({ error: 'Source disabled' }, 403);

    // Body is already parsed (JSON or form-encoded) by the request layer.
    const payload = ctx.body || {};

    // Resolve the supplier API key for ingestion.
    let supplierKey = null;
    if (source.api_key_id) {
      const keys = await db.entities.ApiKey.filter({ id: source.api_key_id });
      if (keys[0]) supplierKey = keys[0].key;
    }
    if (!supplierKey) {
      await db.entities.LeadSource.update(source.id, {
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'Error: no API key linked',
      }).catch(() => {});
      return ctx.json({ error: 'Source not fully configured' }, 500);
    }

    // Map call payload -> our lead fields.
    const mapping = parseJsonObject(source.mapping);
    const leadPayload = {};
    for (const [srcKey, field] of Object.entries(mapping)) {
      if (!field || field === '__ignore__') continue;
      const val = getPath(payload, srcKey);
      if (val !== undefined) leadPayload[field] = val;
    }

    // Attribution + source label.
    leadPayload.lead_source = source.name;
    leadPayload.source_channel = source.kind;
    if (source.campaign_id) leadPayload.campaign_id = source.campaign_id;
    leadPayload._supplier_key = supplierKey;

    let ingestOk = true;
    let ingestResp = null;
    try {
      const processLead = getFunction('processLead');
      if (!processLead) throw new Error('processLead is not available');
      const subCtx = {
        body: leadPayload,
        user: null,
        db,
        env: ctx.env,
        config: ctx.config,
        req: ctx.req,
        json,
      };
      const raw = await processLead(subCtx);
      ingestResp = raw && raw.__httpResponse ? raw.body : (raw ?? null);
    } catch (err) {
      ingestOk = false;
      await db.entities.ErrorLog.create({
        stage: 'system', severity: 'warning',
        message: `${source.kind} call ingest failed: ${source.name}`,
        detail: JSON.stringify({ error: err.message }),
        supplier_name: source.supplier_name || 'Unknown',
      }).catch(() => {});
    }

    await db.entities.LeadSource.update(source.id, {
      last_synced_at: new Date().toISOString(),
      last_sync_status: ingestOk ? 'Ingested 1 call' : 'Error ingesting call',
      ingested_count: (source.ingested_count || 0) + (ingestOk ? 1 : 0),
    }).catch(() => {});

    return ctx.json({ ok: ingestOk, response: ingestResp }, 200);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
