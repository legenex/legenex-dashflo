import React from 'react';
import { Button } from '@/components/ui/button';

// Per status row actions. Instant transitions (Launch, Activate, Cancel) call
// onTransition directly. Pause, Terminate and Delete are routed through their
// confirm dialogs by the parent via onPause / onTerminate / onDelete.
export default function BuyerRowActions({ buyer, onTransition, onPause, onTerminate, onDelete }) {
  const status = String(buyer.status || 'draft').toLowerCase();

  const btn = (label, handler, variant = 'ghost') => (
    <Button key={label} size="sm" variant={variant} onClick={handler} className="h-7 px-2 text-[11px]">
      {label}
    </Button>
  );

  return (
    <div className="flex items-center justify-end gap-1">
      {status === 'draft' && btn('Launch', () => onTransition(buyer, 'launching'))}
      {status === 'launching' && (
        <>
          {btn('Activate', () => onTransition(buyer, 'active'))}
          {btn('Cancel', () => onTransition(buyer, 'draft'))}
        </>
      )}
      {status === 'active' && (
        <>
          {btn('Pause', () => onPause(buyer))}
          {btn('Terminate', () => onTerminate(buyer))}
        </>
      )}
      {status === 'paused' && (
        <>
          {btn('Activate', () => onTransition(buyer, 'active'))}
          {btn('Terminate', () => onTerminate(buyer))}
        </>
      )}
      {status === 'terminated' && btn('Delete', () => onDelete(buyer))}
    </div>
  );
}