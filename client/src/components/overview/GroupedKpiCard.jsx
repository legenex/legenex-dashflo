import React from 'react';
import { motion } from 'framer-motion';
import { fmtMoney } from '@/lib/overviewFinance';
import useCountUp from '@/hooks/useCountUp';
import AnimatedPanel from '@/components/overview/AnimatedPanel';

// Grouped KPI card. All four render with an identical structure so they look equal.
//
// `noData` is the honest-empty-state escape hatch (CONTRACT.md section 3): when
// the underlying lead window is empty, a headline of $0.00 with a real-looking
// gap chip and delta implies a real business result (revenue crashed, a loss
// was booked) rather than "nothing happened here yet". When true, the card
// renders an explicit no-data message instead of any figure derived from that
// empty window, and drops the delta/gap chip/gap-line that only make sense
// when there is a real number behind them.
export default function GroupedKpiCard({
  label, headline, subLabel, sub, gapLabel = 'gap', gap, icon: Icon,
  delta = 0, note, format = 'money', subFormat, hideGap = false,
  noData = false, noDataLabel = 'No data for this period',
}) {
  const animated = useCountUp(noData ? 0 : headline);
  const f = (v) => format === 'money' ? fmtMoney(v) : v;
  // A ratio card (CPL) has a money headline but a plain-count sub value, so the
  // footer needs its own formatter rather than inheriting the headline's.
  const fSub = (v) => (subFormat || format) === 'money' ? fmtMoney(v) : Number(v || 0).toLocaleString();
  const accentSoft = noData ? '#8B95A866' : '#E5484D66';
  const accentBg = noData ? 'rgba(139,149,168,0.12)' : 'rgba(229,72,77,0.12)';
  const accentBorder = noData ? 'rgba(139,149,168,0.25)' : 'rgba(229,72,77,0.25)';
  const accentIcon = noData ? '#8B95A8' : '#F2777B';
  const accentLine = noData ? '#8B95A8' : '#E5484D';

  return (
    <AnimatedPanel className="p-3 lg:p-4 h-full overflow-hidden group" style={{ borderLeft: `2px solid ${accentSoft}` }}>
      {/* top row: label + icon box */}
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] lg:text-[12px] font-medium uppercase tracking-wider text-muted-foreground min-w-0 truncate">{label}</div>
        {Icon && (
          <div
            className="w-8 h-8 lg:w-9 lg:h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: accentBg, border: `1px solid ${accentBorder}` }}
          >
            <Icon className="w-4 h-4 lg:w-[18px] lg:h-[18px]" style={{ color: accentIcon }} />
          </div>
        )}
      </div>

      {noData ? (
        <>
          {/* Honest empty state: no figure, no delta, no gap-line, no gap chip.
              A period with no leads has no basis for any of those. */}
          <div className="mt-2">
            <div className="text-[15px] sm:text-[17px] font-semibold leading-tight text-muted-foreground min-w-0 truncate">{noDataLabel}</div>
          </div>
          <div className="mt-1.5 h-[7px]" />
          <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-1 mt-2 pt-2 border-t border-border">
            <div className="text-[11px] lg:text-[12px] text-muted-foreground min-w-0 truncate">No leads recorded in this window</div>
          </div>
        </>
      ) : (
        <>
          {/* big value + dim percent-change.
              The headline was a fixed 30px, which overflowed a half-width column on
              a phone and was then clipped by overflow-hidden, so the number was
              simply unreadable. It scales with the breakpoint now, and the percent
              change is allowed to drop rather than squeeze the value. */}
          <div className="flex items-baseline flex-wrap gap-x-2 mt-2">
            <div className="text-[21px] sm:text-[25px] xl:text-[30px] font-bold leading-tight tabular-nums text-foreground min-w-0 truncate">{f(animated)}</div>
            <div className="text-[11px] lg:text-[12px] font-medium text-muted-foreground/70">{delta.toFixed(1)}%</div>
          </div>

          {/* gap-line with traveling dot */}
          <div className="mt-1.5">
            <svg width="100%" height="7" viewBox="0 0 120 28" preserveAspectRatio="none" className="overflow-visible">
              <path d="M0 24 L120 24" stroke={accentLine} strokeOpacity="0.7" strokeWidth="1.5" />
              <motion.circle
                r="2.5"
                cy="24"
                fill={accentLine}
                animate={{ cx: [0, 120], opacity: [0, 1, 1, 0] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'linear' }}
              />
            </svg>
          </div>

          {/* bottom row: sub value + gap chip. Wraps rather than overflowing when
              both numbers are long on a narrow card. */}
          <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-1 mt-2 pt-2 border-t border-border">
            <div className="text-[11px] lg:text-[12px] text-muted-foreground min-w-0 truncate">{subLabel}: <span className="text-foreground font-medium tabular-nums">{fSub(sub)}</span></div>
            {!hideGap && <span className="text-[11px] font-medium px-2 py-0.5 rounded-md tabular-nums bg-muted text-muted-foreground shrink-0">{gapLabel} {f(Math.abs(gap))}</span>}
          </div>
        </>
      )}

      {/* sub-label note */}
      {note && <div className="text-[11px] text-muted-foreground/80 mt-2">{note}</div>}
    </AnimatedPanel>
  );
}