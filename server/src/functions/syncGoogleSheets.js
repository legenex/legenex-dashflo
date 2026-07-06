import crypto from 'node:crypto';
import { getFunction } from './index.js';

// Pull rows from a Google Sheet, map columns to our lead schema, de-dupe, and
// ingest each new row through the processLead pipeline (validation, dedup, CAPI,
// revenue all run there). Can be called from the Sync Now button or a schedule.
//
// Payload: { source_id } to sync one source, or {} to sync all enabled sheet sources.

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function base64urlFromBuffer(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mint a short-lived Google OAuth access token from a service account using a
// signed RS256 JWT assertion (no external SDK required).
async function getGoogleAccessToken(clientEmail, privateKey, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64urlFromBuffer(JSON.stringify(header))}.${base64urlFromBuffer(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64urlFromBuffer(signer.sign(privateKey));
  const assertion = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google auth failed: ${data.error_description || data.error || `HTTP ${resp.status}`}`);
  }
  return data.access_token;
}

// SHA-256 hex digest (used as a de-dupe marker when no dedupe column is set).
function sha256Hex(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

function parseJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { const p = JSON.parse(val); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

// Convert a 2D value grid (first row = headers) into an array of row objects.
function gridToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map(h => String(h || '').trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (row.every(c => c == null || String(c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] != null ? row[idx] : ''; });
    out.push(obj);
  }
  return out;
}

// Run a lead payload through the processLead pipeline. Mirrors the original
// service-role invoke: throws when processing could not run at all.
async function invokeProcessLead(ctx, leadPayload) {
  const fn = getFunction('processLead');
  if (!fn) throw new Error('processLead function is not available');
  const result = await fn({ ...ctx, body: leadPayload });
  if (result && result.__httpResponse && result.status >= 400) {
    throw new Error(result.body?.error || `processLead HTTP ${result.status}`);
  }
  return result;
}

async function syncOne(ctx, db, accessToken, source) {
  const mapping = parseJsonObject(source.mapping);
  const seen = new Set(parseJsonArray(source.seen_keys));
  const dedupeCol = source.dedupe_column || '';

  // Fetch the worksheet values via the Sheets API.
  const range = encodeURIComponent(source.worksheet || 'Sheet1');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${source.sheet_id}/values/${range}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Sheets API HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  const rows = gridToObjects(data.values || []);

  const supplierKey = source._supplier_key; // resolved by caller
  let ingested = 0;
  const newKeys = [];

  for (const row of rows) {
    // De-dupe marker: explicit column value, or a hash of the whole row.
    let marker = dedupeCol && row[dedupeCol] != null && String(row[dedupeCol]).trim() !== ''
      ? String(row[dedupeCol]).trim()
      : sha256Hex(JSON.stringify(row));
    if (seen.has(marker)) continue;

    // Map source columns -> our lead fields.
    const leadPayload = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (!field || field === '__ignore__') continue;
      if (row[col] !== undefined) leadPayload[field] = row[col];
    }
    // Attribution + source label.
    leadPayload.lead_source = source.name;
    leadPayload.source_channel = 'google_sheets';
    if (source.campaign_id) leadPayload.campaign_id = source.campaign_id;
    leadPayload._supplier_key = supplierKey;

    try {
      await invokeProcessLead(ctx, leadPayload);
      ingested++;
      seen.add(marker);
      newKeys.push(marker);
    } catch (err) {
      await db.entities.ErrorLog.create({
        stage: 'system', severity: 'warning',
        message: `Google Sheets ingest failed: ${source.name}`,
        detail: JSON.stringify({ error: err.message }),
        supplier_name: source.supplier_name || 'Unknown',
      }).catch(() => {});
    }
  }

  // Cap stored seen_keys to the most recent 5000 to bound field size.
  const merged = [...parseJsonArray(source.seen_keys), ...newKeys].slice(-5000);
  await db.entities.LeadSource.update(source.id, {
    seen_keys: JSON.stringify(merged),
    last_synced_at: new Date().toISOString(),
    last_sync_status: `Ingested ${ingested} of ${rows.length} rows`,
    ingested_count: (source.ingested_count || 0) + ingested,
  });

  return { source: source.name, rows: rows.length, ingested };
}

export default async function syncGoogleSheets(ctx) {
  try {
    const db = ctx.db;

    const clientEmail = ctx.config.integrations.googleClientEmail;
    const privateKey = ctx.config.integrations.googlePrivateKey;
    if (!clientEmail || !privateKey) {
      return ctx.json({ error: 'Google Sheets is not configured' }, 400);
    }

    const body = ctx.body || {};
    const sourceId = body.source_id || null;

    // Preview mode: fetch just the header row + first data row for mapping setup.
    if (body.preview) {
      const accessToken = await getGoogleAccessToken(clientEmail, privateKey, SHEETS_SCOPE);
      const range = encodeURIComponent(body.worksheet || 'Sheet1');
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${body.sheet_id}/values/${range}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) {
        const txt = await resp.text();
        return ctx.json({ error: `Sheets API HTTP ${resp.status}: ${txt.slice(0, 200)}` }, 400);
      }
      const data = await resp.json();
      const rows = gridToObjects(data.values || []);
      const columns = (data.values && data.values[0]) ? data.values[0].map(h => String(h || '').trim()).filter(Boolean) : [];
      return { columns, sample: rows[0] || {}, rowCount: rows.length };
    }

    let sources;
    if (sourceId) {
      sources = await db.entities.LeadSource.filter({ id: sourceId });
    } else {
      sources = await db.entities.LeadSource.filter({ kind: 'google_sheets', enabled: true });
    }
    sources = (sources || []).filter(s => s.kind === 'google_sheets');

    // Scheduled runs (every 15 min) respect each source's chosen interval:
    // only sync sources whose interval has elapsed since last_synced_at.
    if (body.scheduled) {
      const intervalMs = { '15m': 15 * 60000, '1h': 60 * 60000, '6h': 6 * 3600000, 'daily': 24 * 3600000 };
      const nowMs = Date.now();
      sources = sources.filter(s => {
        if (!s.enabled) return false;
        const due = intervalMs[s.sync_interval || '1h'] || 3600000;
        if (!s.last_synced_at) return true;
        return nowMs - new Date(s.last_synced_at).getTime() >= due - 30000; // 30s slack
      });
    }

    if (sources.length === 0) return { results: [], message: 'No Google Sheets sources to sync' };

    // One access token for all sources in this run.
    const accessToken = await getGoogleAccessToken(clientEmail, privateKey, SHEETS_SCOPE);

    const results = [];
    for (const source of sources) {
      if (!source.sheet_id) { results.push({ source: source.name, error: 'No sheet configured' }); continue; }
      // Resolve the supplier API key for ingestion.
      let supplierKey = null;
      if (source.api_key_id) {
        const keys = await db.entities.ApiKey.filter({ id: source.api_key_id });
        if (keys[0]) supplierKey = keys[0].key;
      }
      if (!supplierKey) { results.push({ source: source.name, error: 'No API key linked' }); continue; }
      try {
        source._supplier_key = supplierKey;
        results.push(await syncOne(ctx, db, accessToken, source));
      } catch (err) {
        await db.entities.LeadSource.update(source.id, {
          last_synced_at: new Date().toISOString(),
          last_sync_status: `Error: ${err.message}`.slice(0, 200),
        }).catch(() => {});
        results.push({ source: source.name, error: err.message });
      }
    }

    return { results };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
