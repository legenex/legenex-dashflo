// Financial-truth aggregation for the main Overview dashboard.
// Reuses reconcile() / workbench() from financeMetrics so numbers match the Finances section.
import { reconcile, workbench, unmatched } from '@/lib/financeMetrics';
import { leadField, leadEventInstant, leadEventDayKey } from '@/lib/reportMetrics';
import { format, isWithinInterval, startOfDay, subDays } from 'date-fns';

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
const inWin = (d, win) => d && isWithinInterval(new Date(d), { start: win.start, end: win.end });

// The full financial picture for a period window.
export function financialTruth({ leads, buyers, suppliers, invoices, payments, payouts, adSpend, txns }, win) {
  const wLeads = leads.filter(l => {
    const t = leadEventInstant(l);
    return t instanceof Date && !isNaN(t.getTime()) && t >= win.start && t <= win.end;
  });

  const reconRows = reconcile({ leads: wLeads, buyers, suppliers, invoices, payments, payouts, adSpend });
  const wb = workbench(reconRows, invoices);

  // Revenue: booked (from leads) vs verified (matched income / payments received).
  const bookedRevenue = wLeads.reduce((a, l) => a + num(l.revenue), 0);
  const verifiedRevenue = payments.filter(p => inWin(p.paid_date, win)).reduce((a, p) => a + num(p.amount), 0);

  // Supplier cost: accrued (lead cost + tracked spend) vs paid (payout paid_amount).
  const accruedCost = wLeads.reduce((a, l) => a + num(l.cost), 0);
  const trackedSpend = adSpend.filter(a => inWin(a.date, win)).reduce((a, r) => a + num(r.spend), 0);
  const paidPayouts = payouts.reduce((a, p) => a + num(p.paid_amount), 0);

  // Ad spend: tracked (synced) vs paid (bank money-out categorised media).
  const paidSpend = txns.filter(t => t.category === 'media' && t.amount < 0).reduce((a, t) => a + Math.abs(num(t.amount)), 0);

  // Profit: reported (booked rev - accrued cost - tracked spend) vs cash (verified in - paid out).
  const reportedProfit = bookedRevenue - accruedCost - trackedSpend;
  const cashProfit = verifiedRevenue - paidPayouts - paidSpend;

  const kpis = {
    revenue: { headline: bookedRevenue, sub: verifiedRevenue, gap: bookedRevenue - verifiedRevenue },
    profit: { headline: reportedProfit, sub: cashProfit, gap: reportedProfit - cashProfit },
    adSpend: { headline: trackedSpend, sub: paidSpend, gap: trackedSpend - paidSpend },
    supplierCost: { headline: accruedCost + trackedSpend, sub: paidPayouts, gap: (accruedCost + trackedSpend) - paidPayouts },
  };

  // Small stat cards.
  const now = new Date();
  const in7 = invoices.filter(i => i.status !== 'paid' && i.status !== 'void' && i.period_end &&
    isWithinInterval(new Date(i.period_end), { start: now, end: subDays(now, -7) })).reduce((a, i) => a + num(i.amount), 0);
  const shortPaid = reconRows.filter(r => r.short > 0.01).reduce((a, r) => a + r.short, 0);
  const trueCpl = wLeads.length > 0 ? (paidSpend / wLeads.length) : 0;
  const cashMargin = verifiedRevenue > 0 ? Math.round((cashProfit / verifiedRevenue) * 100) : 0;
  const sourced = wLeads.filter(l => num(l.revenue) > 0).length;
  const dataQuality = wLeads.length > 0 ? Math.round((sourced / wLeads.length) * 100) : 100;

  const stats = {
    outstanding: bookedRevenue - verifiedRevenue,
    due7: in7,
    overdue: wb.overdue,
    shortPaid,
    trueCpl,
    cashMargin,
    dataQuality,
  };

  return { wLeads, reconRows, wb, kpis, stats, bookedRevenue, verifiedRevenue, trackedSpend };
}

// Action queue: open financial variances.
// Each item carries a label chip, counterparty, amount, and a one-line
// explanation of why it matters + what to do (the "AI-written" note).
export function actionQueue({ reconRows, wb }, txns) {
  const items = [];
  wb.openGaps.forEach(g => {
    const isBuyer = g.type === 'buyer';
    const short = g.short > 0;
    // Buyer owed but underpaid = payment overdue / short paid; supplier = cost gap.
    const label = isBuyer
      ? (short ? 'Payment overdue' : 'Short paid')
      : 'Supplier cost gap';
    items.push({
      key: `gap-${g.type}-${g.name}`,
      label,
      name: g.name,
      amount: Math.abs(g.short),
      note: `${g.name}: expected ${fmt(g.expected)}, settled ${fmt(g.paid)}`,
      why: isBuyer
        ? (short
          ? `${g.name} owes ${fmt(Math.abs(g.short))} against invoiced work — chase payment or issue a reminder.`
          : `${g.name} was overpaid by ${fmt(Math.abs(g.short))} — verify the deposit and apply a credit.`)
        : `Owed ${fmt(Math.abs(g.short))} to ${g.name} not yet cleared — schedule the payout to keep the source live.`,
    });
  });
  const unmatchedIn = unmatched(txns).filter(t => t.amount > 0);
  unmatchedIn.forEach(t => items.push({
    key: `unmatched-${t.id}`, label: 'Unmatched income', name: t.description || 'Bank deposit',
    amount: Math.abs(num(t.amount)),
    note: `${t.description || 'Bank deposit'} not matched to a buyer`,
    why: `${fmt(Math.abs(num(t.amount)))} landed in the bank but isn't tied to a buyer — match it so revenue is proven.`,
  }));
  reconRows.filter(r => r.type === 'buyer' && r.revenue > 0 && r.invoiced === 0).forEach(r => items.push({
    key: `missing-src-${r.name}`, label: 'Missing source', name: r.name, amount: r.revenue,
    note: `${r.name}: ${fmt(r.revenue)} booked with no invoice raised`,
    why: `${fmt(r.revenue)} booked from ${r.name} with no invoice behind it — raise one to make the revenue collectable.`,
  }));

  const totalAtRisk = items.reduce((a, i) => a + i.amount, 0);
  return { items: items.sort((a, b) => b.amount - a.amount), totalAtRisk };
}

// Leads-by-status donut (financial framing).
export function financeDonut(wLeads) {
  const by = (s) => wLeads.filter(l => l.final_status === s).length;
  const unmatchedLeads = wLeads.filter(l => !leadField(l, 'buyer_id')).length;
  return [
    { name: 'Sold', value: by('Sold'), color: '#22C55E' },
    { name: 'Duplicate', value: by('Duplicate'), color: '#64748B' },
    { name: 'Returned', value: by('Returned'), color: '#06B6D4' },
    { name: 'Unsold', value: by('Unsold'), color: '#F59E0B' },
    { name: 'Rejected', value: wLeads.filter(l => (l.leadbyte_record_status || '').toLowerCase() === 'rejected').length, color: '#EF4444' },
    { name: 'Error', value: by('Error'), color: '#DC2626' },
    { name: 'Unmatched', value: unmatchedLeads, color: '#A855F7' },
  ].filter(d => d.value > 0);
}

// Daily booked revenue vs verified income vs ad spend.
export function dailyFinance({ wLeads, payments, adSpend }, win) {
  const days = [];
  const spanDays = Math.min(60, Math.round((win.end - win.start) / 86400000) + 1);
  for (let i = spanDays - 1; i >= 0; i--) {
    const day = startOfDay(subDays(win.end, i));
    const next = subDays(win.end, i - 1);
    const dayStr = format(day, 'MMM dd');
    const booked = wLeads.filter(l => { const d = leadEventInstant(l); return d >= day && d < next; }).reduce((a, l) => a + num(l.revenue), 0);
    const verified = (payments || []).filter(p => { const d = p.paid_date ? new Date(p.paid_date) : null; return d && d >= day && d < next; }).reduce((a, p) => a + num(p.amount), 0);
    const spend = (adSpend || []).filter(a => { const d = a.date ? new Date(a.date) : null; return d && d >= day && d < next; }).reduce((a, r) => a + num(r.spend), 0);
    days.push({ date: dayStr, Booked: Math.round(booked), Verified: Math.round(verified), Spend: Math.round(spend) });
  }
  return days;
}

// Top campaigns by cash profit (estimated vs verified).
export function topCampaigns(wLeads) {
  const groups = {};
  for (const l of wLeads) {
    const key = leadField(l, 'campaign') || l.supplier_name || 'Unattributed';
    if (!groups[key]) groups[key] = { name: key, leads: 0, estimated: 0, verified: 0 };
    groups[key].leads += 1;
    groups[key].estimated += num(l.revenue) - num(l.cost);
    if (l.final_status === 'Sold') groups[key].verified += num(l.revenue) - num(l.cost);
  }
  return Object.values(groups)
    .map(g => ({
      ...g,
      tag: g.estimated <= 0 ? 'Cut' : g.verified / (g.estimated || 1) > 0.7 ? 'Scale' : 'Watch',
      // Reported profit with no verified income behind it.
      falseProfit: g.estimated > 0 && g.verified <= 0.01,
    }))
    .sort((a, b) => b.estimated - a.estimated)
    .slice(0, 6);
}

// Buyer payment risk rows.
export function buyerRisk(reconRows) {
  return reconRows.filter(r => r.type === 'buyer').map(r => {
    const out = r.invoiced - r.paid;
    const status = out > 0.01 ? (r.flag ? 'Overdue' : 'Outstanding') : r.short < -0.01 ? 'Overpaid' : 'Settled';
    return { name: r.name, booked: r.revenue, out, short: r.short, status };
  }).sort((a, b) => b.out - a.out);
}

function fmt(v) { return `$${num(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`; }
export { fmt as fmtMoney };