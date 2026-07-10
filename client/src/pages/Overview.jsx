import React, { useState, useMemo, useEffect } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import OverviewHeader from '@/components/overview/OverviewHeader';
import GroupedKpiCard from '@/components/overview/GroupedKpiCard';
import StatCard from '@/components/overview/StatCard';
import ActionQueueCard from '@/components/overview/ActionQueueCard';
import DataConfidenceCard from '@/components/overview/DataConfidenceCard';
import AiAnalystBand from '@/components/overview/AiAnalystBand';
import ActivityStreamBar from '@/components/overview/ActivityStreamBar';
import StatusStripBar from '@/components/overview/StatusStripBar';
import Reveal from '@/components/overview/Reveal';
import PanelSectionHeader from '@/components/overview/PanelSectionHeader';
import CountUpText from '@/components/overview/CountUpText';
import AnimatedPanel from '@/components/overview/AnimatedPanel';
import PipelineHealthStrip from '@/components/overview/PipelineHealthStrip';
import LeadVolumeByStatus from '@/components/overview/LeadVolumeByStatus';
import OverviewRejectionReasons from '@/components/overview/OverviewRejectionReasons';
import SupplierLeaderboard from '@/components/overview/SupplierLeaderboard';
import { Badge } from '@/components/ui/badge';
import {
  Bar, Line, ComposedChart, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  DollarSign, TrendingUp, Megaphone, Users, PieChart as PieIcon, Trophy, ShieldAlert, ArrowUpRight,
  CheckCircle2, AlertTriangle, Activity, GitBranch, BarChart3, ListFilter, Award,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { resolvePeriod, PERIOD_LABELS } from '@/lib/periodRange';
import {
  financialTruth, actionQueue, financeDonut, dailyFinance, topCampaigns, buyerRisk, fmtMoney,
} from '@/lib/overviewFinance';
import { money, int } from '@/lib/reportMetrics';
import useAiBriefing from '@/hooks/useAiBriefing';
import { toast } from 'sonner';

const CAMPAIGN_TAG_TONE = { Scale: 'status-sold-bg status-sold', Watch: 'status-warn-bg status-unsold', Cut: 'status-error-bg status-error' };
const RISK_TONE = {
  Overdue: 'status-error-bg status-error',
  Outstanding: 'status-warn-bg status-unsold',
  Overpaid: 'bg-status-duplicate status-duplicate',
  Settled: 'status-sold-bg status-sold',
};
// Buyer-risk status -> the label copy the command center uses.
const RISK_LABEL = { Overdue: 'Short Paid', Outstanding: 'No Payment Source', Overpaid: 'Overpaid', Settled: 'On Track' };

export default function Overview() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('this_month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [compare, setCompare] = useState(false);

  // "refreshed Xs ago" telemetry clock — resets whenever the user refreshes.
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const refreshedAgo = Math.max(0, Math.round((nowTick - refreshedAt) / 1000));

  // Force Sync: invoke a sync backend function on demand, then refresh queries.
  const runForceSync = async (fn, args, label) => {
    try {
      await api.functions.invoke(fn, args || {});
      toast.success(`${label} sync started`);
      qc.invalidateQueries();
      setRefreshedAt(Date.now());
    } catch {
      toast.error(`${label} sync failed`);
    }
  };

  const win = useMemo(() => resolvePeriod(period, custom), [period, custom]);

  const { data: leads = [] } = useQuery({ queryKey: ['ov-leads'], queryFn: () => api.entities.Lead.list('-created_date', 2000) });
  const { data: buyers = [] } = useQuery({ queryKey: ['buyers'], queryFn: () => api.entities.Buyer.list() });
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.entities.Supplier.list() });
  const { data: invoices = [] } = useQuery({ queryKey: ['all-invoices'], queryFn: () => api.entities.Invoice.list('-created_date', 500) });
  const { data: payments = [] } = useQuery({ queryKey: ['buyer-payments'], queryFn: () => api.entities.BuyerPayment.list('-paid_date', 500) });
  const { data: payouts = [] } = useQuery({ queryKey: ['supplier-payouts'], queryFn: () => api.entities.SupplierPayout.list('-created_date', 500) });
  const { data: adSpend = [] } = useQuery({ queryKey: ['adspend'], queryFn: () => api.entities.AdSpend.list('-date', 2000) });
  const { data: txns = [] } = useQuery({ queryKey: ['bank-txns'], queryFn: () => api.entities.BankTransaction.list('-date', 500) });
  const { data: errors = [] } = useQuery({ queryKey: ['ov-errors'], queryFn: () => api.entities.ErrorLog.list('-created_date', 500) });
  const { data: integrations = [] } = useQuery({ queryKey: ['integration-configs'], queryFn: () => api.entities.IntegrationConfig.list() });
  const { data: spendMappings = [] } = useQuery({ queryKey: ['adspend-mappings'], queryFn: () => api.entities.AdSpendMapping.list() });
  const { data: leadSources = [] } = useQuery({ queryKey: ['lead-sources'], queryFn: () => api.entities.LeadSource.list('-created_date', 100) });

  const dataset = { leads, buyers, suppliers, invoices, payments, payouts, adSpend, txns };

  const truth = useMemo(() => financialTruth(dataset, win), [leads, buyers, suppliers, invoices, payments, payouts, adSpend, txns, win]);
  const queue = useMemo(() => actionQueue(truth, txns), [truth, txns]);
  const donut = useMemo(() => financeDonut(truth.wLeads), [truth]);
  const daily = useMemo(() => dailyFinance({ wLeads: truth.wLeads, payments, adSpend }, win), [truth, payments, adSpend, win]);
  const campaigns = useMemo(() => topCampaigns(truth.wLeads), [truth]);
  const risk = useMemo(() => buyerRisk(truth.reconRows), [truth]);

  // Period-filtered leads for the lead-side widgets. Respects the same window
  // that drives the KPI cards; filters on created_date.
  const periodLeads = useMemo(
    () => leads.filter(l => l.created_date && new Date(l.created_date) >= win.start && new Date(l.created_date) <= win.end),
    [leads, win]
  );

  // Compare vs prior window of equal length.
  const priorTruth = useMemo(() => {
    if (!compare) return null;
    const len = win.end.getTime() - win.start.getTime();
    const prior = { start: new Date(win.start.getTime() - len), end: new Date(win.start.getTime()) };
    return financialTruth(dataset, prior);
  }, [compare, win, leads, buyers, suppliers, invoices, payments, payouts, adSpend, txns]);

  // Prior window (always) for the AI briefing context, independent of the Compare toggle.
  const briefPrior = useMemo(() => {
    const len = win.end.getTime() - win.start.getTime();
    const prior = { start: new Date(win.start.getTime() - len), end: new Date(win.start.getTime()) };
    return financialTruth(dataset, prior);
  }, [win, leads, buyers, suppliers, invoices, payments, payouts, adSpend, txns]);

  const cmpChip = (cur, prev) => {
    if (!compare || prev == null) return null;
    const d = prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 100);
    if (d == null) return null;
    return <span className={`ml-2 text-[11px] ${d >= 0 ? 'status-sold' : 'status-error'}`}>{d >= 0 ? '+' : ''}{d}%</span>;
  };

  const { kpis, stats } = truth;

  // ---- AI Analyst briefing summary (revenue-aware finance truth) ----
  const briefingSummary = useMemo(() => ({
    period: PERIOD_LABELS[period],
    revenue: { booked: Math.round(truth.bookedRevenue), verified: Math.round(truth.verifiedRevenue), gap: Math.round(kpis.revenue.gap) },
    profit: { reported: Math.round(kpis.profit.headline), cash: Math.round(kpis.profit.sub) },
    adSpend: { tracked: Math.round(kpis.adSpend.headline), paid: Math.round(kpis.adSpend.sub) },
    supplierCost: { accrued: Math.round(kpis.supplierCost.headline), paid: Math.round(kpis.supplierCost.sub) },
    outstanding: Math.round(stats.outstanding),
    overdue: Math.round(stats.overdue),
    totalAtRisk: Math.round(queue.totalAtRisk),
    topGaps: queue.items.slice(0, 4).map(i => ({ label: i.label, name: i.name, amount: Math.round(i.amount) })),
    topCampaigns: campaigns.slice(0, 3).map(c => ({ name: c.name, estimated: Math.round(c.estimated), verified: Math.round(c.verified), falseProfit: c.falseProfit })),
    leadCount: truth.wLeads.length,
    prior: { bookedRevenue: Math.round(briefPrior.bookedRevenue), reportedProfit: Math.round(briefPrior.kpis.profit.headline), totalAtRisk: Math.round(actionQueue(briefPrior, txns).totalAtRisk) },
  }), [truth, kpis, stats, queue, campaigns, briefPrior, period, txns]);

  // Signature ensures we only regenerate the briefing when the numbers actually change.
  const briefSignature = useMemo(() => JSON.stringify([
    period, Math.round(truth.bookedRevenue), Math.round(truth.verifiedRevenue), Math.round(queue.totalAtRisk), truth.wLeads.length,
  ]), [period, truth, queue]);

  const briefing = useAiBriefing(briefingSummary, briefSignature);

  // ---- Data confidence sources ----
  const cfg = (name) => {
    const rec = integrations.find(i => i.name === name);
    if (!rec) return null;
    try { return JSON.parse(rec.config || '{}').last_synced_at || null; } catch { return null; }
  };
  const newest = (arr, field) => arr.reduce((max, r) => {
    const v = r[field] ? new Date(r[field]).getTime() : 0;
    return v > max ? v : max;
  }, 0);
  const platSync = (plat) => spendMappings.filter(m => m.platform === plat).reduce((m, r) => Math.max(m, r.last_synced_at ? new Date(r.last_synced_at).getTime() : 0), 0);
  const leadSync = newest(leads.slice(0, 5), 'created_date');

  const confidenceSources = [
    { label: 'Lead ingestion', at: leadSync || null },
    { label: 'Stripe', at: cfg('stripe') },
    { label: 'Xero', at: cfg('xero') },
    { label: 'Mercury', at: cfg('mercury'), onSync: () => runForceSync('syncMercury', {}, 'Mercury') },
    { label: 'Meta Ads', at: platSync('meta') || null, onSync: () => runForceSync('syncMetaSpend', {}, 'Meta Ads') },
    { label: 'Buyer feedback', at: newest(payments, 'paid_date') || null },
    { label: 'Google Ads', at: platSync('google_ads') || null },
    { label: 'TikTok', at: platSync('tiktok') || null },
    { label: 'Supplier statements', at: newest(payouts, 'updated_date') || null },
    { label: 'Slack', at: cfg('slack') },
    ...leadSources.filter(s => s.enabled).map(s => ({
      label: s.name,
      at: s.last_synced_at || null,
      onSync: s.kind === 'google_sheets' ? () => runForceSync('syncGoogleSheets', { sourceId: s.id }, s.name) : undefined,
    })),
  ];

  // ---- Live activity stream chips ----
  const activityEvents = useMemo(() => {
    const ev = [];
    const lastPay = payments[0];
    if (lastPay) ev.push({ id: 'pay', tone: 'green', text: `Payment matched — ${lastPay.buyer_name || 'buyer'} ${fmtMoney(lastPay.amount)}` });
    if (queue.items[0]) ev.push({ id: 'gap', tone: 'amber', text: `Action item open — ${queue.items[0].label} · ${queue.items[0].name}` });
    const lastLead = leads[0];
    if (lastLead) ev.push({ id: 'lead', tone: 'blue', text: `New lead in — ${lastLead.supplier_name || 'source'} · ${lastLead.final_status || 'processing'}` });
    if (errors[0]) ev.push({ id: 'err', tone: 'red', text: `Error logged — ${errors[0].stage}: ${errors[0].message}` });
    if (ev.length === 0) ev.push({ id: 'idle', tone: 'green', text: 'All systems nominal — no new events' });
    return ev;
  }, [payments, queue, leads, errors]);

  // ---- Bottom status strip ----
  const lastLeadAt = leads[0]?.created_date;
  const errorsToday = errors.filter(e => {
    const d = e.created_date ? new Date(e.created_date) : null;
    return d && (Date.now() - d.getTime()) < 86400000;
  }).length;
  const unmatchedIncome = txns.filter(t => !t.matched_entity_type && t.amount > 0).reduce((a, t) => a + Math.abs(Number(t.amount) || 0), 0);
  const matchQueueDepth = txns.filter(t => !t.matched_entity_type).length;

  const stripItems = [
    { label: 'Ingest endpoint', value: 'Live', tone: 'good', dot: true },
    { label: 'Last lead', value: lastLeadAt ? formatDistanceToNow(new Date(lastLeadAt), { addSuffix: true }) : '—', tone: 'neutral' },
    { label: 'Errors today', count: errorsToday, render: (n) => int(Math.round(n)), tone: errorsToday > 0 ? 'bad' : 'good' },
    { label: 'Match queue', count: matchQueueDepth, render: (n) => int(Math.round(n)), tone: matchQueueDepth > 0 ? 'warn' : 'good' },
    { label: 'Open variances', count: queue.items.length, render: (n) => int(Math.round(n)), tone: queue.items.length > 0 ? 'warn' : 'good' },
    { label: 'Unmatched income', count: unmatchedIncome, render: (n) => fmtMoney(n), tone: unmatchedIncome > 0 ? 'warn' : 'good' },
  ];

  // ---- Header / AI band derived values ----
  const feedCount = confidenceSources.length;
  const verifiedFeeds = confidenceSources.filter(s => s.at && (Date.now() - new Date(s.at).getTime()) < 86400000).length;
  const analystConfidence = Math.round(stats.dataQuality || 0);
  const totalAtRisk = queue.totalAtRisk || 0;
  const riskLevel = totalAtRisk > 5000 ? 'Elevated' : totalAtRisk > 0 ? 'Watch' : verifiedFeeds < feedCount / 2 ? 'Watch' : 'Clear';
  const riskNote = totalAtRisk > 0 ? `${fmtMoney(totalAtRisk)} at risk` : 'stale ingestion';
  const topRecommendation = queue.items[0]
    ? `Resolve ${queue.items[0].label} — ${queue.items[0].name} (${fmtMoney(queue.items[0].amount)}) before it ages further.`
    : 'Verify booked revenue against cash before scaling any campaign.';

  // Per-KPI sparkline series pulled from the daily finance series.
  const kpiSpark = {
    revenue: daily.map(d => d.Verified ?? 0),
    profit: daily.map(d => (d.Verified ?? 0) - (d.Spend ?? 0)),
    adSpend: daily.map(d => d.Spend ?? 0),
    supplierCost: daily.map(d => (d.Booked ?? 0) * 0.4),
  };

  // Delta vs prior window per KPI (independent of Compare toggle, using briefPrior).
  const deltaPct = (cur, prev) => {
    if (prev == null || prev === 0) return 0;
    return ((cur - prev) / Math.abs(prev)) * 100;
  };
  const kpiDelta = {
    revenue: deltaPct(kpis.revenue.headline, briefPrior.kpis.revenue.headline),
    profit: deltaPct(kpis.profit.headline, briefPrior.kpis.profit.headline),
    adSpend: deltaPct(kpis.adSpend.headline, briefPrior.kpis.adSpend.headline),
    supplierCost: deltaPct(kpis.supplierCost.headline, briefPrior.kpis.supplierCost.headline),
  };

  const KPI_NOTES = {
    revenue: 'Awaiting booked events',
    profit: 'Margin not computable',
    adSpend: 'No platform sync',
    supplierCost: 'No statements ingested',
  };

  // Right-aligned meta chips for the lower panel section headers.
  const buyerExposure = risk.reduce((a, r) => a + (r.out > 0.01 ? r.out : r.short || 0), 0);
  const donutMeta = PERIOD_LABELS[period];
  const campaignsMeta = 'All campaigns';
  const buyerRiskMeta = `${fmtMoney(buyerExposure)} exposure`;

  // Framer-motion staggered rise variants for card grids.
  const gridVariants = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
  const itemVariants = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
  };

  return (
    <div>
      <ActivityStreamBar events={activityEvents} />

      <OverviewHeader
        period={period}
        onPeriodChange={setPeriod}
        custom={custom}
        onCustomChange={setCustom}
        compare={compare}
        onToggleCompare={() => setCompare(c => !c)}
        onRefresh={() => { qc.invalidateQueries(); setRefreshedAt(Date.now()); }}
      />

      {/* AI Analyst summary band */}
      <Reveal>
        <AnimatedPanel>
          <AiAnalystBand
            text={briefing.text}
            loading={briefing.loading}
            error={briefing.error}
            onRefresh={briefing.refresh}
            confidence={analystConfidence}
            riskLevel={riskLevel}
            riskNote={riskNote}
            topRecommendation={topRecommendation}
            feedCount={feedCount}
          />
        </AnimatedPanel>
      </Reveal>

      {/* Grouped KPI cards */}
      <motion.div variants={gridVariants} initial="hidden" animate="show" className="grid grid-cols-2 xl:grid-cols-4 gap-4 mt-4">
        {[
          { key: 'revenue', label: 'Revenue', subLabel: 'Verified', icon: DollarSign, cmp: 'Booked' },
          { key: 'profit', label: 'Profit', subLabel: 'Cash', icon: TrendingUp, cmp: 'Reported' },
          { key: 'adSpend', label: 'Ad Spend', subLabel: 'Paid', icon: Megaphone, cmp: 'Tracked' },
          { key: 'supplierCost', label: 'Supplier Cost', subLabel: 'Paid', icon: Users, cmp: 'Accrued' },
        ].map((c) => (
          <motion.div key={c.key} variants={itemVariants}>
            <GroupedKpiCard
              label={c.label}
              headline={kpis[c.key].headline}
              subLabel={c.subLabel}
              sub={kpis[c.key].sub}
              gap={kpis[c.key].gap}
              icon={c.icon}
              delta={kpiDelta[c.key]}
              spark={kpiSpark[c.key]}
              note={KPI_NOTES[c.key]}
            />
            {compare && <div className="text-[11px] text-muted-foreground mt-1 px-1">{c.cmp} {cmpChip(kpis[c.key].headline, priorTruth?.kpis[c.key].headline)}</div>}
          </motion.div>
        ))}
      </motion.div>

      {/* Small stat cards */}
      <motion.div variants={gridVariants} initial="hidden" animate="show" className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mt-4">
        {[
          { label: 'Outstanding', count: stats.outstanding, render: (n) => money(n), note: 'no invoices open', tone: stats.outstanding > 0 ? 'warn' : 'good' },
          { label: 'Due 7 Days', count: stats.due7, render: (n) => money(n), note: 'nothing maturing', tone: stats.due7 > 0 ? 'warn' : 'good' },
          { label: 'Overdue', count: stats.overdue, render: (n) => money(n), note: 'clean', tone: stats.overdue > 0 ? 'bad' : 'good' },
          { label: 'Short-Paid', count: stats.shortPaid, render: (n) => money(n), note: 'clean', tone: stats.shortPaid > 0 ? 'bad' : 'good' },
          { label: 'True CPL', count: stats.trueCpl, render: (n) => money(n), note: 'no spend basis', tone: 'neutral' },
          { label: 'Cash Margin', count: stats.cashMargin, render: (n) => `${Math.round(n)}%`, note: 'no cash flow', tone: stats.cashMargin > 0 ? 'good' : 'neutral' },
          { label: 'Data Quality', count: stats.dataQuality, render: (n) => `${Math.round(n)}/100`, note: 'unverified, feeds stale', tone: stats.dataQuality >= 80 ? 'good' : stats.dataQuality >= 50 ? 'warn' : 'bad' },
        ].map((s) => (
          <motion.div key={s.label} variants={itemVariants}>
            <StatCard label={s.label} count={s.count} render={s.render} note={s.note} dotTone={s.tone} />
          </motion.div>
        ))}
      </motion.div>

      {/* Lead-side widgets */}
      <Reveal delay={0.05} className="mt-6 block">
        <AnimatedPanel duration={6.2}>
          <div className="overflow-hidden">
            <PanelSectionHeader icon={GitBranch} title="Pipeline Health" meta={PERIOD_LABELS[period]} />
            <PipelineHealthStrip leads={periodLeads} />
          </div>
        </AnimatedPanel>
      </Reveal>

      <Reveal delay={0.05} className="mt-4 block">
        <AnimatedPanel duration={6.5}>
          <div className="overflow-hidden">
            <PanelSectionHeader icon={BarChart3} title="Lead Volume by Status" meta={PERIOD_LABELS[period]} />
            <LeadVolumeByStatus leads={periodLeads} />
          </div>
        </AnimatedPanel>
      </Reveal>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Reveal delay={0.05}>
          <AnimatedPanel duration={6.2}>
            <div className="overflow-hidden">
              <PanelSectionHeader icon={ListFilter} title="Top Rejection Reasons" meta={PERIOD_LABELS[period]} />
              <OverviewRejectionReasons leads={periodLeads} />
            </div>
          </AnimatedPanel>
        </Reveal>

        <Reveal delay={0.1}>
          <AnimatedPanel duration={5.8}>
            <div className="overflow-hidden">
              <PanelSectionHeader icon={Award} title="Supplier Leaderboard" meta={PERIOD_LABELS[period]} />
              <SupplierLeaderboard leads={periodLeads} />
            </div>
          </AnimatedPanel>
        </Reveal>
      </div>

      {/* Daily finance chart */}
      <Reveal delay={0.05} className="mt-6 block">
        <AnimatedPanel duration={6.5}>
          <div className="p-5">
            <div className="text-[13px] font-semibold text-foreground mb-1">Booked Revenue vs Verified Income vs Ad Spend</div>
            <div className="text-[11px] text-muted-foreground mb-4">The distance between the booked bars and the verified line is money booked but not yet proven.</div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={daily}>
                <XAxis dataKey="date" tick={{ fill: '#8B95A8', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fill: '#8B95A8', fontSize: 11 }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ backgroundColor: '#182030', border: '1px solid #243044', borderRadius: '8px', fontSize: 12 }} labelStyle={{ color: '#EEF2F8' }} formatter={(v) => fmtMoney(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Booked" fill="#E5484D" radius={[3, 3, 0, 0]} maxBarSize={22} animationDuration={800} />
                <Line dataKey="Verified" stroke="#3DD68C" strokeWidth={2} dot={false} animationDuration={900} />
                <Line dataKey="Spend" stroke="#8B95A8" strokeWidth={2} strokeDasharray="4 3" dot={false} animationDuration={900} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </AnimatedPanel>
      </Reveal>

      {/* Action queue */}
      <Reveal delay={0.05} className="mt-4 block">
        <AnimatedPanel>
          <ActionQueueCard
            queue={queue}
            onResolve={(item) => {
              if (item.label === 'Unmatched income') navigate('/finances?tab=bank');
              else if (item.label === 'Missing source') navigate('/finances?tab=invoices');
              else if (item.label === 'Payment overdue' || item.label === 'Short paid') navigate('/finances?tab=payments');
              else if (item.label === 'Supplier cost gap') navigate('/finances?tab=payouts');
              else navigate('/finances');
            }}
            onDone={(item) => toast.success(`Marked done: ${item.label}`)}
          />
        </AnimatedPanel>
      </Reveal>

      {/* Reconciliation status callout */}
      <Reveal delay={0.05} className="mt-4 block">
        <AnimatedPanel glow={queue.items.length === 0 ? '#3DD68C' : '#E5484D'} duration={6.5}>
          {queue.items.length === 0 ? (
            <div className="border border-[#3DD68C]/40 bg-[#3DD68C]/10 px-5 py-4 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 status-sold shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-foreground">Everything reconciles, no open variances.</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">The bigger risk is not variance. It is missing or stale data ingestion.</div>
              </div>
              <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md status-sold-bg status-sold shrink-0">Clean</span>
            </div>
          ) : (
            <div className="border border-primary/40 bg-primary/10 px-5 py-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-foreground">{queue.items.length} open {queue.items.length === 1 ? 'variance' : 'variances'} need attention.</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{queue.items.slice(0, 3).map(i => `${i.label} · ${i.name || i.note}`).join('  ·  ')}</div>
              </div>
              <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md status-error-bg status-error shrink-0 whitespace-nowrap">
                <CountUpText value={queue.totalAtRisk} render={(n) => fmtMoney(n)} /> at risk
              </span>
            </div>
          )}
        </AnimatedPanel>
      </Reveal>

      {/* Row 1: Leads by Status + Top Campaigns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Reveal delay={0.05}>
          <AnimatedPanel duration={6.2}>
            <div className="overflow-hidden">
              <PanelSectionHeader icon={PieIcon} title="Leads by Status" meta={donutMeta} />
              <div className="p-5">
                {donut.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={donut} cx="50%" cy="50%" innerRadius={52} outerRadius={78} dataKey="value" stroke="none" animationDuration={900} animationBegin={150} paddingAngle={2}>
                          {donut.map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: '#182030', border: '1px solid #243044', borderRadius: '8px', fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-2">
                      {donut.map(d => (
                        <div key={d.name} className="flex items-center gap-1.5 text-[11px]">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                          <span className="text-muted-foreground">{d.name} (<CountUpText value={d.value} render={(n) => int(Math.round(n))} />)</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="h-[220px] flex flex-col items-center justify-center text-center gap-1.5 px-4">
                    <PieIcon className="w-7 h-7 text-muted-foreground/50" />
                    <div className="text-[13px] text-muted-foreground">No leads in period</div>
                    <div className="text-[11px] text-muted-foreground/70 max-w-[300px]">Likely cause: Leadbyte ingestion has never synced. Distribution and status counts depend on it.</div>
                    <Link to="/payload-tester" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline mt-1">Run Payload Tester <ArrowUpRight className="w-3 h-3" /></Link>
                  </div>
                )}
              </div>
            </div>
          </AnimatedPanel>
        </Reveal>

        <Reveal delay={0.1}>
          <AnimatedPanel duration={5.8}>
            <div className="overflow-hidden">
              <PanelSectionHeader icon={Trophy} title="Top Campaigns by Cash Profit" meta={campaignsMeta} />
              {campaigns.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider bg-muted/40">
                      <th className="text-left px-4 py-2.5">Campaign</th><th className="text-right px-4 py-2.5">Leads</th>
                      <th className="text-right px-4 py-2.5">Estimated</th><th className="text-right px-4 py-2.5">Verified</th><th className="text-center px-4 py-2.5">Action</th>
                    </tr></thead>
                    <motion.tbody variants={gridVariants} initial="hidden" animate="show" className="divide-y divide-border">
                      {campaigns.map(c => (
                        <motion.tr key={c.name} variants={itemVariants} className="hover:bg-accent/30">
                          <td className="px-4 py-2.5 text-foreground truncate max-w-[200px]">
                            <div className="flex items-center gap-2">
                              <span className="truncate">{c.name}</span>
                              {c.falseProfit && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded status-error-bg status-error whitespace-nowrap">FALSE PROFIT</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono">{int(c.leads)}</td>
                          <td className="px-4 py-2.5 text-right font-mono"><CountUpText value={c.estimated} render={(n) => money(n)} /></td>
                          <td className={`px-4 py-2.5 text-right font-mono ${c.verified > 0 ? 'status-sold' : 'text-muted-foreground'}`}><CountUpText value={c.verified} render={(n) => money(n)} /></td>
                          <td className="px-4 py-2.5 text-center"><Badge variant="outline" className={`text-[10px] border-0 ${CAMPAIGN_TAG_TONE[c.tag]}`}>{c.tag}</Badge></td>
                        </motion.tr>
                      ))}
                    </motion.tbody>
                  </table>
                </div>
              ) : (
                <div className="h-[220px] flex flex-col items-center justify-center text-center gap-1.5 p-5">
                  <Trophy className="w-7 h-7 text-muted-foreground/50" />
                  <div className="text-[13px] text-muted-foreground">No campaign economics yet</div>
                  <div className="text-[11px] text-muted-foreground/70 max-w-[320px]">Profitability needs three feeds: leads in, buyer revenue booked, and ad spend. All three are currently silent.</div>
                  <Link to="/settings?tab=integrations" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline mt-1">Connect ad platforms <ArrowUpRight className="w-3 h-3" /></Link>
                </div>
              )}
            </div>
          </AnimatedPanel>
        </Reveal>
      </div>

      {/* Row 2: Buyer Payment Risk + Data Confidence */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Reveal delay={0.05}>
          <AnimatedPanel duration={6.8}>
            <div className="overflow-hidden">
              <PanelSectionHeader icon={ShieldAlert} title="Buyer Payment Risk" meta={buyerRiskMeta} />
              {risk.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider bg-muted/40">
                      <th className="text-left px-4 py-2.5">Buyer</th><th className="text-right px-4 py-2.5">Booked</th>
                      <th className="text-right px-4 py-2.5">Out / Short</th><th className="text-center px-4 py-2.5">Status</th>
                    </tr></thead>
                    <motion.tbody variants={gridVariants} initial="hidden" animate="show" className="divide-y divide-border">
                      {risk.map(r => (
                        <motion.tr key={r.name} variants={itemVariants} className="hover:bg-accent/30">
                          <td className="px-4 py-2.5 text-foreground truncate max-w-[160px]">{r.name}</td>
                          <td className="px-4 py-2.5 text-right font-mono"><CountUpText value={r.booked} render={(n) => money(n)} /></td>
                          <td className="px-4 py-2.5 text-right font-mono"><CountUpText value={r.out > 0.01 ? r.out : r.short} render={(n) => money(n)} /></td>
                          <td className="px-4 py-2.5 text-center"><Badge variant="outline" className={`text-[10px] border-0 ${RISK_TONE[r.status]}`}>{RISK_LABEL[r.status] || r.status}</Badge></td>
                        </motion.tr>
                      ))}
                    </motion.tbody>
                  </table>
                </div>
              ) : (
                <div className="h-[220px] flex flex-col items-center justify-center text-center gap-1.5 p-5">
                  <ShieldAlert className="w-7 h-7 text-muted-foreground/50" />
                  <div className="text-[13px] text-muted-foreground">No buyer exposure detected</div>
                  <div className="text-[11px] text-muted-foreground/70 max-w-[300px]">No buyer exposure detected for selected period.</div>
                </div>
              )}
            </div>
          </AnimatedPanel>
        </Reveal>

        <Reveal delay={0.1}>
          <AnimatedPanel duration={6.4}>
            <DataConfidenceCard sources={confidenceSources} />
          </AnimatedPanel>
        </Reveal>
      </div>

      {/* Bottom system telemetry strip */}
      <Reveal delay={0.05} className="mt-6 mb-2 block">
        <div className="flex items-center justify-between px-1 mb-2">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.18em] flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-primary" /> System Telemetry
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">refreshed {refreshedAgo}s ago</div>
        </div>
        <AnimatedPanel duration={7}>
          <StatusStripBar items={stripItems} />
        </AnimatedPanel>
      </Reveal>
    </div>
  );
}