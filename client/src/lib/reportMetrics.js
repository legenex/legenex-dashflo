// Central analytics engine for the Reports report-builder and Finances.
// Reads Lead + AdSpend records and computes every metric surfaced on cards/widgets.
// Pure functions, no fetching - callers pass in already-loaded records.

import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { APP_TZ } from '@/lib/periodRange';

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

export function money(v) {
  const n = num(v);
  const neg = n < 0;
  const s = `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return neg ? `-${s}` : s;
}
export function moneyShort(v) {
  const n = num(v);
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
export function pct(v) { return `${num(v).toFixed(1)}%`; }
export function int(v) { return num(v).toLocaleString(); }

// Report field aliases.
// Reports address leads by canonical report names, but live leads do not carry
// those names. There is no `cost` column on the Lead entity at all, and
// campaign / state / buyer / accident date only exist inside mapped_fields
// under supplier-shaped names. Each canonical name resolves through its alias
// list, first match wins, so cards, filters and group-by tables hit real data.
// Add an alias here rather than renaming lead fields: mapped_fields is owned by
// the inbound payload and processLead, not by reporting.
const FIELD_ALIASES = {
  cost: ['cost', 'cpl'],
  campaign: ['campaign', 'utm_campaign'],
  state: ['state', 'accident_state'],
  buyer: ['buyer', 'buyer_name'],
  accident_date: ['accident_date', 'incident_date'],
  phone_verified: ['hlr_status', 'phone_verified'],
};

// Parsed mapped_fields / raw_payload bags per lead. leadField is called many
// times per lead per render, so parsing the JSON strings every call is the
// difference between a fast board and a locked tab at 1000+ leads.
const bagCache = new WeakMap();
function leadBags(lead) {
  const cached = bagCache.get(lead);
  if (cached) return cached;
  const bags = [];
  for (const key of ['mapped_fields', 'raw_payload']) {
    try {
      const obj = JSON.parse(lead[key] || '{}');
      if (obj && typeof obj === 'object') bags.push(obj);
    } catch { /* ignore */ }
  }
  bagCache.set(lead, bags);
  return bags;
}

// Extract a value from a lead including alias resolution and
// mapped_fields / raw_payload fallbacks.
export function leadField(lead, field) {
  const names = FIELD_ALIASES[field] || [field];
  for (const name of names) {
    if (lead[name] != null && lead[name] !== '') return lead[name];
  }
  for (const bag of leadBags(lead)) {
    for (const name of names) {
      if (bag[name] != null && bag[name] !== '') return bag[name];
    }
  }
  return undefined;
}

// The lead's cost. The Lead entity has no cost column, so this resolves through
// the cost alias to mapped_fields.cpl, which arrives as a numeric string.
export function leadCost(lead) { return num(leadField(lead, 'cost')); }

const S = (l) => String(l.final_status || '');

// The lead's real event time. mapped_fields.timestamp is a naive local string
// like "2026-06-01 22:18:03" already in APP_TZ; interpret it as APP_TZ. If it
// is missing, fall back to the the backend created_date (import time).
export function leadEventInstant(lead) {
  const ts = leadField(lead, 'timestamp');
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(ts.trim())) {
    const raw = ts.trim().replace(' ', 'T');
    // If the string already carries a timezone (trailing Z or ±HH:MM offset),
    // parse it as an absolute instant. Only naive wall-clock strings are
    // interpreted in APP_TZ.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
    const d = hasZone ? new Date(raw) : fromZonedTime(raw, APP_TZ);
    if (!isNaN(d.getTime())) return d;
  }
  // created_date is stored without a timezone suffix; it is a UTC value, so
  // append Z when missing to avoid the browser parsing it as local time.
  const cd = lead.created_date;
  const norm = (typeof cd === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(cd)) ? cd + 'Z' : cd;
  const created = new Date(norm);
  return isNaN(created.getTime()) ? null : created;
}

// The lead's APP_TZ calendar day as "yyyy-MM-dd", or null if it has no valid date.
export function leadEventDayKey(lead) {
  const d = leadEventInstant(lead);
  if (!d || isNaN(d.getTime())) return null;
  return formatInTimeZone(d, APP_TZ, 'yyyy-MM-dd');
}

// Apply a filter object { field: value } to a list of leads.
export function applyFilters(leads, filters = {}) {
  const entries = Object.entries(filters).filter(([, v]) => v != null && v !== '' && v !== 'all');
  if (entries.length === 0) return leads;
  return leads.filter((l) =>
    entries.every(([field, value]) => {
      if (field === 'date_from') return leadEventInstant(l) >= fromZonedTime(value + 'T00:00:00', APP_TZ);
      if (field === 'date_to') return leadEventInstant(l) <= fromZonedTime(value + 'T23:59:59', APP_TZ);
      const lv = leadField(l, field);
      return String(lv ?? '').toLowerCase() === String(value).toLowerCase();
    })
  );
}

// Core aggregate over a set of leads + matching ad spend rows.
export function computeMetrics(leads, adSpendRows = []) {
  let revenue = 0, cost = 0, bookedRevenue = 0, verifiedIncome = 0, outstanding = 0, overdue = 0, shortPaid = 0;
  let sold = 0, unsold = 0, returns = 0, fakes = 0, duplicates = 0, dqs = 0, phoneVerified = 0;
  const total = leads.length;

  for (const l of leads) {
    const s = S(l);
    revenue += num(l.revenue);
    cost += leadCost(l);
    if (s === 'Sold') { sold++; bookedRevenue += num(l.revenue); }
    else if (s === 'Unsold') unsold++;
    else if (s === 'Returned') returns++;
    else if (s === 'Duplicate') duplicates++;
    else if (s === 'Disqualified' || s === 'Rejected') dqs++;
    if (leadField(l, 'is_fake') === true || leadField(l, 'fake') === 'Yes') fakes++;
    // Phone verification arrives as a match grade (Exact Match, Partial Match,
    // No Match), not a Yes/No, so count anything that is not an explicit miss.
    const pv = leadField(l, 'phone_verified');
    if (pv != null && !/^(no|none|false|no match|not verified)$/i.test(String(pv).trim())) phoneVerified++;
  }

  const adSpend = adSpendRows.reduce((a, r) => a + num(r.spend), 0);
  const profit = revenue - cost;
  const netRevenue = revenue - returns * (total ? revenue / Math.max(total, 1) : 0);
  const netProfit = netRevenue - cost - adSpend;
  const cpl = total > 0 ? cost / total : 0;
  const blendedCpl = total > 0 ? (cost + adSpend) / total : 0;
  const costPerSold = sold > 0 ? (cost + adSpend) / sold : 0;
  const convRate = total > 0 ? (sold / total) * 100 : 0;
  const qpMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const roas = adSpend > 0 ? revenue / adSpend : 0;
  verifiedIncome = bookedRevenue;
  const revenueGap = bookedRevenue - verifiedIncome;

  return {
    revenue, net_revenue: netRevenue, cost, cpl, profit, net_profit: netProfit,
    qp_margin: qpMargin, total_leads: total, sold, unsold, returns, fakes, duplicates, dqs,
    conv_rate: convRate, booked_revenue: bookedRevenue, verified_income: verifiedIncome,
    revenue_gap: revenueGap, outstanding, overdue, short_paid: shortPaid,
    ad_spend: adSpend, blended_cpl: blendedCpl, cost_per_sold: costPerSold, roas,
    phone_verified: phoneVerified,
  };
}

// Metric catalog: key -> { label, format }
export const METRIC_CATALOG = [
  { key: 'revenue', label: 'Revenue', format: 'money' },
  { key: 'net_revenue', label: 'Net Revenue', format: 'money' },
  { key: 'cost', label: 'Cost', format: 'money' },
  { key: 'cpl', label: 'CPL', format: 'money' },
  { key: 'profit', label: 'Profit', format: 'money' },
  { key: 'net_profit', label: 'Net Profit', format: 'money' },
  { key: 'qp_margin', label: 'QP Margin %', format: 'pct' },
  { key: 'total_leads', label: 'Total Leads', format: 'int' },
  { key: 'sold', label: 'Sold', format: 'int' },
  { key: 'unsold', label: 'Unsold', format: 'int' },
  { key: 'returns', label: 'Returns', format: 'int' },
  { key: 'fakes', label: 'Fakes', format: 'int' },
  { key: 'duplicates', label: 'Duplicates', format: 'int' },
  { key: 'dqs', label: 'DQs', format: 'int' },
  { key: 'conv_rate', label: 'Conv Rate', format: 'pct' },
  { key: 'booked_revenue', label: 'Booked Revenue', format: 'money' },
  { key: 'verified_income', label: 'Verified Income', format: 'money' },
  { key: 'revenue_gap', label: 'Revenue Gap', format: 'money' },
  { key: 'outstanding', label: 'Outstanding', format: 'money' },
  { key: 'overdue', label: 'Overdue', format: 'money' },
  { key: 'short_paid', label: 'Short Paid', format: 'money' },
  { key: 'ad_spend', label: 'Ad Spend', format: 'money' },
  { key: 'blended_cpl', label: 'Blended CPL', format: 'money' },
  { key: 'cost_per_sold', label: 'Cost Per Sold', format: 'money' },
  { key: 'roas', label: 'ROAS', format: 'num' },
  { key: 'phone_verified', label: 'Phone Verified', format: 'int' },
];

export const DEFAULT_CARD_METRICS = METRIC_CATALOG.filter(m => m.key !== 'phone_verified').map(m => m.key);

export function formatMetric(value, format) {
  switch (format) {
    case 'money': return money(value);
    case 'pct': return pct(value);
    case 'int': return int(value);
    case 'num': return num(value).toFixed(2);
    default: return String(value ?? '-');
  }
}

// Turn the report date filter into a series window. Returns null when no
// explicit range is applied, so callers fall back to their trailing default.
export function seriesWindow(filters = {}) {
  return filters?.date_from && filters?.date_to
    ? { from: filters.date_from, to: filters.date_to }
    : null;
}

const MAX_SERIES_DAYS = 366;

// Trailing `days` calendar days in APP_TZ, ending today.
function trailingDayKeys(days) {
  const keys = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    keys.push(formatInTimeZone(d, APP_TZ, 'yyyy-MM-dd'));
  }
  return keys;
}

// Day keys for the series. An explicit window wins so the chart and the daily
// table follow the selected date filter instead of always showing today back.
// Anchored at midday so stepping a day at a time can never drift across a
// boundary. Falls back to the trailing window if the range is unusable.
function seriesDayKeys(days, window) {
  if (!window?.from || !window?.to) return trailingDayKeys(days);
  const start = fromZonedTime(`${window.from}T12:00:00`, APP_TZ);
  const end = fromZonedTime(`${window.to}T12:00:00`, APP_TZ);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return trailingDayKeys(days);
  const keys = [];
  for (let d = start; d <= end && keys.length < MAX_SERIES_DAYS; d = new Date(d.getTime() + 86400000)) {
    keys.push(formatInTimeZone(d, APP_TZ, 'yyyy-MM-dd'));
  }
  return keys;
}

// Build a daily time series of revenue/spend/profit for the sparkline + bar chart.
// `window` is an optional { from, to } of yyyy-MM-dd APP_TZ day keys. When it is
// supplied it defines the buckets and `days` is ignored.
export function dailySeries(leads, adSpendRows = [], days = 14, window = null) {
  const map = {};
  for (const key of seriesDayKeys(days, window)) {
    map[key] = { date: key, revenue: 0, cost: 0, spend: 0, leads: 0, sold: 0 };
  }
  for (const l of leads) {
    const key = leadEventDayKey(l);
    if (!key || !map[key]) continue;
    map[key].revenue += num(l.revenue);
    map[key].cost += leadCost(l);
    map[key].leads += 1;
    if (S(l) === 'Sold') map[key].sold += 1;
  }
  for (const r of adSpendRows) {
    const key = (r.date || '').slice(0, 10);
    if (map[key]) map[key].spend += num(r.spend);
  }
  return Object.values(map).map(r => ({ ...r, profit: r.revenue - r.cost - r.spend }));
}

// Group-by aggregation used by tables (by campaign / state / buyer / supplier / utm etc).
export function groupBy(leads, field, adSpendRows = []) {
  const map = {};
  for (const l of leads) {
    const raw = leadField(l, field);
    const key = raw == null || raw === '' ? '(none)' : String(raw);
    if (!map[key]) map[key] = { key, leads: 0, sold: 0, revenue: 0, cost: 0 };
    map[key].leads += 1;
    map[key].revenue += num(l.revenue);
    map[key].cost += leadCost(l);
    if (S(l) === 'Sold') map[key].sold += 1;
  }
  // fold matching ad spend into cost for supplier grouping (true CPL)
  if (field === 'supplier_name') {
    for (const r of adSpendRows) {
      const key = r.supplier_name || '(none)';
      if (map[key]) map[key].cost += num(r.spend);
    }
  }
  return Object.values(map)
    .map(r => ({
      ...r,
      profit: r.revenue - r.cost,
      cpl: r.leads ? r.cost / r.leads : 0,
      convRate: r.leads ? (r.sold / r.leads) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export function statusBreakdown(leads) {
  const map = {};
  for (const l of leads) {
    const s = S(l) || 'Processing';
    map[s] = (map[s] || 0) + 1;
  }
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}