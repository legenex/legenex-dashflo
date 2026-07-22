// Supplier cost engine.
//
// Resolves, per lead, which SupplierSource priced it and what that lead cost,
// then aggregates cost / profit / CPL / money due per supplier over a date
// window. Pure functions: callers pass already-loaded Lead, Supplier,
// SupplierSource and AdSpend records.
//
// Source resolution order for a lead (mirrors the live pipeline, read only):
//   1. ssid on the payload wins: match the source whose source_code equals it.
//   2. no ssid: fall back to the source whose brand equals the lead supplier_brand.
//   3. neither matches: attribute to the supplier itself with no source.
//
// Cost by supplier_type:
//   External: cost from the matched source pricing (flat_cpl, rev_share % of the
//             lead revenue, or tiered rules), falling back to the lead
//             supplier_payout when the source has no pricing (none / no match).
//   Internal (LEADFLOW, LEGENEX): cost from mapped ad accounts via AdSpend,
//             never supplier_payout or CPL. Internal sources use pricing none.

import { leadField, leadEventInstant } from '@/lib/reportMetrics';
import { parseRules, firstMatchIndex } from '@/components/operations/suppliers/tierRules';

function num(v) { const n = Number(v); return Number.isNaN(n) ? 0 : n; }
function norm(v) { return String(v ?? '').trim().toLowerCase(); }

// The ssid the inbound lead carried, from any of the common aliases.
export function leadSsid(lead) {
  for (const k of ['ssid', 'sid', 'supplier_sid', 'source_code', 'source_id']) {
    const v = leadField(lead, k);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// The supplier_brand the inbound lead carried.
export function leadBrand(lead) {
  for (const k of ['supplier_brand', 'brand']) {
    const v = leadField(lead, k);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Pick the SupplierSource that priced this lead, from that supplier's own
// sources. Returns null when none resolve (supplier level attribution).
export function resolveSource(lead, sources) {
  const active = (sources || []).filter((s) => s.active !== false);
  if (active.length === 0) return null;

  const ssid = norm(leadSsid(lead));
  if (ssid) {
    const byCode = active.find((s) => norm(s.source_code) === ssid);
    if (byCode) return byCode;
  }

  const brand = norm(leadBrand(lead));
  if (brand) {
    const byBrand = active.find((s) => norm(s.brand) === brand);
    if (byBrand) return byBrand;
  }

  return null;
}

// Flat sample object for tiered rule evaluation: exposes the fields a rule can
// condition on (state, plus any mapped field), all as strings.
function ruleSample(lead) {
  const sample = {};
  for (const f of ['state', 'accident_state', 'vertical', 'lead_type', 'lead_status']) {
    const v = leadField(lead, f);
    if (v != null) sample[f] = String(v);
  }
  // state alias so a rule on `state` still matches accident_state
  if (sample.state == null && sample.accident_state != null) sample.state = sample.accident_state;
  return sample;
}

// Price one lead from a source's pricing. Returns a number, or null when the
// source has no usable price (falls through to supplier_payout).
function priceFromSource(lead, source) {
  if (!source) return null;
  const model = source.pricing_model;
  if (model === 'flat_cpl') {
    return source.flat_cpl == null ? null : num(source.flat_cpl);
  }
  if (model === 'rev_share') {
    if (source.rev_share_pct == null) return null;
    return num(lead.revenue) * num(source.rev_share_pct) / 100;
  }
  if (model === 'tiered') {
    const rules = parseRules(source.tier_rules);
    if (rules.length === 0) return null;
    const idx = firstMatchIndex(rules, ruleSample(lead));
    if (idx < 0) return null;
    return num(rules[idx].price);
  }
  // model === 'none' or unset
  return null;
}

// Cost of a single lead for an External supplier: source price, else the lead's
// reported supplier_payout.
export function externalLeadCost(lead, source) {
  const priced = priceFromSource(lead, source);
  if (priced != null) return priced;
  return num(lead.supplier_payout);
}

// Sum of mapped ad spend for an Internal supplier within the loaded AdSpend
// rows. AdSpend.supplier_key is the lowercased supplier_name.
export function internalSupplierSpend(supplierName, adSpendRows) {
  const key = norm(supplierName);
  let spend = 0;
  for (const r of adSpendRows || []) {
    // Only account-level rows drive cost. Campaign and ad rows are detail views
    // and also carry a supplier now, so counting them would multiply the spend.
    if (r.level && r.level !== 'account') continue;
    const rk = r.supplier_key != null ? norm(r.supplier_key) : norm(r.supplier_name);
    if (rk === key) spend += num(r.spend);
  }
  return spend;
}

// Filter leads to a { start, end } window using the lead's real event time.
// A null window returns all leads.
export function leadsInWindow(leads, window) {
  if (!window || (!window.start && !window.end)) return leads;
  return leads.filter((l) => {
    const inst = leadEventInstant(l);
    if (!inst) return false;
    if (window.start && inst < window.start) return false;
    if (window.end && inst > window.end) return false;
    return true;
  });
}

// Days elapsed for a Net term. Prepaid / Manual accrue immediately.
function termDays(terms) {
  switch (terms) {
    case 'Net 7': return 7;
    case 'Net 15': return 15;
    case 'Net 30': return 30;
    case 'Net 60': return 60;
    default: return 0; // Prepaid, Manual, or none: no deferral
  }
}

// Money Due: accrued unpaid cost. A lead's cost becomes due once its term has
// elapsed since the lead's event time. Prepaid / Manual / no term: due at once.
// This never reads or writes any billing record.
export function moneyDue(pricedLeads, supplier, now = new Date()) {
  const days = termDays(supplier?.payment_terms);
  let due = 0;
  for (const p of pricedLeads) {
    if (days === 0) { due += p.cost; continue; }
    const inst = leadEventInstant(p.lead);
    if (!inst) { due += p.cost; continue; }
    const ageDays = (now.getTime() - inst.getTime()) / 86400000;
    if (ageDays >= days) due += p.cost;
  }
  return due;
}

// Full metric bundle for one supplier over a window.
// sourcesBySupplier: { [supplierId]: SupplierSource[] }.
export function supplierCostMetrics(supplier, allLeads, sourcesBySupplier, adSpendRows, window, now = new Date()) {
  const sources = sourcesBySupplier[supplier.id] || [];
  const rows = leadsInWindow(
    allLeads.filter((l) => l.supplier_name === supplier.name),
    window,
  );
  const isInternal = supplier.supplier_type === 'Internal';

  let revenue = 0;
  let sold = 0;
  const pricedLeads = [];

  for (const lead of rows) {
    revenue += num(lead.revenue);
    if (String(lead.final_status || '') === 'Sold') sold++;
    const source = isInternal ? null : resolveSource(lead, sources);
    const cost = isInternal ? 0 : externalLeadCost(lead, source);
    pricedLeads.push({ lead, cost, sourceId: source?.id || null });
  }

  let cost;
  if (isInternal) {
    cost = internalSupplierSpend(supplier.name, adSpendRows);
  } else {
    cost = pricedLeads.reduce((a, p) => a + p.cost, 0);
  }

  const leads = rows.length;
  const profit = revenue - cost;
  const cpl = leads > 0 ? cost / leads : 0;
  // Internal cost is a single spend pool, not per-lead, so distribute it across
  // priced leads for Money Due term accrual; External uses per-lead cost.
  const dueLeads = isInternal
    ? pricedLeads.map((p, i) => ({ lead: p.lead, cost: leads > 0 ? cost / leads : 0 }))
    : pricedLeads;
  const due = moneyDue(dueLeads, supplier, now);

  return { leads, sold, revenue, cost, profit, cpl, moneyDue: due, sourceCount: sources.length };
}

// A short human summary of a supplier's payout: its sources' pricing, or the
// supplier-level payout_type when it has no sources.
export function payoutSummary(supplier, sources) {
  const list = sources || [];
  if (list.length === 0) {
    const t = supplier?.payout_type && supplier.payout_type !== 'None' ? supplier.payout_type : 'None';
    if (t === 'Flat CPL' && supplier?.payout_value != null) return `Flat $${num(supplier.payout_value).toFixed(2)}`;
    if ((t === 'Revenue %' || t === 'Profit %') && supplier?.payout_value != null) return `${t} ${num(supplier.payout_value)}%`;
    return t;
  }
  const models = list.map((s) => s.pricing_model).filter(Boolean);
  const uniq = [...new Set(models)];
  if (uniq.length === 1) return `${list.length} src · ${uniq[0]}`;
  return `${list.length} src · mixed`;
}