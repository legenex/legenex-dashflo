// Operational metrics for the Distribution dashboard. No revenue/profit/CPL anywhere.
import { format, eachDayOfInterval, isWithinInterval, differenceInCalendarDays } from 'date-fns';
import { leadEventInstant } from '@/lib/reportMetrics';
import { LEAD_STATUS, resolveLeadStatus } from '@/lib/leadStatus';

const inWin = (d, win) => { const dt = new Date(d); return isWithinInterval(dt, { start: win.start, end: win.end }); };

// Count of CAPI conversion events fired for a lead (proxy for conversions).
function convCount(l) {
  if (l.conv_value && Number(l.conv_value) > 0) return 1;
  if (!l.capi_log) return 0;
  try { return JSON.parse(l.capi_log).length ? 1 : 0; } catch { return 0; }
}

// forge-pack/CONTRACT.md D1/D4: Duplicate and Fake collapse into the
// `rejected` status; the retired failure legacy value collapses into
// `queued` (processing_state: failed), not into rejections. `rejections`
// below is therefore read straight off the canonical status rather than the
// old leadbyte_record_status text match plus a separate legacy-value count,
// which is also why "errors" here is a distinct, smaller figure now: it is
// genuinely stuck (queued + failed) leads plus logged ErrorLog rows, not
// every lead that used to carry that retired legacy value.
export function operationalMetrics(allLeads, allErrors, win) {
  const leads = allLeads.filter(l => inWin(l.created_date, win));
  const errors = (allErrors || []).filter(e => inWin(e.created_date, win));

  const by = (s) => leads.filter(l => resolveLeadStatus(l) === s).length;
  const total = leads.length;
  const sold = by(LEAD_STATUS.SOLD);
  const disqualified = by(LEAD_STATUS.DISQUALIFIED);
  const unsold = by(LEAD_STATUS.UNSOLD);
  const returns = by(LEAD_STATUS.RETURNED);
  const queued = by(LEAD_STATUS.QUEUED);
  const converted = by(LEAD_STATUS.CONVERTED);
  const rejections = by(LEAD_STATUS.REJECTED);
  const errorCount = leads.filter(l => l.processing_state === 'failed').length + errors.length;
  // Distinct from `converted` (the D1 lead_status): this counts CAPI
  // conversion events fired, an ad-attribution proxy metric that pre-dates
  // and is unrelated to a buyer confirming a sale downstream.
  const conversions = leads.reduce((a, l) => a + convCount(l), 0);

  const pct = (n) => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

  return {
    leads, total, sold, disqualified, unsold, returns, queued, converted, rejections,
    errors: errorCount, conversions,
    pctSold: pct(sold), pctDq: pct(disqualified), pctUnsold: pct(unsold),
    pctReturn: pct(returns), pctRejection: pct(rejections), pctError: pct(errorCount),
    convRate: pct(conversions),
  };
}

// Donut segments for leads-by-status in the window.
export function statusDonut(m) {
  return [
    { name: 'Sold', value: m.sold, color: '#22C55E' },
    { name: 'Unsold', value: m.unsold, color: '#F59E0B' },
    { name: 'Disqualified', value: m.disqualified, color: '#EF4444' },
    { name: 'Queued', value: m.queued, color: '#A855F7' },
    { name: 'Returned', value: m.returns, color: '#06B6D4' },
    { name: 'Rejected', value: m.rejections, color: '#64748B' },
    { name: 'Converted', value: m.converted, color: '#3B82F6' },
  ].filter(d => d.value > 0);
}

// Reason breakdown for the "unsold" status: qualified, entered distribution,
// no buyer bought it (D1), including buyers being asked and saying no.
// Reason text prefers a recorded buyer-side reason over the routing-side
// queue reason, since "a buyer said no" is the more specific fact when both
// are present. Capped at the top `limit` reasons by volume.
export function unsoldReasonBreakdown(leads, limit = 8) {
  const reasons = {};
  let total = 0;
  for (const l of leads) {
    if (resolveLeadStatus(l) !== LEAD_STATUS.UNSOLD) continue;
    const reason = (l.buyer_feedback && String(l.buyer_feedback).trim())
      || (l.queue_reason && String(l.queue_reason).trim())
      || (l.status_reason && String(l.status_reason).trim())
      || 'No buyer accepted';
    reasons[reason] = (reasons[reason] || 0) + 1;
    total += 1;
  }
  const rows = Object.entries(reasons)
    .map(([reason, count]) => ({ reason, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { rows, total };
}

// Leads-over-time series. Buckets by day; caps at ~60 buckets.
export function leadsOverTime(leads, win) {
  const days = eachDayOfInterval({ start: win.start, end: win.end });
  const fmt = days.length > 31 ? 'MMM dd' : 'MMM dd';
  return days.map(day => {
    const dayStr = format(day, fmt);
    const dl = leads.filter(l => {
      const d = leadEventInstant(l);
      if (!d) return false;
      return d >= new Date(day.getFullYear(), day.getMonth(), day.getDate()) &&
        d < new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    });
    return {
      date: dayStr,
      Total: dl.length,
      Sold: dl.filter(l => resolveLeadStatus(l) === LEAD_STATUS.SOLD).length,
      Disqualified: dl.filter(l => resolveLeadStatus(l) === LEAD_STATUS.DISQUALIFIED).length,
      // A stuck, still-processing lead (D4: the retired Error final_status
      // collapses into queued + processing_state failed), not a distinct
      // final outcome.
      Stuck: dl.filter(l => l.processing_state === 'failed').length,
    };
  });
}

// Per-supplier operational summary (no money) for anomaly context in AI insights.
export function supplierBreakdown(leads) {
  const names = [...new Set(leads.map(l => l.supplier_name).filter(Boolean))];
  return names.map(name => {
    const sl = leads.filter(l => l.supplier_name === name);
    const dq = sl.filter(l => resolveLeadStatus(l) === LEAD_STATUS.DISQUALIFIED).length;
    const err = sl.filter(l => l.processing_state === 'failed').length;
    return {
      supplier: name, total: sl.length,
      sold: sl.filter(l => resolveLeadStatus(l) === LEAD_STATUS.SOLD).length,
      disqualified: dq, errors: err,
      dq_rate: sl.length ? Math.round((dq / sl.length) * 100) : 0,
      error_rate: sl.length ? Math.round((err / sl.length) * 100) : 0,
    };
  }).sort((a, b) => b.total - a.total);
}

export function windowLengthDays(win) {
  return differenceInCalendarDays(win.end, win.start) + 1;
}