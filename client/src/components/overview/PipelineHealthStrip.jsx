import React from 'react';
import { Link } from 'react-router-dom';
import { LEAD_STATUS, resolveLeadStatus } from '@/lib/leadStatus';

// Horizontal strip of counts per lead_status for the period. Each count links
// to the matching Leads view. Reads the passed leads only, never fabricates
// rows. Seven-value vocabulary (forge-pack/CONTRACT.md D1): Processing,
// Duplicate and Error no longer have their own tile; D4 collapses them into
// Queued (Processing, Error) or Rejected (Duplicate).
const STATUSES = [
  { key: LEAD_STATUS.SOLD, label: 'Sold', cls: 'status-sold', to: '/leads/sold' },
  { key: LEAD_STATUS.UNSOLD, label: 'Unsold', cls: 'status-unsold', to: '/leads/unsold' },
  { key: LEAD_STATUS.DISQUALIFIED, label: 'Disqualified', cls: 'status-disqualified', to: '/leads/disqualified' },
  { key: LEAD_STATUS.QUEUED, label: 'Queued', cls: 'status-queued', to: '/leads/queued' },
  { key: LEAD_STATUS.RETURNED, label: 'Returned', cls: 'status-returned', to: '/leads' },
  { key: LEAD_STATUS.REJECTED, label: 'Rejected', cls: 'status-rejected', to: '/leads/rejected' },
  { key: LEAD_STATUS.CONVERTED, label: 'Converted', cls: 'status-converted', to: '/leads/converted' },
];

export default function PipelineHealthStrip({ leads = [] }) {
  const counts = {};
  for (const l of leads) {
    const s = resolveLeadStatus(l) || LEAD_STATUS.QUEUED;
    counts[s] = (counts[s] || 0) + 1;
  }

  if (leads.length === 0) {
    return (
      <div className="p-5 text-center text-[13px] text-muted-foreground">No leads in this period</div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 p-4">
      {STATUSES.map(s => (
        <Link
          key={s.key}
          to={s.to}
          className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/30 px-3 py-3 hover:bg-accent/40 transition-colors"
        >
          <span className={`text-[20px] font-semibold font-mono ${s.cls}`}>{counts[s.key] || 0}</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1 text-center">{s.label}</span>
        </Link>
      ))}
    </div>
  );
}