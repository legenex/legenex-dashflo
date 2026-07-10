import React from 'react';
import { Button } from '@/components/ui/button';

// Per status row actions. Instant transitions (Activate) call onTransition
// directly. Pause, Terminate and Delete are routed through their confirm
// dialogs by the parent via onPause / onTerminate / onDelete.
export default function SupplierRowActions({ supplier, onTransition, onPause, onTerminate, onDelete }) {
  const status = String(supplier.status || 'new').toLowerCase();

  const btn = (label, handler, variant = 'ghost') => (
    <Button key={label} size="sm" variant={variant} onClick={handler} className="h-7 px-2 text-[11px]">
      {label}
    </Button>
  );

  return (
    <div className="flex items-center justify-end gap-1">
      {status === 'new' && btn('Activate', () => onTransition(supplier, 'active'))}
      {status === 'active' && (
        <>
          {btn('Pause', () => onPause(supplier))}
          {btn('Terminate', () => onTerminate(supplier))}
        </>
      )}
      {status === 'paused' && (
        <>
          {btn('Activate', () => onTransition(supplier, 'active'))}
          {btn('Terminate', () => onTerminate(supplier))}
        </>
      )}
      {status === 'terminated' && btn('Delete', () => onDelete(supplier))}
    </div>
  );
}