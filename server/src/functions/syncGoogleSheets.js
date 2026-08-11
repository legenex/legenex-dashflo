import processLead from './processLead.js';

// Google Sheets data source sync.
//
// A sheet has a purpose that decides where its rows are written:
//   leads          rows are ingested through processLead (the original behaviour,
//                  and what an absent purpose still means)
//   buyer_feedback rows are matched to a lead and written as BuyerFeedback
//   inbound_calls  rows are either ingested as leads or recorded against a lead,
//                  depending on purpose_config.create_leads
//   disqualified   rows are matched to a lead and recorded as a DQ outcome
//   cost           rows are written as AdSpend against a supplier
//
// Modes:
//   { account_status: true }                connected Google account and whether
//                                           Drive listing is authorised
//   { list_spreadsheets: true }             list sheets from Drive (needs Drive scope)
//   { list_worksheets: true, sheet_id }     list tab names in a spreadsheet
//   { preview: true, sheet_id, worksheet }  columns, a sample row and a row count
//   { source_id }                           sync one source
//   { source_id, dry_run: true }            report what would be written, write nothing
//   { scheduled: true }                     sync every source whose interval has elapsed
//   {}                                      sync every enabled sheet source

const ROW_BUDGET = 300; // new rows processed per run, so one big sheet cannot stall the queue

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

// URL-safe base64 without padding, for the JWT segments and signature.
function base64UrlFromString(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const normalized = String(pem).replace(/\\n/g, '\n');
  const body = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// Mint a Google OAuth access token for the given scope from the service account
// credentials. Returns null when no credentials are configured, so callers can
// degrade gracefully rather than crashing.
async function getServiceAccountToken(ctx, scope) {
  const integ = (ctx.config && ctx.config.integrations) || {};
  const clientEmail = integ.googleClientEmail || (ctx.env && ctx.env.GOOGLE_CLIENT_EMAIL);
  const rawKey = integ.googlePrivateKey || (ctx.env && ctx.env.GOOGLE_PRIVATE_KEY);
  if (!clientEmail || !rawKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const encHeader = base64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encClaims = base64UrlFromString(JSON.stringify({
    iss: clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${encHeader}.${encClaims}`;

  let jwt;
  try {
    const key = await importPrivateKey(rawKey);
    const sigBuf = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new TextEncoder().encode(signingInput),
    );
    jwt = `${signingInput}.${base64UrlFromBytes(new Uint8Array(sigBuf))}`;
  } catch {
    return null;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token || null;
}

async function googleToken(ctx) {
  return getServiceAccountToken(ctx, SHEETS_SCOPE);
}

// Listing files is a Drive call, not a Sheets one, and needs a Drive scope on
// the service account. The token is minted with the Drive scope; `via` records
// how the listing was authorised so a broken connection is visible in the panel.
async function driveToken(ctx) {
  const token = await getServiceAccountToken(ctx, DRIVE_SCOPE);
  return { token, via: 'service_account' };
}

// Convert a 2D value grid (first row = headers) into an array of row objects.
function gridToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map((h) => String(h || '').trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (row.every((c) => c == null || String(c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] != null ? row[idx] : ''; });
    out.push(obj);
  }
  return out;
}

async function fetchValues(token, sheetId, worksheet) {
  const range = encodeURIComponent(worksheet || 'Sheet1');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Sheets API HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return await resp.json();
}

// Number-like text from a sheet cell. Strips currency symbols, commas and spaces.
function toNumber(val) {
  if (val == null || val === '') return null;
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Sheet dates arrive as text in many shapes. Return an ISO date (YYYY-MM-DD) or null.
function toIsoDate(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (us) return `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function digitsOnly(val) {
  return String(val || '').replace(/\D/g, '');
}

// Find the lead a row belongs to. Returns { lead, matched_by } or nulls.
async function matchLead(db, field, rawValue) {
  const value = String(rawValue == null ? '' : rawValue).trim();
  if (!value) return { lead: null, matched_by: null };

  if (field === 'id') {
    const hit = await db.entities.Lead.filter({ id: value });
    return { lead: hit?.[0] || null, matched_by: hit?.[0] ? 'id' : null };
  }
  if (field === 'lead_id') {
    const hit = await db.entities.Lead.filter({ lead_id: value });
    return { lead: hit?.[0] || null, matched_by: hit?.[0] ? 'lead_id' : null };
  }
  if (field === 'email') {
    const hit = await db.entities.Lead.filter({ email: value.toLowerCase() });
    if (hit?.[0]) return { lead: hit[0], matched_by: 'email' };
    const exact = await db.entities.Lead.filter({ email: value });
    return { lead: exact?.[0] || null, matched_by: exact?.[0] ? 'email' : null };
  }
  if (field === 'mobile') {
    const exact = await db.entities.Lead.filter({ mobile: value });
    if (exact?.[0]) return { lead: exact[0], matched_by: 'mobile' };
    const digits = digitsOnly(value);
    if (digits) {
      const byDigits = await db.entities.Lead.filter({ mobile: digits });
      if (byDigits?.[0]) return { lead: byDigits[0], matched_by: 'mobile' };
      const last10 = digits.slice(-10);
      if (last10 && last10 !== digits) {
        const byLast10 = await db.entities.Lead.filter({ mobile: last10 });
        if (byLast10?.[0]) return { lead: byLast10[0], matched_by: 'mobile' };
      }
    }
    return { lead: null, matched_by: null };
  }
  return { lead: null, matched_by: null };
}

// Read a row's value for one of our field names, using the column mapping.
function mappedValue(row, mapping, field) {
  for (const [col, target] of Object.entries(mapping)) {
    if (target === field && row[col] !== undefined) return row[col];
  }
  return undefined;
}

function truthy(val) {
  const s = String(val == null ? '' : val).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y' || s === 'converted' || s === 'returned';
}

// A conversion is defined per sheet, because every buyer words it differently:
// Walker calls it Qualified Flag = Yes, another posts Converted = Yes, a third
// writes Buyer_feedback = Converted. A rule is a column plus the values in it
// that count. With no values listed it falls back to the usual yes/true/1 set.
function ruleMatches(row, column, values) {
  if (!column) return false;
  const raw = row[column];
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const list = Array.isArray(values) ? values : parseJsonArray(values);
  if (!list.length) return truthy(raw);
  const s = String(raw).trim().toLowerCase();
  return list.some((v) => String(v).trim().toLowerCase() === s);
}

// The conversion value a row carries: either a column on the sheet or a flat
// amount that applies to every converting row. Returns null when the row should
// not move any money field.
function conversionValue(row, cfg, converted) {
  if (cfg.conversion_value_only_when_converted === true && !converted) return null;
  if (cfg.conversion_value_mode === 'fixed') {
    const fixed = toNumber(cfg.conversion_value_fixed);
    return fixed == null ? null : fixed;
  }
  if (cfg.conversion_value_mode === 'none') return null;
  return cfg.revenue_column ? toNumber(row[cfg.revenue_column]) : null;
}

// Which lead field the conversion value lands on. revenue is what the lead sold
// for; conv_value is what the buyer reported it was worth to them.
function conversionField(cfg) {
  return cfg.conversion_value_field === 'conv_value' ? 'conv_value' : 'revenue';
}

// Columns the operator mapped by hand, or that the AI configured, which have no
// dedicated column on Lead. They merge into mapped_fields, the same JSON bag the
// inbound webhook writes custom values into, rather than inventing new columns.
function applyCustomFields(lead, row, cfg, patch) {
  const customMap = parseJsonObject(cfg.custom_map);
  const entries = Object.entries(customMap).filter(([col, field]) => col && field);
  if (!entries.length) return;
  let bag = {};
  try { bag = JSON.parse(lead.mapped_fields || '{}') || {}; } catch { bag = {}; }
  let changed = false;
  for (const [col, field] of entries) {
    if (row[col] === undefined || row[col] === '') continue;
    if (bag[field] !== row[col]) { bag[field] = row[col]; changed = true; }
  }
  if (changed) patch.mapped_fields = JSON.stringify(bag);
}

// ---------------------------------------------------------------------------
// Per-purpose row writers. Each returns 'written', 'skipped' or throws.
// ---------------------------------------------------------------------------

async function writeLeadRow(db, ctx, source, row, mapping, dryRun) {
  const leadPayload = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (!field || field === '__ignore__') continue;
    if (row[col] !== undefined) leadPayload[field] = row[col];
  }
  leadPayload.lead_source = source.name;
  leadPayload.source_channel = 'google_sheets';
  if (source.campaign_id) leadPayload.campaign_id = source.campaign_id;
  leadPayload._supplier_key = source._supplier_key;
  if (dryRun) return 'written';
  await processLead({ ...ctx, body: leadPayload });
  return 'written';
}

async function writeFeedbackRow(db, source, row, mapping, cfg, dryRun) {
  const matchValue = source.match_column ? row[source.match_column] : undefined;
  const { lead, matched_by } = await matchLead(db, source.match_field || 'email', matchValue);
  if (!lead) return 'skipped';

  const disposition = String(
    mappedValue(row, mapping, 'disposition') ?? (cfg.disposition_column ? row[cfg.disposition_column] : '') ?? '',
  ).trim();
  if (!disposition) return 'skipped';

  const converted = ruleMatches(row, cfg.converted_column, cfg.converted_values)
    || truthy(mappedValue(row, mapping, 'buyer_conversion'));
  const returned = ruleMatches(row, cfg.returned_column, cfg.returned_values)
    || truthy(mappedValue(row, mapping, 'buyer_returned'));
  const convValue = conversionValue(row, cfg, converted);
  const buyerCode = source.buyer_code || lead.buyer_id || '';

  if (dryRun) return 'written';

  await db.entities.BuyerFeedback.create({
    lead_id: lead.id,
    buyer_id: buyerCode,
    matched_by: matched_by || 'unknown',
    disposition: disposition.slice(0, 120),
    raw_disposition: disposition,
    outcome: converted ? 'converted' : returned ? 'returned' : 'contacted',
    revenue_value: convValue == null ? undefined : convValue,
    notes: cfg.notes_column ? String(row[cfg.notes_column] || '').slice(0, 500) : undefined,
    source: `sheet:${source.name}`,
    match_confidence: matched_by === 'email' || matched_by === 'lead_id' || matched_by === 'id' ? 'high' : 'medium',
  });

  // Only fields that carry the buyer's own verdict are written back onto the lead.
  const leadPatch = {};
  if (disposition) leadPatch.buyer_feedback = disposition.slice(0, 200);
  if (converted) leadPatch.buyer_conversion = true;
  if (returned) leadPatch.buyer_returned = true;
  if (returned && cfg.return_reason_column) leadPatch.buyer_return_reason = String(row[cfg.return_reason_column] || '').slice(0, 300);
  if (convValue != null) leadPatch[conversionField(cfg)] = convValue;
  applyCustomFields(lead, row, cfg, leadPatch);
  if (Object.keys(leadPatch).length) await db.entities.Lead.update(lead.id, leadPatch);

  return 'written';
}

async function writeDisqualifiedRow(db, source, row, mapping, cfg, dryRun) {
  const matchValue = source.match_column ? row[source.match_column] : undefined;
  const { lead, matched_by } = await matchLead(db, source.match_field || 'email', matchValue);
  if (!lead) return 'skipped';

  const reason = String(
    mappedValue(row, mapping, 'disposition') ?? (cfg.reason_column ? row[cfg.reason_column] : '') ?? '',
  ).trim() || 'Disqualified';

  if (dryRun) return 'written';

  await db.entities.BuyerFeedback.create({
    lead_id: lead.id,
    buyer_id: source.buyer_code || lead.buyer_id || '',
    matched_by: matched_by || 'unknown',
    disposition: reason.slice(0, 120),
    raw_disposition: reason,
    outcome: 'disqualified',
    source: `sheet:${source.name}`,
    match_confidence: matched_by === 'email' || matched_by === 'lead_id' || matched_by === 'id' ? 'high' : 'medium',
  });

  // final_status is the lead's own lifecycle. It is only rewritten when the
  // operator has explicitly asked this sheet to do so.
  const patch = { buyer_feedback: reason.slice(0, 200) };
  if (cfg.set_status === true) patch.final_status = 'Disqualified';
  applyCustomFields(lead, row, cfg, patch);
  await db.entities.Lead.update(lead.id, patch);
  return 'written';
}

async function writeCallRow(db, ctx, source, row, mapping, cfg, dryRun) {
  // A call sheet may simply be a lead feed wearing a different hat.
  if (cfg.create_leads === true) return await writeLeadRow(db, ctx, source, row, mapping, dryRun);

  const rawMobile = cfg.mobile_column ? row[cfg.mobile_column]
    : (source.match_column ? row[source.match_column] : undefined);
  const mobile = digitsOnly(rawMobile);
  const callId = cfg.call_id_column ? String(row[cfg.call_id_column] || '').trim() : '';
  if (!mobile && !callId) return 'skipped';

  const qualifiedRaw = cfg.converted_column ? String(row[cfg.converted_column] ?? '') : '';
  const qualified = ruleMatches(row, cfg.converted_column, cfg.converted_values);
  const revenue = cfg.revenue_column ? toNumber(row[cfg.revenue_column]) : null;
  const callAt = source.date_column ? toIsoDate(row[source.date_column]) : null;

  // The buyer: one selected buyer pins every row, several means read it per row.
  const buyerCodes = parseJsonArray(source.buyer_codes);
  let buyerCode = source.buyer_code || '';
  if (!buyerCode && buyerCodes.length === 1) buyerCode = buyerCodes[0];
  else if (cfg.buyer_column && row[cfg.buyer_column]) {
    const cell = String(row[cfg.buyer_column]).trim();
    const hit = buyerCodes.find((c) => String(c).toLowerCase() === cell.toLowerCase());
    buyerCode = hit || cell;
  }

  // Attribution: the number is the join key. A known lead gives us the supplier
  // straight away; otherwise a Ringba style feed fills sid and ssid later.
  let leadRef = null;
  if (mobile) {
    const found = await matchLead(db, 'mobile', mobile);
    leadRef = found.lead;
  }

  if (dryRun) return 'written';

  const custom = {};
  for (const [col, field] of Object.entries(parseJsonObject(cfg.custom_map))) {
    if (col && field && row[col] !== undefined && row[col] !== '') custom[field] = row[col];
  }

  const record = {
    call_id: callId || undefined,
    source_id: source.id,
    source_name: source.name,
    call_at: callAt ? new Date(`${callAt}T00:00:00Z`).toISOString() : undefined,
    mobile: mobile || undefined,
    mobile_raw: rawMobile == null ? undefined : String(rawMobile),
    caller_id: cfg.caller_id_column ? String(row[cfg.caller_id_column] || '') : undefined,
    duration_seconds: cfg.duration_column ? (toNumber(row[cfg.duration_column]) ?? 0) : undefined,
    inquiry_status: cfg.status_column ? String(row[cfg.status_column] || '') : undefined,
    qualified,
    qualified_raw: qualifiedRaw || undefined,
    revenue: revenue == null ? 0 : revenue,
    buyer_code: buyerCode || undefined,
    supplier_name: leadRef?.supplier_name || undefined,
    lead_id: leadRef?.id || undefined,
    attribution_status: leadRef ? 'matched_lead' : 'unattributed',
    first_name: cfg.first_name_column ? String(row[cfg.first_name_column] || '') : undefined,
    last_name: cfg.last_name_column ? String(row[cfg.last_name_column] || '') : undefined,
    state: cfg.state_column ? String(row[cfg.state_column] || '') : undefined,
    vertical: cfg.vertical_column ? String(row[cfg.vertical_column] || '') : undefined,
    vertical_detail: cfg.vertical_detail_column ? String(row[cfg.vertical_detail_column] || '') : undefined,
    custom_fields: Object.keys(custom).length ? JSON.stringify(custom) : undefined,
  };

  // Upsert on the platform's own call id when there is one, so a sheet that is
  // re-read with updated commission updates the call rather than duplicating it.
  let existing = null;
  if (callId) existing = (await db.entities.CallRecord.filter({ call_id: callId }))?.[0] || null;
  if (existing) await db.entities.CallRecord.update(existing.id, record);
  else await db.entities.CallRecord.create(record);

  return 'written';
}

// A Ringba style feed carries the numbers alongside sid and ssid. It creates no
// calls of its own: it finds the call already recorded against that number and
// fills in who sent it.
async function writeCallAttributionRow(db, source, row, cfg, dryRun) {
  const rawMobile = cfg.mobile_column ? row[cfg.mobile_column]
    : (source.match_column ? row[source.match_column] : undefined);
  const mobile = digitsOnly(rawMobile);
  if (!mobile) return 'skipped';

  const sid = cfg.sid_column ? String(row[cfg.sid_column] || '').trim() : '';
  const ssid = cfg.ssid_column ? String(row[cfg.ssid_column] || '').trim() : '';
  if (!sid && !ssid) return 'skipped';

  const calls = await db.entities.CallRecord.filter({ mobile });
  const target = (Array.isArray(calls) ? calls : [])[0];
  if (!target) return 'skipped';

  if (dryRun) return 'written';

  // A sid is a supplier code, so resolve it to the supplier's real name the same
  // way the inbound webhook does rather than storing a raw code as a name.
  let supplierName = target.supplier_name || '';
  if (sid && !supplierName) {
    const sups = await db.entities.Supplier.list();
    const n = (v) => String(v ?? '').trim().toLowerCase();
    const s = n(sid);
    const hit = (Array.isArray(sups) ? sups : []).find((x) => {
      const name = n(x.name);
      const xsid = n(x.sid);
      if (xsid && s && xsid === s) return true;
      return name && s && (name === s || s.startsWith(name) || name.startsWith(s));
    });
    supplierName = hit?.name || sid;
  }

  await db.entities.CallRecord.update(target.id, {
    sid: sid || target.sid || undefined,
    ssid: ssid || target.ssid || undefined,
    supplier_name: supplierName || undefined,
    attribution_status: 'matched_feed',
  });
  return 'written';
}

async function writeCostRow(db, source, row, cfg, dryRun) {
  const date = toIsoDate(source.date_column ? row[source.date_column] : null);
  const spend = toNumber(cfg.spend_column ? row[cfg.spend_column] : null);
  if (!date || spend == null) return 'skipped';

  if (dryRun) return 'written';

  const supplierName = source.supplier_name || '';
  await db.entities.AdSpend.create({
    date,
    spend,
    platform: 'sheet',
    level: 'account',
    cost_source: `sheet:${source.name}`,
    supplier_name: supplierName || undefined,
    supplier_key: supplierName ? supplierName.trim().toLowerCase() : undefined,
    vertical: cfg.vertical || undefined,
    currency: cfg.currency || 'USD',
    leads: toNumber(cfg.leads_column ? row[cfg.leads_column] : null) ?? 0,
    clicks: toNumber(cfg.clicks_column ? row[cfg.clicks_column] : null) ?? 0,
    impressions: toNumber(cfg.impressions_column ? row[cfg.impressions_column] : null) ?? 0,
  });
  return 'written';
}

// ---------------------------------------------------------------------------

async function syncOne(db, ctx, source, dryRun) {
  const purpose = source.purpose || 'leads';
  const mapping = parseJsonObject(source.mapping);
  const cfg = parseJsonObject(source.purpose_config);
  const included = parseJsonArray(source.included_columns);
  const seen = new Set(parseJsonArray(source.seen_keys));
  const dedupeCol = source.dedupe_column || '';

  const token = await googleToken(ctx);
  if (!token) throw new Error('Google Sheets is not configured');
  const data = await fetchValues(token, source.sheet_id, source.worksheet);
  let rows = gridToObjects(data.values || []);

  // Column include list, when set, is applied before anything reads the row.
  if (included.length) {
    rows = rows.map((r) => {
      const trimmed = {};
      for (const col of included) if (r[col] !== undefined) trimmed[col] = r[col];
      return trimmed;
    });
  }

  const counts = { read: rows.length, written: 0, skipped: 0, errored: 0, remaining: 0 };
  const newKeys = [];
  let budget = ROW_BUDGET;

  for (const row of rows) {
    const marker = dedupeCol && row[dedupeCol] != null && String(row[dedupeCol]).trim() !== ''
      ? String(row[dedupeCol]).trim()
      : await sha256Hex(JSON.stringify(row));
    if (seen.has(marker)) continue;

    if (budget <= 0) { counts.remaining++; continue; }
    budget--;

    try {
      let result;
      if (purpose === 'buyer_feedback') result = await writeFeedbackRow(db, source, row, mapping, cfg, dryRun);
      else if (purpose === 'disqualified') result = await writeDisqualifiedRow(db, source, row, mapping, cfg, dryRun);
      else if (purpose === 'inbound_calls') result = await writeCallRow(db, ctx, source, row, mapping, cfg, dryRun);
      else if (purpose === 'call_attribution') result = await writeCallAttributionRow(db, source, row, cfg, dryRun);
      else if (purpose === 'cost') result = await writeCostRow(db, source, row, cfg, dryRun);
      else result = await writeLeadRow(db, ctx, source, row, mapping, dryRun);

      if (result === 'written') {
        counts.written++;
        // A skipped row is left unmarked so a later run can pick it up once the
        // lead it refers to exists.
        seen.add(marker);
        newKeys.push(marker);
      } else {
        counts.skipped++;
      }
    } catch (err) {
      counts.errored++;
      if (!dryRun) {
        await db.entities.ErrorLog.create({
          stage: 'system',
          severity: 'warning',
          message: `Sheet sync failed: ${source.name} (${purpose})`,
          detail: JSON.stringify({ error: err.message }),
          supplier_name: source.supplier_name || 'Unknown',
        }).catch(() => {});
      }
    }
  }

  if (dryRun) {
    return { source: source.name, purpose, dry_run: true, ...counts };
  }

  const merged = [...parseJsonArray(source.seen_keys), ...newKeys].slice(-5000);
  await db.entities.LeadSource.update(source.id, {
    seen_keys: JSON.stringify(merged),
    last_synced_at: new Date().toISOString(),
    last_sync_status: `${counts.written} written, ${counts.skipped} skipped of ${counts.read} rows`,
    last_run_counts: JSON.stringify(counts),
    ingested_count: (source.ingested_count || 0) + counts.written,
  });

  return { source: source.name, purpose, rows: counts.read, ingested: counts.written, ...counts };
}

export default async function syncGoogleSheets(ctx) {
  try {
    const db = ctx.db;
    const body = ctx.body || {};

    // Who the connected Google account is, and whether Drive listing works.
    // The panel shows this beside the sheets so a broken connection is visible
    // where it matters, not buried in the Integrations tab.
    if (body.account_status) {
      const integ = (ctx.config && ctx.config.integrations) || {};
      const account = integ.googleClientEmail || (ctx.env && ctx.env.GOOGLE_CLIENT_EMAIL) || null;
      const token = await googleToken(ctx);
      const connected = !!token;
      if (!connected) {
        return ctx.json({ connected: false, account, can_list: false, error: 'Google Sheets is not configured' });
      }
      let canList = false;
      let listVia = null;
      try {
        const { token: dtoken, via } = await driveToken(ctx);
        if (dtoken) {
          const probe = await fetch(
            'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)'
            + '&q=' + encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"),
            { headers: { Authorization: `Bearer ${dtoken}` } },
          );
          canList = probe.ok;
          if (probe.ok) listVia = via;
        }
      } catch { canList = false; }
      return ctx.json({ connected, account, can_list: canList, list_via: listVia });
    }

    // List the spreadsheets in the connected Drive so the operator picks from a
    // dropdown instead of pasting a URL. Needs a Drive scope on the service
    // account; without it the caller falls back to pasting a link.
    if (body.list_spreadsheets) {
      const { token, via } = await driveToken(ctx);
      if (!token) {
        return ctx.json({ files: [], via, scope_missing: true, error: 'Google is not configured' });
      }
      const search = String(body.search || '').trim().replace(/'/g, "\\'");
      const q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
        + (search ? ` and name contains '${search}'` : '');
      const url = 'https://www.googleapis.com/drive/v3/files'
        + '?q=' + encodeURIComponent(q)
        + '&fields=' + encodeURIComponent('files(id,name,modifiedTime,owners(emailAddress))')
        + '&orderBy=' + encodeURIComponent('modifiedTime desc')
        + '&pageSize=200'
        // Sheets living in a shared drive are still the operator's sheets.
        + '&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        const txt = await resp.text();
        return ctx.json({
          files: [],
          via,
          scope_missing: resp.status === 403 || resp.status === 401,
          error: `Drive API HTTP ${resp.status}: ${txt.slice(0, 200)}`,
        });
      }
      const data = await resp.json();
      return ctx.json({ files: data.files || [], via });
    }

    // Tab names for a chosen spreadsheet.
    if (body.list_worksheets) {
      const token = await googleToken(ctx);
      if (!token) return ctx.json({ error: 'Google Sheets is not configured' }, 400);
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${body.sheet_id}?fields=properties.title,sheets.properties.title`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        const txt = await resp.text();
        return ctx.json({ error: `Sheets API HTTP ${resp.status}: ${txt.slice(0, 200)}` }, 400);
      }
      const data = await resp.json();
      return ctx.json({
        title: data?.properties?.title || '',
        worksheets: (data?.sheets || []).map((s) => s?.properties?.title).filter(Boolean),
      });
    }

    // Header row, a sample row and a row count, for mapping setup.
    if (body.preview) {
      const token = await googleToken(ctx);
      if (!token) return ctx.json({ error: 'Google Sheets is not configured' }, 400);
      let data;
      try {
        data = await fetchValues(token, body.sheet_id, body.worksheet);
      } catch (err) {
        return ctx.json({ error: err.message }, 400);
      }
      const rows = gridToObjects(data.values || []);
      const columns = (data.values && data.values[0])
        ? data.values[0].map((h) => String(h || '').trim()).filter(Boolean)
        : [];
      return ctx.json({ columns, sample: rows[0] || {}, samples: rows.slice(0, 3), rowCount: rows.length });
    }

    const sourceId = body.source_id || null;
    const dryRun = body.dry_run === true;

    let sources;
    if (sourceId) sources = await db.entities.LeadSource.filter({ id: sourceId });
    else sources = await db.entities.LeadSource.filter({ kind: 'google_sheets', enabled: true });
    sources = (sources || []).filter((s) => s.kind === 'google_sheets');

    // Scheduled runs respect each source's chosen interval.
    if (body.scheduled) {
      const intervalMs = { '1m': 0, '15m': 15 * 60000, '1h': 60 * 60000, '6h': 6 * 3600000, daily: 24 * 3600000 };
      const nowMs = Date.now();
      sources = sources.filter((s) => {
        if (!s.enabled) return false;
        // Continuous sheets run on every tick of the scheduler.
        if ((s.sync_interval || '1m') === '1m') return true;
        const due = intervalMs[s.sync_interval] || 3600000;
        if (!s.last_synced_at) return true;
        return nowMs - new Date(s.last_synced_at).getTime() >= due - 30000; // 30s slack
      });
    }

    if (sources.length === 0) return ctx.json({ results: [], message: 'No Google Sheets sources to sync' });

    const results = [];
    for (const source of sources) {
      if (!source.sheet_id) { results.push({ source: source.name, error: 'No sheet configured' }); continue; }

      // Only a lead-bearing sheet needs an ingestion key, because only it
      // reaches processLead. The other purposes write records directly.
      const purpose = source.purpose || 'leads';
      const needsKey = purpose === 'leads'
        || (purpose === 'inbound_calls' && parseJsonObject(source.purpose_config).create_leads === true);
      if (needsKey) {
        let supplierKey = null;
        if (source.api_key_id) {
          const keys = await db.entities.ApiKey.filter({ id: source.api_key_id });
          if (keys[0]) supplierKey = keys[0].key;
        }
        if (!supplierKey) { results.push({ source: source.name, error: 'No API key linked' }); continue; }
        source._supplier_key = supplierKey;
      }

      try {
        results.push(await syncOne(db, ctx, source, dryRun));
      } catch (err) {
        if (!dryRun) {
          await db.entities.LeadSource.update(source.id, {
            last_synced_at: new Date().toISOString(),
            last_sync_status: `Error: ${err.message}`.slice(0, 200),
          }).catch(() => {});
        }
        results.push({ source: source.name, error: err.message });
      }
    }

    return ctx.json({ results });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
