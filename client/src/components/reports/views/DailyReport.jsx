import React, { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { dailySeries, applyFilters, money } from '@/lib/reportMetrics';
import { ReportKpi, THead, TRow, AINote } from '@/components/reports/reportViewAtoms';

const TEMPLATE = '1.3fr repeat(6, 1fr)';
const COLS = ['Date', 'Leads', 'Sold', 'Revenue', 'Cost', 'Spend', 'Profit'];

function fmtDay(key) {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

export default function DailyReport({ leads, adSpend, filters }) {
  const rows = useMemo(
    () => dailySeries(applyFilters(leads, filters), adSpend, 14),
    [leads, adSpend, filters]
  );

  const stats = useMemo(() => {
    const n = rows.length || 1;
    const totalLeads = rows.reduce((a, r) => a + r.leads, 0);
    const totalSold = rows.reduce((a, r) => a + r.sold, 0);
    const totalProfit = rows.reduce((a, r) => a + r.profit, 0);
    const activeCount = rows.filter(r => r.leads > 0).length;
    const silent = rows.length - activeCount;
    const best = rows.reduce((b, r) => (r.leads > (b?.leads ?? -1) ? r : b), null);
    return {
      totalLeads, totalSold, totalProfit, activeCount, silent,
      avgLeads: totalLeads / n,
      avgProfit: totalProfit / n,
      best,
    };
  }, [rows]);

  const bestDate = stats.best ? fmtDay(stats.best.date) : '-';
  const bestLeads = stats.best?.leads ?? 0;

  const exportCsv = () => {
    const header = COLS.join(',');
    const lines = [...rows].reverse().map(r =>
      [fmtDay(r.date), r.leads, r.sold, r.revenue.toFixed(2), r.cost.toFixed(2), r.spend.toFixed(2), r.profit.toFixed(2)].join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'daily-metrics.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <ReportKpi
          label="Best Day"
          value={bestDate}
          hint={`${bestLeads} leads${stats.activeCount === 1 ? ' - only active day' : ''}`}
        />
        <ReportKpi
          label="Daily Avg Leads"
          value={stats.avgLeads.toFixed(2)}
          hint="last 14 days"
        />
        <ReportKpi
          label="Active Days"
          value={`${stats.activeCount}/${rows.length}`}
          tone={stats.activeCount * 2 < rows.length ? 'risk' : undefined}
          hint={`${stats.silent} silent days`}
        />
        <ReportKpi
          label="Daily Avg Profit"
          value={money(stats.avgProfit)}
          tone={stats.avgProfit > 0 ? 'good' : undefined}
          hint={stats.totalSold === 0 ? 'no sold leads' : undefined}
        />
      </div>

      <AINote>
        {`${stats.silent} of ${rows.length} days are silent; ${bestDate} is the latest ingestion signal.`}
      </AINote>

      <div className="rounded-xl border border-border bg-card shadow-[0_12px_32px_-16px_rgba(0,0,0,0.35)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-[13px] font-semibold text-foreground">Daily Metrics</h3>
          <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1.5 h-7 text-[11px]">
            <Download className="w-3 h-3" /> Export
          </Button>
        </div>
        <THead cols={COLS} template={TEMPLATE} />
        <div className="max-h-[520px] overflow-y-auto">
          {[...rows].reverse().map((r) => (
            <TRow
              key={r.date}
              template={TEMPLATE}
              highlight={r.leads > 0}
              cells={[
                <span key="d" className="flex items-center gap-2">
                  {fmtDay(r.date)}
                  {r.leads > 0 && (
                    <span className="text-[8.5px] font-semibold tracking-[0.08em] uppercase px-1.5 py-0.5 rounded"
                      style={{ color: '#3DD68C', background: 'rgba(61,214,140,0.12)' }}>active</span>
                  )}
                </span>,
                r.leads,
                r.sold,
                money(r.revenue),
                money(r.cost),
                money(r.spend),
                money(r.profit),
              ]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}