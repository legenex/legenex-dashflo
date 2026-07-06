// Central analytics engine for the Reports report-builder and Finances.
// Reads Lead + AdSpend records and computes every metric surfaced on cards/widgets.
// Pure functions, no fetching - callers pass in already-loaded records.

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

// Extract a value from a lead including mapped_fields / raw_payload fallbacks.
export function leadField(lead, field) {
  if (lead[field] != null && lead[field] !== '') return lead[field];
  for (const key of ['mapped_fields', 'raw_payload']) {
    try {
      const obj = JSON.parse(lead[key] || '{}');
      if (obj && obj[field] != null && obj[field] !== '') return obj[field];
    } catch { /* ignore */ }
  }
  return undefined;
}

const S = (l) => String(l.final_status || '');

// Apply a filter object { field: value } to a list of leads.
export function applyFilters(leads, filters = {}) {
  const entries = Object.entries(filters).filter(([, v]) => v != null && v !== '' && v !== 'all');
  if (entries.length === 0) return leads;
  return leads.filter((l) =>
    entries.every(([field, value]) => {
      if (field === 'date_from') return !l.created_date || new Date(l.created_date) >= new Date(value);
      if (field === 'date_to') return !l.created_date || new Date(l.created_date) <= new Date(value + 'T23:59:59');
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
    cost += num(l.cost);
    if (s === 'Sold') { sold++; bookedRevenue += num(l.revenue); }
    else if (s === 'Unsold') unsold++;
    else if (s === 'Returned') returns++;
    else if (s === 'Duplicate') duplicates++;
    else if (s === 'Disqualified' || s === 'Rejected') dqs++;
    if (leadField(l, 'is_fake') === true || leadField(l, 'fake') === 'Yes') fakes++;
    if (l.hlr_status || leadField(l, 'phone_verified') === 'Yes') phoneVerified++;
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

// Build a daily time series of revenue/spend/profit for the sparkline + bar chart.
export function dailySeries(leads, adSpendRows = [], days = 14) {
  const map = {};
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map[key] = { date: key, revenue: 0, cost: 0, spend: 0, leads: 0, sold: 0 };
  }
  for (const l of leads) {
    const key = (l.created_date || '').slice(0, 10);
    if (!map[key]) continue;
    map[key].revenue += num(l.revenue);
    map[key].cost += num(l.cost);
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
    map[key].cost += num(l.cost);
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