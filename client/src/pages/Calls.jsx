import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PhoneCall, Search, Trophy, DollarSign, Link2Off } from 'lucide-react';
import { format } from 'date-fns';

const ALL = '__all__';

// Calls are their own record, not leads. A call sheet writes them and an
// attribution feed fills in which supplier sent the number, so a call can sit
// here unattributed until its Ringba row arrives.
function fmtMoney(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDuration(s) {
  const secs = Number(s) || 0;
  if (!secs) return '-';
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

export default function Calls() {
  const [search, setSearch] = useState('');
  const [buyer, setBuyer] = useState(ALL);
  const [status, setStatus] = useState(ALL);

  const { data: calls = [], isLoading } = useQuery({
    queryKey: ['call-records'],
    queryFn: async () => {
      // The platform hard caps a query at 500 rows regardless of limit, so this
      // pages until the tail is short.
      const all = [];
      let page = 0;
      const size = 500;
      for (;;) {
        const batch = await api.entities.CallRecord.list('-call_at', size, page * size);
        const rows = batch || [];
        all.push(...rows);
        if (rows.length < size || page > 20) break;
        page += 1;
      }
      return all;
    },
  });

  const buyers = useMemo(() => {
    const set = new Set((calls || []).map((c) => c.buyer_code).filter(Boolean));
    return Array.from(set).sort();
  }, [calls]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (calls || []).filter((c) => {
      if (buyer !== ALL && c.buyer_code !== buyer) return false;
      if (status === 'qualified' && !c.qualified) return false;
      if (status === 'unqualified' && c.qualified) return false;
      if (status === 'unattributed' && c.attribution_status !== 'unattributed') return false;
      if (!q) return true;
      return [c.mobile, c.mobile_raw, c.first_name, c.last_name, c.call_id, c.supplier_name, c.sid]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [calls, search, buyer, status]);

  const totals = useMemo(() => ({
    count: visible.length,
    qualified: visible.filter((c) => c.qualified).length,
    revenue: visible.reduce((sum, c) => sum + (Number(c.revenue) || 0), 0),
    unattributed: visible.filter((c) => c.attribution_status === 'unattributed').length,
  }), [visible]);

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xl font-semibold text-foreground">Calls</div>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          Inbound calls read from connected call sheets, with their qualified flag, payout and supplier attribution.
        </p>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Calls', value: totals.count.toLocaleString(), icon: PhoneCall },
          { label: 'Qualified', value: totals.qualified.toLocaleString(), icon: Trophy },
          { label: 'Revenue', value: fmtMoney(totals.revenue), icon: DollarSign },
          { label: 'Unattributed', value: totals.unattributed.toLocaleString(), icon: Link2Off },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon className="w-4 h-4" />
                <span className="text-[11px] uppercase tracking-wide">{s.label}</span>
              </div>
              <div className="text-[20px] font-bold text-foreground mt-2 leading-none">{s.value}</div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number, name, call ID or supplier"
            className="bg-background pl-9 text-[13px]"
          />
        </div>
        <Select value={buyer} onValueChange={setBuyer}>
          <SelectTrigger className="bg-background text-[13px] w-[180px]"><SelectValue placeholder="All buyers" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All buyers</SelectItem>
            {buyers.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="bg-background text-[13px] w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All calls</SelectItem>
            <SelectItem value="qualified">Qualified only</SelectItem>
            <SelectItem value="unqualified">Not qualified</SelectItem>
            <SelectItem value="unattributed">Unattributed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {['Date', 'Number', 'Name', 'Status', 'Duration', 'Qualified', 'Revenue', 'Buyer', 'Supplier', 'Source'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">Loading calls</td></tr>
              )}
              {!isLoading && visible.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <PhoneCall className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                    <div className="text-[13px] text-muted-foreground">
                      No calls yet. Connect a call sheet in Settings, Data Sources, Google Sheets.
                    </div>
                  </td>
                </tr>
              )}
              {visible.map((c) => (
                <tr key={c.id} className="hover:bg-accent transition-colors">
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                    {c.call_at ? format(new Date(c.call_at), 'MMM dd yyyy') : '-'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] text-foreground">{c.mobile_raw || c.mobile || '-'}</td>
                  <td className="px-4 py-3 text-muted-foreground truncate max-w-[160px]">
                    {[c.first_name, c.last_name].filter(Boolean).join(' ') || '-'}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">{c.inquiry_status || '-'}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-muted-foreground">{fmtDuration(c.duration_seconds)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium ${c.qualified ? 'text-primary' : 'text-muted-foreground'}`}
                      title={c.qualified_raw ? `From: ${c.qualified_raw}` : undefined}
                    >
                      {c.qualified ? 'Qualified' : 'No'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] text-foreground">{fmtMoney(c.revenue)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">{c.buyer_code || '-'}</td>
                  <td className="px-4 py-3 text-[12px]">
                    {c.supplier_name
                      ? <span className="text-muted-foreground">{c.supplier_name}{c.sid ? ` (${c.sid})` : ''}</span>
                      : <span className="text-muted-foreground/60">unattributed</span>}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground truncate max-w-[160px]">{c.source_name || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
