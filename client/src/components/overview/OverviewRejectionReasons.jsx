import React, { useMemo } from 'react';
import { LEAD_STATUS, resolveLeadStatus } from '@/lib/leadStatus';

// Ranked list of the most common reason values for one D1 status. Shows
// reason text, count and share of total. Capped at the top 8. Reads the
// passed period-filtered leads only.
//
// Two named uses on Overview (forge-pack/CONTRACT.md D1, WORK-UNITS.yaml
// W3-UI-STATUS): "Top Rejection Reasons" (status="rejected", the post-time
// rejections - a submission never accepted as a valid, new, routable lead)
// and "Top Unsold Reasons" (status="unsold", buyer-side and routing
// rejections - qualified, entered distribution, no buyer bought it,
// including buyers being asked and saying no). These used to be a single
// card covering Queued, Disqualified and Error leads together, which mixed a
// transit state (Queued/Error, now both collapse into `queued` under D4) and
// a genuine business disqualification in with what an operator actually
// means by "rejection reasons." Splitting by the real D1 status is the fix,
// not a relabelling: a disqualified lead and a stuck-in-queue lead are
// neither a rejection nor an unsold lead, and no longer appear on either
// card.
//
// Reason text prefers the more specific field for each status: a rejected
// lead's reason is a routing/validation-time decision (queue_reason or the
// server's status_reason code); an unsold lead's most informative reason is
// what the buyer actually said (buyer_feedback) when one exists.
function reasonFor(lead, status) {
  if (status === LEAD_STATUS.UNSOLD) {
    return (lead.buyer_feedback && String(lead.buyer_feedback).trim())
      || (lead.queue_reason && String(lead.queue_reason).trim())
      || (lead.status_reason && String(lead.status_reason).trim())
      || 'No buyer accepted';
  }
  return (lead.queue_reason && String(lead.queue_reason).trim())
    || (lead.status_reason && String(lead.status_reason).trim())
    || 'Rejected';
}

const EMPTY_LABEL = {
  [LEAD_STATUS.REJECTED]: 'No rejected leads in this period',
  [LEAD_STATUS.UNSOLD]: 'No unsold leads in this period',
};

const TOTAL_LABEL = {
  [LEAD_STATUS.REJECTED]: 'rejected leads total',
  [LEAD_STATUS.UNSOLD]: 'unsold leads total',
};

export default function OverviewRejectionReasons({ leads = [], status = LEAD_STATUS.REJECTED }) {
  const { rows, total } = useMemo(() => {
    const reasons = {};
    let t = 0;
    for (const l of leads) {
      if (resolveLeadStatus(l) !== status) continue;
      const reason = reasonFor(l, status);
      reasons[reason] = (reasons[reason] || 0) + 1;
      t++;
    }
    const list = Object.entries(reasons)
      .map(([reason, count]) => ({ reason, count, pct: t > 0 ? Math.round((count / t) * 100) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    return { rows: list, total: t };
  }, [leads, status]);

  if (rows.length === 0) {
    return <div className="h-[220px] flex items-center justify-center text-[13px] text-muted-foreground">{EMPTY_LABEL[status] || 'No leads in this period'}</div>;
  }

  return (
    <div className="p-4 space-y-2">
      {rows.map(row => (
        <div key={row.reason}>
          <div className="flex items-center justify-between text-[12px] mb-1">
            <span className="text-foreground truncate max-w-[220px]">{row.reason}</span>
            <span className="font-mono text-muted-foreground">{row.count} <span className="text-muted-foreground/60">({row.pct}%)</span></span>
          </div>
          <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
            <div className="h-full bg-primary/70 rounded-full" style={{ width: `${row.pct}%` }} />
          </div>
        </div>
      ))}
      <div className="text-[10px] text-muted-foreground pt-1">{total} {TOTAL_LABEL[status] || 'leads total'}</div>
    </div>
  );
}
