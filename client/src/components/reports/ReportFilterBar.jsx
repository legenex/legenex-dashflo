import React, { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Panel } from '@/components/settings/settingsUi';
import MobileFilterSheet from '@/components/shared/MobileFilterSheet';
import { Filter, Plus, X } from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { STANDARD_PERIODS, resolvePeriod, APP_TZ } from '@/lib/periodRange';

const OPTIONAL_FILTERS = [
  { key: 'utm_source', label: 'UTM Source' },
  { key: 'accident_date', label: 'Accident Date' },
  { key: 'state', label: 'State' },
];

const fmt = (d) => formatInTimeZone(d, APP_TZ, 'yyyy-MM-dd');

// Report-level filter bar. Matches the Leads filter bar styling.
// value = { date_from, date_to, campaign, vertical, supplier_name, buyer_id, brand, ...optional }
export default function ReportFilterBar({ value, onChange, options }) {
  const { campaigns = [], verticals = [], suppliers = [], buyers = [], brands = [] } = options || {};
  const [showFilters, setShowFilters] = useState(false);
  const [extra, setExtra] = useState(Object.keys(value || {}).filter(k => OPTIONAL_FILTERS.some(f => f.key === k) && value[k]));
  const [period, setPeriod] = useState(value.date_from || value.date_to ? 'custom' : 'this_month');

  const set = (k, v) => onChange({ ...value, [k]: v });
  const setDates = (from, to) => onChange({ ...value, date_from: from || '', date_to: to || '' });

  // Default to This Month once, if no explicit date is already applied.
  useEffect(() => {
    if (!value.date_from && !value.date_to && period !== 'custom') {
      const w = resolvePeriod(period);
      onChange({ ...value, date_from: fmt(w.start), date_to: fmt(w.end) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickPeriod = (p) => {
    setPeriod(p);
    if (p === 'custom') return;
    const w = resolvePeriod(p);
    setDates(fmt(w.start), fmt(w.end));
  };

  const addExtra = (k) => { if (!extra.includes(k)) setExtra([...extra, k]); };
  const removeExtra = (k) => { setExtra(extra.filter(x => x !== k)); set(k, ''); };

  const clearAll = () => {
    setPeriod('this_month');
    setExtra([]);
    const w = resolvePeriod('this_month');
    onChange({ date_from: fmt(w.start), date_to: fmt(w.end) });
  };

  const opt = (all, items) => [{ value: '', label: all }, ...items];

  // Count active filters for the mobile Filters badge.
  const activeCount = extra.length + (value.campaign ? 1 : 0) + (value.vertical ? 1 : 0) +
    (value.supplier_name ? 1 : 0) + (value.buyer_id ? 1 : 0) + (value.brand ? 1 : 0);

  return (
    <div className="mb-5 space-y-3">
      <Panel className="p-3 flex items-center gap-3 flex-wrap" i={0}>
        <MobileFilterSheet activeCount={activeCount} onClearAll={clearAll}>
        <SearchableSelect
          value={period}
          onValueChange={pickPeriod}
          className="w-full lg:w-[150px] bg-card border-border"
          options={STANDARD_PERIODS.map(p => ({ value: p.value, label: p.label }))}
        />

        {period === 'custom' && (
          <div className="flex items-center gap-2">
            <Input type="date" value={value.date_from || ''} onChange={e => setDates(e.target.value, value.date_to)} className="bg-card border-border w-full lg:w-[140px]" />
            <span className="text-muted-foreground text-xs">to</span>
            <Input type="date" value={value.date_to || ''} onChange={e => setDates(value.date_from, e.target.value)} className="bg-card border-border w-full lg:w-[140px]" />
          </div>
        )}

        <SearchableSelect value={value.campaign || ''} onValueChange={v => set('campaign', v)} className="w-full lg:w-[150px] bg-card border-border" options={opt('Campaign: All', campaigns.map(c => ({ value: c.name, label: c.name })))} />
        <SearchableSelect value={value.vertical || ''} onValueChange={v => set('vertical', v)} className="w-full lg:w-[140px] bg-card border-border" options={opt('Vertical: All', verticals.map(v => ({ value: v.code, label: v.name })))} />
        <SearchableSelect value={value.supplier_name || ''} onValueChange={v => set('supplier_name', v)} className="w-full lg:w-[150px] bg-card border-border" options={opt('Supplier: All', suppliers.map(s => ({ value: s.name, label: s.name })))} />
        <SearchableSelect value={value.buyer_id || ''} onValueChange={v => set('buyer_id', v)} className="w-full lg:w-[150px] bg-card border-border" options={opt('Buyer: All', buyers.map(b => ({ value: b.company_name, label: b.company_name })))} />
        <SearchableSelect value={value.brand || ''} onValueChange={v => set('brand', v)} className="w-full lg:w-[140px] bg-card border-border" options={opt('Brand: All', brands.map(b => ({ value: b.brand_code, label: b.brand_name })))} />

        <Button
          variant={showFilters || extra.length > 0 ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className="gap-1.5 w-full lg:w-auto"
        >
          <Filter className="w-3.5 h-3.5" /> Filters
          {extra.length > 0 && <Badge variant="secondary" className="ml-1">{extra.length}</Badge>}
        </Button>

        <Button variant="ghost" size="sm" onClick={clearAll} className="gap-1 text-muted-foreground ml-auto hidden lg:flex">
          <X className="w-3.5 h-3.5" /> Clear
        </Button>
        </MobileFilterSheet>
      </Panel>

      {showFilters && (
        <div className="bg-card border border-border rounded-[10px] p-4 space-y-2">
          {extra.length === 0 && (
            <div className="text-[13px] text-muted-foreground py-2">No extra filters. Add one below.</div>
          )}
          {extra.map(k => {
            const f = OPTIONAL_FILTERS.find(x => x.key === k);
            return (
              <div key={k} className="flex items-center gap-2">
                <div className="w-[160px] text-[13px] text-muted-foreground">{f.label}</div>
                <Input value={value[k] || ''} onChange={e => set(k, e.target.value)} placeholder="Value" className="flex-1 bg-background" />
                <Button size="icon" variant="ghost" className="text-destructive shrink-0" onClick={() => removeExtra(k)}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {OPTIONAL_FILTERS.filter(f => !extra.includes(f.key)).map(f => (
              <Button key={f.key} variant="outline" size="sm" onClick={() => addExtra(f.key)} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> {f.label}
              </Button>
            ))}
            {OPTIONAL_FILTERS.every(f => extra.includes(f.key)) && <div className="px-2 py-1.5 text-[12px] text-muted-foreground">All added</div>}
          </div>
        </div>
      )}
    </div>
  );
}