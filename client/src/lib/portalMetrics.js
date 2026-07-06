// Portal-scoped metrics over a buyer's own leads + feedback within a period.
import { resolvePeriod } from '@/lib/periodRange';

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

export function filterByPeriod(records, period, custom) {
  const { start, end } = resolvePeriod(period, custom);
  return records.filter(r => {
    if (!r.created_date) return false;
    const d = new Date(r.created_date);
    return d >= start && d <= end;
  });
}

export function portalMetrics(leads) {
  let revenue = 0, cost = 0, sold = 0;
  for (const l of leads) {
    revenue += num(l.revenue);
    cost += num(l.cost);
    if (String(l.final_status) === 'Sold') sold++;
  }
  const total = leads.length;
  return {
    total,
    revenue,
    cost,
    sold,
    convRate: total > 0 ? (sold / total) * 100 : 0,
  };
}

export function feedbackSummary(feedback) {
  const map = {};
  for (const f of feedback) {
    const k = f.disposition || 'Other';
    map[k] = (map[k] || 0) + 1;
  }
  return Object.entries(map)
    .map(([disposition, count]) => ({ disposition, count }))
    .sort((a, b) => b.count - a.count);
}