import React from 'react';
import { formatDistanceToNow } from 'date-fns';
import StatusPill from '@/components/shared/StatusPill';

// Mobile-only condensed lead row. Shows exactly four fields: name, status,
// revenue, relative time. Tapping the card opens the existing detail modal.
export default function LeadCard({ lead, onOpen }) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
  const revenue = Number(lead.revenue) || 0;
  let relative = '';
  try {
    if (lead.created_date) relative = formatDistanceToNow(new Date(lead.created_date), { addSuffix: true });
  } catch { /* ignore */ }

  return (
    <button
      type="button"
      onClick={() => onOpen(lead)}
      className="tap-target w-full text-left bg-card border border-border rounded-[10px] p-3.5 flex items-center gap-3 active:bg-accent/50 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-foreground truncate">{name}</div>
        <div className="text-[12px] text-muted-foreground mt-0.5">{relative}</div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {lead.final_status && <StatusPill status={lead.final_status} />}
        <div className="text-[13px] font-mono text-foreground">${revenue.toFixed(2)}</div>
      </div>
    </button>
  );
}