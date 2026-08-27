import { requireUser, HttpError } from './_runtime.js';

// generateBillingRun
//
// Computes a billing run for one counterparty (a buyer or a supplier) over one
// period, and optionally commits it as a BillingRun plus its BillingLineItem
// rows. This function never creates an Invoice, never charges anything, never
// touches Stripe or Xero, and never writes BuyerPayment / SupplierPayout /
// WalletTransaction records. Issuing is a separate later build.
//
// Preview vs commit:
// - commit=false (default): compute everything, write nothing, return the result.
// - commit=true: write the BillingRun and its BillingLineItem rows, respecting
//   idempotency (see the double-billing guard below).
//
// Access rules are operator only.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

// App timezone used for period boundaries and for bucketing each lead by its
// real event time. Regina has no daylight saving, so it is a fixed UTC-06:00.
const APP_TZ_OFFSET_MINUTES = -360; // America/Regina = UTC-06:00 year round

// Page through an entity list / filter so large tables are fully loaded.
async function loadAll(entity, filter) {
  const pageSize = 500;
  const out = [];
  let skip = 0;
  while (true) {
    const batch = filter
      ? await entity.filter(filter, '-created_date', pageSize, skip)
      : await entity.list('-created_date', pageSize, skip);
    out.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

// Parse a JSON value that may be a string, object, or already-parsed. Returns {}
// on anything unparseable so callers never throw on a malformed field.
function parseJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try {
    const p = JSON.parse(val);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// Same operator semantics used everywhere else in the app (processLead's
// applyOperator). String compares are literal, gt/lt are numeric.
function applyOperator(actual, operator, expected) {
  let act = actual == null ? '' : actual;
  if (typeof act === 'object') act = JSON.stringify(act);
  else act = String(act);
  const exp = expected == null ? '' : String(expected);
  switch (operator) {
    case 'equals': return act === exp;
    case 'not_equals': return act !== exp;
    case 'contains': return act.includes(exp);
    case 'not_contains': return !act.includes(exp);
    case 'starts_with': return act.startsWith(exp);
    case 'ends_with': return act.endsWith(exp);
    case 'is_empty': return act === '';
    case 'is_not_empty': return act !== '';
    case 'gt': return parseFloat(act) > parseFloat(exp);
    case 'lt': return parseFloat(act) < parseFloat(exp);
    default: return act.includes(exp);
  }
}

// All conditions in the array must match against the enriched lead fields.
function conditionsMatch(conditions, fields) {
  const list = Array.isArray(conditions) ? conditions : parseJsonArray(conditions);
  if (list.length === 0) return true;
  return list.every((c) => applyOperator(fields[c.field], c.operator, c.value));
}

// Convert a YYYY-MM-DD period boundary into a UTC millisecond range. The whole
// day is inclusive in the app timezone: start is 00:00:00 local on period_start,
// end is 23:59:59.999 local on period_end.
function periodBoundsUtc(periodStart, periodEnd) {
  const offsetMs = APP_TZ_OFFSET_MINUTES * 60000;
  // Local midnight expressed as UTC = midnight-as-UTC minus the offset.
  const startLocalMidnightUtc = Date.parse(`${periodStart}T00:00:00Z`);
  const endLocalMidnightUtc = Date.parse(`${periodEnd}T00:00:00Z`);
  const startMs = startLocalMidnightUtc - offsetMs;
  const endMs = endLocalMidnightUtc - offsetMs + 86400000 - 1;
  return { startMs, endMs };
}

// Resolve the real event time (ms) of a lead from its mapped_fields.timestamp,
// interpreted in the app timezone. Timestamps are stored as MM/DD/YYYY HH:MM:SS
// (see processLead formatTimestamp) but we also accept ISO. Returns null when no
// usable timestamp is present, so the caller can fall back deliberately.
function leadEventTimeMs(fields) {
  const raw = fields && fields.timestamp != null ? String(fields.timestamp).trim() : '';
  if (!raw) return null;
  const offsetMs = APP_TZ_OFFSET_MINUTES * 60000;
  // MM/DD/YYYY HH:MM:SS (24h) as written by processLead.
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, mm, dd, yyyy, hh, mi, ss] = m;
    const asUtc = Date.UTC(
      Number(yyyy), Number(mm) - 1, Number(dd),
      Number(hh || 0), Number(mi || 0), Number(ss || 0),
    );
    // The parts are local time, so subtract the offset to get true UTC.
    return asUtc - offsetMs;
  }
  // ISO or anything Date can parse: treat as an absolute instant.
  const parsed = Date.parse(raw);
  return isNaN(parsed) ? null : parsed;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Human readable vertical + price description, e.g. "MVA leads at 300 per lead".
// Never contains an em dash.
function lineDescription(vertical, unitPrice) {
  const label = vertical && String(vertical).trim() ? String(vertical).trim() : 'Uncategorized';
  const price = round2(unitPrice);
  const priceStr = Number.isInteger(price) ? String(price) : price.toFixed(2);
  return `${label} leads at ${priceStr} per lead`;
}

export default async function generateBillingRun(ctx) {
  try {
    // ── AUTH GUARD (operator only) ───────────────────────────────────────
    const user = requireUser(ctx);
    const db = ctx.db;

    const record = await db.entities.User.get(user.id).catch(() => null);
    const caller = record || user;

    if (caller.base_role === 'supplier' || caller.base_role === 'buyer') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }
    if (caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }
    const hasOperatorPermission = OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
    if (!hasOperatorPermission && caller.role !== 'admin') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    // ── ARGUMENTS ────────────────────────────────────────────────────────
    const body = ctx.body || {};
    const scope = body && typeof body.scope === 'string' ? body.scope.trim() : '';
    const buyerId = body && body.buyer_id ? String(body.buyer_id) : null;
    const supplierId = body && body.supplier_id ? String(body.supplier_id) : null;
    const periodStart = body && body.period_start ? String(body.period_start).slice(0, 10) : '';
    const periodEnd = body && body.period_end ? String(body.period_end).slice(0, 10) : '';
    const commit = body && body.commit === true;

    if (scope !== 'buyer' && scope !== 'supplier') {
      return ctx.json({ error: 'scope must be buyer or supplier' }, 400);
    }
    if (scope === 'buyer' && !buyerId) {
      return ctx.json({ error: 'buyer_id is required for a buyer run' }, 400);
    }
    if (scope === 'supplier' && !supplierId) {
      return ctx.json({ error: 'supplier_id is required for a supplier run' }, 400);
    }
    if (scope === 'buyer' && supplierId) {
      return ctx.json({ error: 'supplier_id must not be set on a buyer run' }, 400);
    }
    if (scope === 'supplier' && buyerId) {
      return ctx.json({ error: 'buyer_id must not be set on a supplier run' }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return ctx.json({ error: 'period_start and period_end must be YYYY-MM-DD dates' }, 400);
    }
    if (periodEnd < periodStart) {
      return ctx.json({ error: 'period_end must not be before period_start' }, 400);
    }

    const svc = db;
    const notes = [];
    const { startMs, endMs } = periodBoundsUtc(periodStart, periodEnd);

    // ── SELECT LEADS ───────────────────────────────────────────────────────
    // We over-fetch by created_date (import time) with a wide guard, then bucket
    // precisely by the lead's real event time inside the app timezone. created_date
    // is import time, so we cannot filter on it; we scan and bucket by timestamp.
    let leadFilter = {};
    let supplierFallbackUsed = 0;
    let supplierRecord = null;
    let buyerRecord = null;

    if (scope === 'buyer') {
      buyerRecord = await svc.entities.Buyer.get(buyerId).catch(() => null);
      if (!buyerRecord) return ctx.json({ error: 'Buyer not found' }, 404);
      // Lead.buyer_id is the legacy overloaded field (holds a buyer_code, not
      // a record id, on every lead observed in production - see
      // server/src/lib/buyerIdentity.js). Filtering on it here always
      // returned zero rows against a real Buyer record id. buyer_record_id
      // is the additive, unambiguous field the identity backfill maintains.
      leadFilter = { buyer_record_id: buyerId };
    } else {
      supplierRecord = await svc.entities.Supplier.get(supplierId).catch(() => null);
      if (!supplierRecord) return ctx.json({ error: 'Supplier not found' }, 404);
    }

    // For a supplier run, select by supplier_key_id, falling back to
    // supplier_name when the key is absent OR stale (a key id that no longer
    // resolves to any current ApiKey, e.g. after a key was reissued and
    // rotated to a new id, as happened for LeadFlow's "LGNX Master" key
    // during the August 2026 disaster-recovery migration). We resolve the
    // supplier's ApiKey ids first, then scan; leads whose supplier_key_id
    // still resolves to a DIFFERENT supplier's real key are correctly
    // excluded by the fallback below, since only a stale/absent key id is
    // treated as "no usable key".
    let supplierKeyIds = [];
    let allKeyIds = new Set();
    if (scope === 'supplier') {
      const [keys, allKeys] = await Promise.all([
        loadAll(svc.entities.ApiKey, { supplier_id: supplierId }),
        loadAll(svc.entities.ApiKey, {}),
      ]);
      supplierKeyIds = keys.map((k) => k.id);
      allKeyIds = new Set(allKeys.map((k) => k.id));
    }

    // Load leads for the counterparty. Buyer runs filter server side by buyer_id.
    // Supplier runs scan by each key id, then by name for keyless leads.
    let candidateLeads = [];
    if (scope === 'buyer') {
      candidateLeads = await loadAll(svc.entities.Lead, leadFilter);
    } else {
      const byKey = [];
      for (const kid of supplierKeyIds) {
        const batch = await loadAll(svc.entities.Lead, { supplier_key_id: kid });
        byKey.push(...batch);
      }
      const seen = new Set(byKey.map((l) => l.id));
      // Name fallback: leads attributed to this supplier by name with no
      // usable key id. "Usable" excludes a key id that still resolves to
      // some current ApiKey (that is a real, different supplier's key, so
      // the lead genuinely is not ours) but includes a key id that resolves
      // to nothing at all (stale: the key it was issued under has since been
      // deleted or reissued, which is not evidence the lead belongs to
      // someone else).
      const byName = await loadAll(svc.entities.Lead, { supplier_name: supplierRecord.name });
      let fallbackCount = 0;
      let staleKeyFallbackCount = 0;
      for (const l of byName) {
        if (seen.has(l.id)) continue;
        if (l.supplier_key_id && allKeyIds.has(l.supplier_key_id)) continue; // resolves to a real, different supplier's key
        byKey.push(l);
        seen.add(l.id);
        if (l.supplier_key_id) staleKeyFallbackCount += 1; else fallbackCount += 1;
      }
      supplierFallbackUsed = fallbackCount + staleKeyFallbackCount;
      if (fallbackCount > 0) {
        notes.push(`${fallbackCount} leads matched by supplier_name because supplier_key_id was absent.`);
      }
      if (staleKeyFallbackCount > 0) {
        notes.push(`${staleKeyFallbackCount} leads matched by supplier_name because supplier_key_id no longer resolves to any current key (stale/rotated key reference).`);
      }
      candidateLeads = byKey;
    }

    // Bucket by real event time inside the period. Leads with no usable
    // timestamp are excluded and reported, never silently bucketed by import time.
    let noTimestampCount = 0;
    const leads = candidateLeads.filter((l) => {
      const fields = parseJsonObject(l.mapped_fields);
      const t = leadEventTimeMs(fields);
      if (t == null) { noTimestampCount += 1; return false; }
      return t >= startMs && t <= endMs;
    });
    if (noTimestampCount > 0) {
      notes.push(`${noTimestampCount} candidate leads were skipped because they had no usable event timestamp in mapped_fields.`);
    }

    const totalLeads = leads.length;

    // ── RETURNS ──────────────────────────────────────────────────────────
    // A lead is not billable when an approved ReturnRequest exists for it.
    // Requested and rejected returns are counted separately and not deducted.
    const leadIds = new Set(leads.map((l) => l.id));
    const allReturns = await loadAll(svc.entities.ReturnRequest);
    const approvedReturnLeadIds = new Set();
    let requestedReturns = 0;
    let rejectedReturns = 0;
    for (const r of allReturns) {
      if (!r.lead_id || !leadIds.has(r.lead_id)) continue;
      if (r.status === 'approved') approvedReturnLeadIds.add(r.lead_id);
      else if (r.status === 'requested') requestedReturns += 1;
      else if (r.status === 'rejected') rejectedReturns += 1;
    }
    const approvedReturns = approvedReturnLeadIds.size;
    const billableLeads = totalLeads - approvedReturns;

    // Enrich each lead: parse mapped_fields once, resolve state/vertical.
    const enriched = leads.map((l) => {
      const fields = parseJsonObject(l.mapped_fields);
      const state = String(fields.state || fields.accident_state || l.state || '').trim().toUpperCase();
      const vertical = String(fields.vertical || l.vertical || '').trim();
      return { lead: l, fields, state, vertical, returned: approvedReturnLeadIds.has(l.id) };
    });

    // ── PRICING ────────────────────────────────────────────────────────────
    // Each billable lead resolves to a unit price. Grouping keys and the run
    // totals accumulate here. Unpriced leads are counted and reported, never
    // priced at zero silently.
    const groups = new Map();
    let unpricedLeads = 0;
    let gross = 0;
    let iplFees = 0;
    let contractedGross = 0;
    let capturedRevenue = 0;
    let multiBuyerSuspected = 0;
    let unattributedLeads = 0;
    let supplierNoneZeroCount = 0;

    if (scope === 'buyer') {
      const iplPct = buyerRecord.ipl_fee_pct != null ? Number(buyerRecord.ipl_fee_pct) : 1;

      // Contracted pricing sources for this buyer.
      const cplRules = (await loadAll(svc.entities.BuyerCplRule, { buyer_id: buyerId }))
        .filter((r) => r.active !== false)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0)); // highest priority first
      const stateCplRows = (await loadAll(svc.entities.BuyerStateCpl, { buyer_id: buyerId }))
        .filter((r) => r.active !== false);
      // Index BuyerStateCpl by vertical|state for O(1) lookup.
      const stateCplIndex = new Map();
      for (const row of stateCplRows) {
        stateCplIndex.set(`${row.vertical}|${String(row.state || '').toUpperCase()}`, row);
      }

      for (const e of enriched) {
        // Revenue variance: sum captured revenue over ALL selected leads (billable
        // or not) so the operator sees the true captured figure. Never split it.
        const rev = Number(e.lead.revenue) || 0;
        capturedRevenue += rev;
        if (e.lead.final_status === 'Sold' && !e.lead.buyer_id) unattributedLeads += 1;

        if (e.returned) continue; // not billable

        // 1) Highest-priority matching active BuyerCplRule wins.
        let unitPrice = null;
        for (const rule of cplRules) {
          // Optional scoping by vertical when the rule sets one.
          if (rule.vertical && rule.vertical !== e.vertical) continue;
          if (conditionsMatch(rule.conditions, e.fields)) {
            unitPrice = Number(rule.cpl);
            break;
          }
        }
        // 2) Otherwise the active BuyerStateCpl row for vertical + state.
        if (unitPrice == null) {
          const row = stateCplIndex.get(`${e.vertical}|${e.state}`);
          if (row && row.cpl != null) unitPrice = Number(row.cpl);
        }
        // 3) Neither: unpriced. Do not guess, do not price at zero silently.
        if (unitPrice == null || isNaN(unitPrice)) {
          unpricedLeads += 1;
          continue;
        }

        // Multi-buyer suspicion: captured revenue on this lead exceeds the
        // contracted unit price resolved for the attributed buyer.
        if (rev > unitPrice) multiBuyerSuspected += 1;

        gross += unitPrice;
        contractedGross += unitPrice;
        iplFees += unitPrice * (1 - iplPct);

        // Group by vertical, state, unit_price, plus supplier_id when known.
        const supKey = e.lead.supplier_key_id || '';
        const key = `${e.vertical}|${e.state}|${round2(unitPrice)}|${supKey}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            vertical: e.vertical || null,
            state: e.state || null,
            campaign_id: null,
            supplier_id: supKey || null,
            source_code: null,
            unit_price: round2(unitPrice),
            lead_count: 0,
            returns: 0,
            amount: 0,
          };
          groups.set(key, g);
        }
        g.lead_count += 1;
        g.amount = round2(g.amount + unitPrice);
      }
    } else {
      // ── SUPPLIER PRICING ─────────────────────────────────────────────────
      const sources = await loadAll(svc.entities.SupplierSource, { supplier_id: supplierId });
      // Index by normalized utm_source for matching.
      const sourceByUtm = new Map();
      for (const s of sources) {
        if (s.utm_source) sourceByUtm.set(String(s.utm_source).trim().toLowerCase(), s);
      }
      const supPayoutType = supplierRecord.payout_type || 'None';
      const supPayoutValue = Number(supplierRecord.payout_value) || 0;
      let sourceFallbackUsed = 0;
      // Profit share accumulators. Settled once after the per-lead loop.
      let profitPctRate = 0;
      let profitPctLeads = 0;
      let profitPctRevenue = 0;

      for (const e of enriched) {
        if (e.returned) continue; // not billable

        const utm = String(e.fields.utm_source || '').trim().toLowerCase();
        const source = utm ? sourceByUtm.get(utm) : null;

        let unitPrice = null;
        let sourceCode = null;

        if (source) {
          sourceCode = source.source_code || null;
          // These values must match the SupplierSource pricing_model enum
          // exactly: none | flat_cpl | profit_pct | revenue_pct | tiered.
          // This previously branched on 'rev_share' and read
          // source.rev_share_pct, neither of which exists, so every Revenue %
          // and Profit % source fell through unpriced and was billed on the
          // supplier-level fallback instead of its own configured rate.
          if (source.pricing_model === 'revenue_pct') {
            const rev = Number(e.lead.revenue) || 0;
            unitPrice = rev * (Number(source.revenue_pct) || 0) / 100;
          } else if (source.pricing_model === 'flat_cpl') {
            unitPrice = Number(source.flat_cpl);
            if (isNaN(unitPrice)) unitPrice = null;
          } else if (source.pricing_model === 'profit_pct') {
            // Profit share is a PERIOD calculation, not a per-lead one: profit
            // is the period's revenue minus the period's cost, and cost for a
            // Meta sourced supplier is its attributed ad spend, which no single
            // lead carries. Defer it and settle once after this loop.
            profitPctRate = Number(source.profit_pct) || 0;
            profitPctLeads += 1;
            profitPctRevenue += Number(e.lead.revenue) || 0;
            continue;
          } else if (source.pricing_model === 'tiered') {
            const rules = Array.isArray(source.tier_rules) ? source.tier_rules : parseJsonArray(source.tier_rules);
            for (const rule of rules) {
              if (conditionsMatch(rule.conditions, e.fields)) {
                unitPrice = Number(rule.price);
                break;
              }
            }
            // No tier matched: unpriced. Do not fall through to zero silently.
          }
        } else {
          // No SupplierSource matches: fall back to supplier-level payout.
          sourceFallbackUsed += 1;
          if (supPayoutType === 'None') {
            unitPrice = 0; // a real zero, not an unpriced lead
            supplierNoneZeroCount += 1;
          } else if (supPayoutType === 'Flat CPL') {
            unitPrice = supPayoutValue;
          } else if (supPayoutType === 'Revenue %') {
            const rev = Number(e.lead.revenue) || 0;
            unitPrice = rev * supPayoutValue / 100;
          } else if (supPayoutType === 'Profit %') {
            // Same deferral as the source-level case: settled once on period
            // totals after the loop, against real ad spend, rather than being
            // silently treated as Revenue % per lead.
            profitPctRate = supPayoutValue;
            profitPctLeads += 1;
            profitPctRevenue += Number(e.lead.revenue) || 0;
            continue;
          }
        }

        if (unitPrice == null || isNaN(unitPrice)) {
          unpricedLeads += 1;
          continue;
        }

        gross += unitPrice;

        // Group by source_code, vertical, state.
        const key = `${sourceCode || ''}|${e.vertical}|${e.state}|${round2(unitPrice)}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            vertical: e.vertical || null,
            state: e.state || null,
            campaign_id: null,
            supplier_id: null,
            source_code: sourceCode,
            unit_price: round2(unitPrice),
            lead_count: 0,
            returns: 0,
            amount: 0,
          };
          groups.set(key, g);
        }
        g.lead_count += 1;
        g.amount = round2(g.amount + unitPrice);
      }

      // ── PROFIT SHARE SETTLEMENT ──────────────────────────────────────────
      // Settled once on period totals: payout = rate% x (revenue - cost).
      // Cost is the supplier's attributed ad spend for the period. Account rows
      // are the per-account daily rollup; where a day has no account row its
      // campaign rows are summed to reconstruct it, which is exact and avoids
      // both double counting and losing days the sync has not rolled up yet.
      if (profitPctLeads > 0) {
        const spendRowsAll = await loadAll(svc.entities.AdSpend, {});
        const supKey = String(supplierRecord.name || '').trim().toLowerCase();
        const inPeriod = (d) => d >= periodStart && d <= periodEnd;
        const matches = (r) => {
          const k = String(r.supplier_key ?? r.supplier_name ?? '').trim().toLowerCase();
          if (!k || !supKey) return false;
          return k === supKey || k.includes(supKey) || supKey.includes(k);
        };

        const accountKeys = new Set();
        let cost = 0;
        for (const r of spendRowsAll) {
          const d = String(r.date || '').slice(0, 10);
          if (!inPeriod(d) || !matches(r)) continue;
          if (!r.level || r.level === 'account') {
            accountKeys.add(`${r.ad_account_id || ''}|${d}`);
            cost += Number(r.spend) || 0;
          }
        }
        for (const r of spendRowsAll) {
          const d = String(r.date || '').slice(0, 10);
          if (!inPeriod(d) || !matches(r)) continue;
          if (r.level !== 'campaign') continue;
          if (accountKeys.has(`${r.ad_account_id || ''}|${d}`)) continue;
          cost += Number(r.spend) || 0;
        }

        const profit = round2(profitPctRevenue - cost);
        const payout = round2(profit * profitPctRate / 100);

        if (payout > 0) {
          gross += payout;
          groups.set('__profit_share__', {
            vertical: null,
            state: null,
            campaign_id: null,
            supplier_id: null,
            source_code: 'PROFIT_SHARE',
            unit_price: payout,
            lead_count: profitPctLeads,
            returns: 0,
            amount: payout,
          });
          notes.push(`Profit share: ${profitPctRate}% of ${round2(profit)} profit (${round2(profitPctRevenue)} revenue less ${round2(cost)} ad spend) across ${profitPctLeads} leads.`);
        } else {
          // A loss-making period owes nothing. Recorded rather than billed, so
          // the run does not look like it silently skipped the supplier.
          notes.push(`Profit share not billed: period profit is ${round2(profit)} (${round2(profitPctRevenue)} revenue less ${round2(cost)} ad spend) across ${profitPctLeads} leads.`);
        }
      }

      if (sourceFallbackUsed > 0) {
        notes.push(`${sourceFallbackUsed} leads used the supplier level payout fallback because no SupplierSource matched their utm_source.`);
      }
      if (supplierNoneZeroCount > 0) {
        notes.push(`${supplierNoneZeroCount} fallback leads priced at a real zero because the supplier payout type is None.`);
      }
    }

    gross = round2(gross);
    iplFees = round2(iplFees);
    const net = round2(gross - iplFees);
    const revenueVariance = round2(contractedGross - capturedRevenue);

    // Build line items with descriptions and per-line ipl for buyer runs.
    const lineItems = Array.from(groups.values()).map((g) => {
      const item = {
        vertical: g.vertical,
        state: g.state,
        campaign_id: g.campaign_id,
        supplier_id: g.supplier_id,
        source_code: g.source_code,
        lead_count: g.lead_count,
        returns: g.returns,
        unit_price: round2(g.unit_price),
        amount: round2(g.amount),
        description: lineDescription(g.vertical, g.unit_price),
      };
      return item;
    });

    // Per-line ipl (unit_price * ipl_fee_pct) is surfaced on the summary for
    // buyer runs so the number actually invoiced is visible. It is not a
    // BillingLineItem column, so it lives on the returned preview only.
    const iplPctForDisplay = scope === 'buyer' && buyerRecord.ipl_fee_pct != null
      ? Number(buyerRecord.ipl_fee_pct) : null;
    const lineItemsWithIpl = lineItems.map((li) => ({
      ...li,
      ipl_per_lead: iplPctForDisplay != null ? round2(li.unit_price * iplPctForDisplay) : null,
    }));

    const summary = {
      scope,
      buyer_id: buyerId,
      supplier_id: supplierId,
      period_start: periodStart,
      period_end: periodEnd,
      totals: {
        total_leads: totalLeads,
        billable_leads: billableLeads,
        returns: approvedReturns,
        requested_returns: requestedReturns,
        rejected_returns: rejectedReturns,
        gross,
        ipl_fees: iplFees,
        net,
      },
      line_items: lineItemsWithIpl,
      unpriced_leads: unpricedLeads,
      unattributed_leads: unattributedLeads,
      multi_buyer_suspected: multiBuyerSuspected,
      revenue_variance: {
        contracted_gross: round2(contractedGross),
        captured_revenue: round2(capturedRevenue),
        revenue_variance: revenueVariance,
      },
      fallback_counts: {
        supplier_name_fallback: supplierFallbackUsed,
        supplier_none_zero: supplierNoneZeroCount,
      },
      notes,
      committed: false,
      billing_run_id: null,
    };

    if (!commit) {
      return ctx.json(summary);
    }

    // ── COMMIT: idempotency / double-billing guard ─────────────────────────
    // BillingRun is unique on scope, buyer_id, supplier_id, period_start, period_end.
    const existingRuns = await svc.entities.BillingRun.filter({
      scope,
      buyer_id: buyerId,
      supplier_id: supplierId,
      period_start: periodStart,
      period_end: periodEnd,
    });
    const existing = existingRuns[0] || null;

    if (existing && (existing.status === 'issued' || existing.status === 'paid')) {
      return ctx.json({
        error: `A ${existing.status} billing run already exists for this period (run ${existing.id}). Refusing to bill it again.`,
        existing_run_id: existing.id,
        existing_status: existing.status,
      }, 409);
    }

    const runPayload = {
      scope,
      buyer_id: buyerId,
      supplier_id: supplierId,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'draft',
      total_leads: totalLeads,
      billable_leads: billableLeads,
      returns: approvedReturns,
      gross,
      ipl_fees: iplFees,
      net,
      generated_at: new Date().toISOString(),
      generated_by: caller.id,
    };

    let runId;
    if (existing && existing.status === 'draft') {
      // Replace the draft run and its line items rather than creating a second.
      const oldItems = await loadAll(svc.entities.BillingLineItem, { billing_run_id: existing.id });
      for (const it of oldItems) {
        await svc.entities.BillingLineItem.delete(it.id);
      }
      await svc.entities.BillingRun.update(existing.id, runPayload);
      runId = existing.id;
      notes.push('Replaced an existing draft billing run for this period.');
    } else {
      const created = await svc.entities.BillingRun.create(runPayload);
      runId = created.id;
    }

    // Write line items.
    if (lineItems.length > 0) {
      await svc.entities.BillingLineItem.bulkCreate(
        lineItems.map((li) => ({ ...li, billing_run_id: runId })),
      );
    }

    summary.committed = true;
    summary.billing_run_id = runId;
    summary.notes = notes;
    return ctx.json(summary);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
