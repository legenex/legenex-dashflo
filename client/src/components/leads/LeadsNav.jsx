import React, { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { List, CheckCircle2, XCircle, Ban, Slash, Clock, AlertTriangle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { differenceInHours } from 'date-fns';
import SubNavShell from '@/components/layout/SubNavShell';

const ITEMS = [
  { label: 'All Leads', path: '/leads', icon: List, view: 'all' },
  { label: 'Sold', path: '/leads/sold', icon: CheckCircle2, view: 'sold' },
  { label: 'Unsold', path: '/leads/unsold', icon: XCircle, view: 'unsold' },
  { label: 'Disqualified', path: '/leads/disqualified', icon: Ban, view: 'disqualified' },
  { label: 'Rejected', path: '/leads/rejected', icon: Slash, view: 'rejected' },
  { label: 'Queued', path: '/leads/queued', icon: Clock, view: 'queued' },
];

function matchesView(lead, view) {
  switch (view) {
    case 'all': return true;
    case 'sold': return lead.final_status === 'Sold';
    case 'unsold': return lead.final_status === 'Unsold';
    case 'disqualified':
      return lead.final_status === 'Disqualified' || lead.final_status === 'Error' || /disqual|dq/i.test(lead.leadbyte_record_status || '');
    case 'rejected':
      return lead.final_status === 'Duplicate' || /reject/i.test(lead.leadbyte_record_status || '');
    case 'queued': return lead.final_status === 'Queued';
    default: return true;
  }
}

// Left sub-sidebar for the Leads section: LEADS group label, per-view icons with
// live count badges, active red pill, and a queued-alert card for old queued leads.
export default function LeadsNav() {
  const location = useLocation();

  const { data: leads = [] } = useQuery({
    queryKey: ['leads-all-non-archived'],
    queryFn: () => api.entities.Lead.filter({ archived: false }, '-created_date', 500),
  });

  const counts = useMemo(() => {
    const c = {};
    for (const item of ITEMS) c[item.view] = leads.filter(l => matchesView(l, item.view)).length;
    return c;
  }, [leads]);

  const queuedOld = useMemo(() => {
    const now = new Date();
    return leads.filter(l => l.final_status === 'Queued' && l.created_date && differenceInHours(now, new Date(l.created_date)) >= 5).length;
  }, [leads]);

  const railItems = ITEMS.map(item => ({ label: item.label, to: item.path, active: location.pathname === item.path }));

  return (
    <SubNavShell items={railItems}>
      <div className="flex flex-col h-full">
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1.5">Leads</div>
        <div className="space-y-0.5">
          {ITEMS.map(item => {
            const active = location.pathname === item.path;
            const Icon = item.icon;
            const n = counts[item.view] || 0;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors border-l-2 ${
                  active
                    ? 'bg-primary/10 text-primary font-medium border-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/40 border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
                <span
                  className={`min-w-[20px] text-center rounded-full px-1.5 py-px text-[10px] font-mono font-semibold tabular-nums ${
                    n > 0 ? 'bg-status-unsold status-unsold' : 'bg-accent text-muted-foreground/70'
                  }`}
                >
                  {n}
                </span>
              </Link>
            );
          })}
        </div>

        {/* Queued alert card — only when leads are queued 5h+ */}
        {queuedOld > 0 && (
          <div className="mt-auto rounded-xl border border-[hsl(38_80%_57%)]/40 bg-status-unsold p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="w-3.5 h-3.5 status-unsold" />
              <span className="text-[9.5px] font-semibold tracking-[0.11em] uppercase status-unsold">Attention</span>
            </div>
            <div className="text-[12px] font-semibold status-unsold">{queuedOld} queued 5h+</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Manual handling needed</div>
          </div>
        )}
      </div>
    </SubNavShell>
  );
}