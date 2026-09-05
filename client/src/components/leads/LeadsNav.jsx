import React, { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { List, CheckCircle2, XCircle, Ban, Slash, Clock, AlertTriangle, Trophy } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { differenceInHours } from 'date-fns';
import SubNavShell from '@/components/layout/SubNavShell';
import { defaultLeadsPeriod, resolvePeriod } from '@/lib/periodRange';
import { leadEventInstant } from '@/lib/reportMetrics';
import { LEAD_STATUS, matchesLeadView, resolveLeadStatus } from '@/lib/leadStatus';

const ITEMS = [
  { label: 'All Leads', path: '/leads', icon: List, view: 'all' },
  { label: 'Sold', path: '/leads/sold', icon: CheckCircle2, view: 'sold' },
  { label: 'Unsold', path: '/leads/unsold', icon: XCircle, view: 'unsold' },
  { label: 'Disqualified', path: '/leads/disqualified', icon: Ban, view: 'disqualified' },
  { label: 'Rejected', path: '/leads/rejected', icon: Slash, view: 'rejected' },
  { label: 'Queued', path: '/leads/queued', icon: Clock, view: 'queued' },
  { label: 'Converted', path: '/leads/converted', icon: Trophy, view: 'converted' },
  // Calls are CallRecords rather than leads and now live in their own
  // top-level Calls section, so they are no longer listed here.
];

// Left sub-sidebar for the Leads section: LEADS group label, per-view icons with
// live count badges, active red pill, and a queued-alert card for old queued leads.
export default function LeadsNav() {
  const location = useLocation();
  // The table writes its period into the URL. Reading it here keeps the badges
  // and the table answering the same question: counting all time next to a
  // table showing one month is what made Sold read 562 above a list of 292.
  const [searchParams] = useSearchParams();
  const activeView = ITEMS.find((item) => item.path === location.pathname)?.view || 'all';
  const period = searchParams.get('period') || defaultLeadsPeriod(activeView);
  const customPeriod = {
    from: searchParams.get('from') || '',
    to: searchParams.get('to') || '',
  };

  // Deliberately the SAME query key as the leads table.
  //
  // This used to be its own key ('leads-nav-counts'), which meant two separate
  // caches of an identical query, populated at different moments and refreshed
  // independently. Leads arrive continuously, so the badges and the table could
  // disagree for no visible reason, and a refetch after an action invalidated
  // only the table's copy, leaving these counts stale. One key, one cache, one
  // answer.
  const { data: leads = [] } = useQuery({
    queryKey: ['leads-all-non-archived'],
    queryFn: async () => {
      const all = [];
      let p = 0;
      const size = 500;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await api.entities.Lead.filter({ archived: false }, '-created_date', size, p * size);
        all.push(...batch);
        if (batch.length < size) break;
        p += 1;
      }
      return all;
    },
  });

  const counts = useMemo(() => {
    const { start, end } = resolvePeriod(period, customPeriod);
    const inWindow = leads.filter((l) => {
      const inst = leadEventInstant(l);
      if (start && (!inst || inst < start)) return false;
      if (end && (!inst || inst > end)) return false;
      return true;
    });
    const c = {};
    for (const item of ITEMS) {
      c[item.view] = inWindow.filter(l => matchesLeadView(l, item.view)).length;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, period, customPeriod.from, customPeriod.to]);

  const queuedOld = useMemo(() => {
    const now = new Date();
    return leads.filter(l => resolveLeadStatus(l) === LEAD_STATUS.QUEUED && l.created_date && differenceInHours(now, new Date(l.created_date)) >= 5).length;
  }, [leads]);

  const railItems = ITEMS.map(item => ({ label: item.label, icon: item.icon, to: item.path, active: location.pathname === item.path }));

  return (
    <SubNavShell items={railItems} title="Leads">
      <div className="flex flex-col h-full">
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

        {/* Queued alert card, only when leads are queued 5h+ */}
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
