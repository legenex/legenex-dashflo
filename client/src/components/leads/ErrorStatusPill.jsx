import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import StatusPill from '@/components/shared/StatusPill';
import { getLeadErrorReason } from '@/utils/leadError';
import { LEAD_STATUS, leadStatusLabel, resolveLeadStatus } from '@/lib/leadStatus';
import { AlertCircle, Clock, Copy } from 'lucide-react';

// The one reason code D4 names specifically for a Duplicate collapse
// (forge-pack/CONTRACT.md D4; server/src/lib/leadStatus.js's
// STATUS_REASON.REJECTED_DUPLICATE). Not a retired status value: a reason
// code the new vocabulary introduces, so it is not subject to
// forge-pack/scripts/check-status-vocabulary.mjs's retired-literal check.
const REJECTED_DUPLICATE_REASON = 'REJECTED_DUPLICATE';

export default function ErrorStatusPill({ lead, errorLogEntry, onOpenDetail, size = 'sm' }) {
  const [open, setOpen] = useState(false);

  if (!lead) return <StatusPill status={undefined} size={size} />;

  const status = resolveLeadStatus(lead);

  // Queued: show queue_reason in tooltip and popover. Covers every legacy
  // value D4 collapses into queued (the retired Processing/Qualified/Error
  // final_status values), not only a lead whose final_status is literally
  // "Queued".
  if (status === LEAD_STATUS.QUEUED && lead.processing_state !== 'failed') {
    const reason = lead.queue_reason || 'Queued for manual handling';
    return (
      <TooltipProvider delayDuration={150}>
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1 focus:outline-none">
                  <span className="inline-flex items-center rounded-full bg-status-queued status-queued px-2 py-0.5 text-[11px] font-semibold gap-1">
                    <Clock className="w-3 h-3" />
                    Queued
                  </span>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px] text-[11px]">
              {reason}
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="start" sideOffset={6} className="w-[300px] p-3 bg-popover border-border text-[12px]">
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 mt-0.5 status-queued shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">Queue reason</div>
                <div className="text-foreground break-words leading-relaxed">{reason}</div>
                {onOpenDetail && (
                  <button type="button" onClick={() => { setOpen(false); onOpenDetail(lead, 'summary'); }} className="mt-2 text-[11px] text-primary hover:underline">
                    Open details
                  </button>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    );
  }

  // Rejected specifically for the duplicate reason D4 names
  // (forge-pack/CONTRACT.md D4: the retired Duplicate final_status collapses
  // into rejected, status_reason REJECTED_DUPLICATE, linked to the original
  // lead). Still worth its own visual treatment: the lead genuinely is a
  // duplicate submission, D1 just files that under rejected rather than
  // giving it a status of its own.
  if (status === LEAD_STATUS.REJECTED && lead.status_reason === REJECTED_DUPLICATE_REASON) {
    const reason = lead.queue_reason || 'Duplicate lead detected';
    return (
      <TooltipProvider delayDuration={150}>
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1 focus:outline-none">
                  <span className="inline-flex items-center rounded-full bg-status-duplicate status-duplicate px-2 py-0.5 text-[11px] font-semibold gap-1">
                    <Copy className="w-3 h-3" />
                    Duplicate
                  </span>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px] text-[11px]">
              {reason}
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="start" sideOffset={6} className="w-[300px] p-3 bg-popover border-border text-[12px]">
            <div className="flex items-start gap-2">
              <Copy className="w-4 h-4 mt-0.5 status-duplicate shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">Duplicate reason</div>
                <div className="text-foreground break-words leading-relaxed">{reason}</div>
                {onOpenDetail && (
                  <button type="button" onClick={() => { setOpen(false); onOpenDetail(lead, 'delivery'); }} className="mt-2 text-[11px] text-primary hover:underline">
                    Open details
                  </button>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    );
  }

  // Everything left is either a genuinely stuck lead (queued, but
  // processing_state failed - D4: the retired Error final_status collapses
  // here) or a settled outcome the generic pill already knows how to render.
  if (lead.processing_state !== 'failed') {
    return <StatusPill status={leadStatusLabel(lead) || lead.final_status} size={size} />;
  }

  const reason = getLeadErrorReason(lead, errorLogEntry);
  const stage = lead.error_stage || errorLogEntry?.stage || 'error';

  return (
    <TooltipProvider delayDuration={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1 focus:outline-none">
                <span className="inline-flex items-center rounded-full bg-status-error status-error px-2 py-0.5 text-[11px] font-semibold gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Stuck
                </span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] text-[11px]">
            {reason}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="start" sideOffset={6} className="w-[300px] p-3 bg-popover border-border text-[12px]">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 status-error shrink-0" />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Failure reason · {stage}
              </div>
              <div className="text-foreground break-words leading-relaxed">{reason}</div>
              {onOpenDetail && (
                <button type="button" onClick={() => { setOpen(false); onOpenDetail(lead, stage); }} className="mt-2 text-[11px] text-primary hover:underline">
                  Open trace
                </button>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}