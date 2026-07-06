import React from 'react';
import { motion } from 'framer-motion';
import { fmtMoney } from '@/lib/overviewFinance';
import useCountUp from '@/hooks/useCountUp';
import AnimatedPanel from '@/components/overview/AnimatedPanel';

// Grouped KPI card. All four render with an identical structure so they look equal.
export default function GroupedKpiCard({
  label, headline, subLabel, sub, gapLabel = 'gap', gap, icon: Icon,
  delta = 0, note, format = 'money',
}) {
  const animated = useCountUp(headline);
  const f = (v) => format === 'money' ? fmtMoney(v) : v;

  return (
    <AnimatedPanel className="p-4 h-full overflow-hidden group" style={{ borderLeft: '2px solid #E5484D66' }}>
      {/* top row: label + icon box */}
      <div className="flex items-start justify-between">
        <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        {Icon && (
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(229,72,77,0.12)', border: '1px solid rgba(229,72,77,0.25)' }}
          >
            <Icon className="w-[18px] h-[18px]" style={{ color: '#F2777B' }} />
          </div>
        )}
      </div>

      {/* big value + dim percent-change */}
      <div className="flex items-baseline gap-2 mt-2">
        <div className="text-[30px] font-bold leading-tight tabular-nums text-foreground">{f(animated)}</div>
        <div className="text-[12px] font-medium text-muted-foreground/70">{delta.toFixed(1)}%</div>
      </div>

      {/* red gap-line with traveling dot */}
      <div className="mt-1.5">
        <svg width="100%" height="7" viewBox="0 0 120 28" preserveAspectRatio="none" className="overflow-visible">
          <path d="M0 24 L120 24" stroke="#E5484D" strokeOpacity="0.7" strokeWidth="1.5" />
          <motion.circle
            r="2.5"
            cy="24"
            fill="#E5484D"
            animate={{ cx: [0, 120], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'linear' }}
          />
        </svg>
      </div>

      {/* bottom row: sub value + gap chip */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
        <div className="text-[12px] text-muted-foreground">{subLabel}: <span className="text-foreground font-medium tabular-nums">{f(sub)}</span></div>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-md tabular-nums bg-muted text-muted-foreground">{gapLabel} {f(Math.abs(gap))}</span>
      </div>

      {/* sub-label note */}
      {note && <div className="text-[11px] text-muted-foreground/80 mt-2">{note}</div>}
    </AnimatedPanel>
  );
}