import React, { useState } from 'react';
import WidgetShell from './WidgetShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Filter, Columns3 } from 'lucide-react';
import { Bar, Line, Area, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, CartesianGrid } from 'recharts';
import { money, moneyShort, pct, int, dailySeries, groupBy, statusBreakdown } from '@/lib/reportMetrics';
import { downloadCsv } from '@/lib/csv';

const DONUT_COLORS = ['#3DD68C', '#E5484D', '#FACC14', '#3182BD', '#7564CC', '#41D9C7', '#EC4899'];

// Recharts reads computed CSS colors, so resolve the theme tokens to their live hsl() values.
const cssVar = (name, fallback) => {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `hsl(${v})` : fallback;
};

// Table column definitions per group widget type.
const TABLE_DEFS = {
  campaigns: { title: 'Top Campaigns', field: 'campaign', label: 'Campaign' },
  states: { title: 'State Performance', field: 'state', label: 'State' },
  buyers: { title: 'Buyers Performance', field: 'buyer_id', label: 'Buyer' },
  suppliers: { title: 'Suppliers Performance', field: 'supplier_name', label: 'Supplier' },
  utm_source: { title: 'UTM Source', field: 'utm_source', label: 'Source' },
  buyer_feedback: { title: 'Buyer Feedback', field: 'buyer_feedback', label: 'Disposition' },
  injury_type: { title: 'Injury Type', field: 'injury_type', label: 'Injury Type' },
  accident_date: { title: 'Accident Date', field: 'accident_date', label: 'Accident Date' },
  treatment_time: { title: 'Treatment Time', field: 'treatment_time', label: 'Treatment Time' },
  phone_verification: { title: 'Phone Verification', field: 'hlr_status', label: 'Verification' },
};

const GROUP_COLUMNS = [
  { key: 'leads', label: 'Leads', fmt: int },
  { key: 'sold', label: 'Sold', fmt: int },
  { key: 'convRate', label: 'Conv %', fmt: pct },
  { key: 'revenue', label: 'Revenue', fmt: money },
  { key: 'cost', label: 'Cost', fmt: money },
  { key: 'cpl', label: 'CPL', fmt: money },
  { key: 'profit', label: 'Profit', fmt: money },
];

function GroupTable({ def, leads, adSpend, widget, onChange }) {
  const [q, setQ] = useState('');
  const rows = groupBy(leads, def.field, adSpend).filter(r => !q || r.key.toLowerCase().includes(q.toLowerCase()));
  const hidden = widget.hiddenCols || [];
  const cols = GROUP_COLUMNS.filter(c => !hidden.includes(c.key));

  const toggleCol = (key) => {
    const next = hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key];
    onChange({ ...widget, hiddenCols: next });
  };
  const doExport = () => {
    downloadCsv(def.title, [{ key: 'key', label: def.label }, ...cols.map(c => ({ key: c.key, label: c.label }))], rows);
  };

  return (
    <WidgetShell
      title={def.title}
      wide={widget.wide}
      onToggleWide={() => onChange({ ...widget, wide: !widget.wide })}
      onExport={doExport}
      onDuplicate={widget.onDuplicate}
      onRemove={widget.onRemove}
      onMoveLeft={widget.onMoveLeft}
      onMoveRight={widget.onMoveRight}
      filterSlot={
        <Popover>
          <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-7 px-2 gap-1 text-[11px] text-muted-foreground"><Filter className="w-3.5 h-3.5" /> Filter</Button></PopoverTrigger>
          <PopoverContent className="w-56 p-2 bg-popover border-border" align="end">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${def.label.toLowerCase()}…`} className="h-8 bg-background text-[12px]" />
          </PopoverContent>
        </Popover>
      }
      columnsSlot={
        <Popover>
          <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-7 px-2 gap-1 text-[11px] text-muted-foreground"><Columns3 className="w-3.5 h-3.5" /> Columns</Button></PopoverTrigger>
          <PopoverContent className="w-48 p-2 bg-popover border-border" align="end">
            {GROUP_COLUMNS.map(c => (
              <label key={c.key} className="flex items-center gap-2 px-1 py-1.5 text-[13px] cursor-pointer">
                <Checkbox checked={!hidden.includes(c.key)} onCheckedChange={() => toggleCol(c.key)} /> {c.label}
              </label>
            ))}
          </PopoverContent>
        </Popover>
      }
    >
      <div className="overflow-x-auto max-h-[320px]">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-background/40 backdrop-blur">
            <tr className="border-b border-border/60 text-[9.5px] font-semibold text-muted-foreground/70 uppercase tracking-[0.1em]">
              <th className="text-left py-2.5 pr-2">{def.label}</th>
              {cols.map(c => <th key={c.key} className="text-right py-2.5 px-2">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="py-8 text-center text-muted-foreground">No data</td></tr>}
            {rows.slice(0, 100).map(r => (
              <tr key={r.key} className="border-b border-border/60 hover:bg-accent/40 transition-colors">
                <td className="py-2.5 pr-2 font-semibold text-foreground truncate max-w-[180px]">{r.key}</td>
                {cols.map(c => <td key={c.key} className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{c.fmt(r[c.key])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetShell>
  );
}

// Main dispatcher for a widget by type.
export default function ReportWidget({ widget, leads, adSpend, onChange }) {
  const type = widget.type;

  if (type === 'rev_spend_profit') {
    const data = dailySeries(leads, adSpend, 14);
    return (
      <WidgetShell title="Revenue vs Spend vs Profit" wide={widget.wide !== false}
        onToggleWide={() => onChange({ ...widget, wide: widget.wide === false })}
        onExport={() => downloadCsv('revenue_spend_profit', [
          { key: 'date', label: 'Date' }, { key: 'revenue', label: 'Revenue' }, { key: 'spend', label: 'Spend' }, { key: 'profit', label: 'Profit' },
        ], data)}
        onDuplicate={widget.onDuplicate} onRemove={widget.onRemove} onMoveLeft={widget.onMoveLeft} onMoveRight={widget.onMoveRight}>
        <div className="relative">
          <div className="absolute inset-0 pointer-events-none opacity-40"
            style={{ backgroundImage: 'linear-gradient(hsl(var(--border)/0.18) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.18) 1px, transparent 1px)', backgroundSize: '48px 44px' }} />
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="repRevFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={cssVar('--primary', '#E5484D')} stopOpacity="0.25" />
                  <stop offset="100%" stopColor={cssVar('--primary', '#E5484D')} stopOpacity="0" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: 'hsl(var(--muted-foreground))' }} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} tickFormatter={d => d.slice(5)} />
              <YAxis tick={{ fontSize: 10.5, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={moneyShort} width={48} />
              <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 10, fontSize: 12 }} formatter={v => money(v)} />
              <Area type="monotone" dataKey="revenue" stroke={cssVar('--primary', '#E5484D')} strokeWidth={1.5} fill="url(#repRevFill)" name="Revenue" />
              <Line type="monotone" dataKey="profit" stroke="#3DD68C" strokeWidth={1.5} dot={false} name="Profit" />
              <Line type="monotone" dataKey="spend" stroke="#8B95A8" strokeWidth={1.2} strokeDasharray="5 4" dot={false} name="Spend" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </WidgetShell>
    );
  }

  if (type === 'status_donut') {
    const data = statusBreakdown(leads);
    return (
      <WidgetShell title="Leads by Status" wide={widget.wide}
        onToggleWide={() => onChange({ ...widget, wide: !widget.wide })}
        onExport={() => downloadCsv('leads_by_status', [{ key: 'name', label: 'Status' }, { key: 'value', label: 'Count' }], data)}
        onDuplicate={widget.onDuplicate} onRemove={widget.onRemove} onMoveLeft={widget.onMoveLeft} onMoveRight={widget.onMoveRight}>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
              {data.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center">
          {data.map((d, i) => (
            <span key={d.name} className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="w-2 h-2 rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} /> {d.name} ({d.value})
            </span>
          ))}
        </div>
      </WidgetShell>
    );
  }

  if (type === 'daily_metrics') {
    const data = dailySeries(leads, adSpend, 30).reverse();
    return (
      <WidgetShell title="Daily Metrics" wide={widget.wide !== false}
        onToggleWide={() => onChange({ ...widget, wide: widget.wide === false })}
        onExport={() => downloadCsv('daily_metrics', [
          { key: 'date', label: 'Date' }, { key: 'leads', label: 'Leads' }, { key: 'sold', label: 'Sold' },
          { key: 'revenue', label: 'Revenue' }, { key: 'cost', label: 'Cost' }, { key: 'spend', label: 'Spend' }, { key: 'profit', label: 'Profit' },
        ], data)}
        onDuplicate={widget.onDuplicate} onRemove={widget.onRemove} onMoveLeft={widget.onMoveLeft} onMoveRight={widget.onMoveRight}>
        <div className="overflow-x-auto max-h-[320px]">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-background/40 backdrop-blur"><tr className="border-b border-border/60 text-[9.5px] font-semibold text-muted-foreground/70 uppercase tracking-[0.1em]">
              <th className="text-left py-2.5 pr-2">Date</th><th className="text-right py-2.5 px-2">Leads</th><th className="text-right py-2.5 px-2">Sold</th>
              <th className="text-right py-2.5 px-2">Revenue</th><th className="text-right py-2.5 px-2">Cost</th><th className="text-right py-2.5 px-2">Spend</th><th className="text-right py-2.5 px-2">Profit</th>
            </tr></thead>
            <tbody>
              {data.map(r => (
                <tr key={r.date} className="border-b border-border/60 hover:bg-accent/40 transition-colors">
                  <td className="py-2.5 pr-2 font-mono font-semibold text-foreground">{r.date}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{int(r.leads)}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{int(r.sold)}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{money(r.revenue)}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{money(r.cost)}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{money(r.spend)}</td>
                  <td className="text-right py-2.5 px-2 font-mono tabular-nums text-muted-foreground">{money(r.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetShell>
    );
  }

  const def = TABLE_DEFS[type];
  if (def) return <GroupTable def={def} leads={leads} adSpend={adSpend} widget={widget} onChange={onChange} />;

  return null;
}

export { TABLE_DEFS };