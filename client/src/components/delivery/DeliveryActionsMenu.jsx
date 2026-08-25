import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { MoreVertical, Pencil, Copy, PlayCircle, PauseCircle, Archive, Loader2 } from 'lucide-react';
import RenameDeliveryDialog from '@/components/delivery/RenameDeliveryDialog';
import { duplicateDelivery } from '@/functions/duplicateDelivery';

// The one Delivery action menu: Edit / Rename / Duplicate / Enable-Disable /
// Archive, used identically from Buyers > Buyer > Deliveries, /webhooks'
// Native Deliveries list, and the full-page editor's own Overview tab.
// Every action here operates on the same canonical Delivery record - there is
// no delivery-list-specific or buyer-page-specific version of any of these.
export default function DeliveryActionsMenu({ delivery, onChanged, showEdit = true }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['deliveries'] }),
      qc.invalidateQueries({ queryKey: ['subdeliveries'] }),
      qc.invalidateQueries({ queryKey: ['native-deliveries'] }),
    ]);
    onChanged?.();
  }

  async function duplicate() {
    setBusy(true);
    try {
      const res = await duplicateDelivery({ deliveryId: delivery.id });
      const newId = res?.data?.deliveryId;
      if (!newId) throw new Error(res?.data?.error || 'No delivery id returned');
      await invalidate();
      toast.success('Delivery duplicated');
      navigate(`/webhooks/${newId}?rename=1`);
    } catch (e) {
      toast.error('Could not duplicate: ' + (e?.message || 'error'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    const nextStatus = delivery.status === 'active' ? 'paused' : 'active';
    setBusy(true);
    try {
      await api.entities.Delivery.update(delivery.id, { status: nextStatus });
      await invalidate();
      toast.success(nextStatus === 'active' ? 'Delivery enabled' : 'Delivery disabled');
    } catch (e) {
      toast.error('Could not update status: ' + (e?.message || 'error'));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    try {
      await api.entities.Delivery.update(delivery.id, { status: 'archived' });
      await invalidate();
      toast.success('Delivery archived');
      setArchiving(false);
    } catch (e) {
      toast.error('Could not archive: ' + (e?.message || 'error'));
    } finally {
      setBusy(false);
    }
  }

  const isActive = delivery.status === 'active';
  const isArchived = delivery.status === 'archived';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy} onClick={(e) => e.stopPropagation()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreVertical className="w-4 h-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {showEdit && (
            <DropdownMenuItem onSelect={() => navigate(`/webhooks/${delivery.id}`)} className="gap-2">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenaming(true)} className="gap-2">
            <Pencil className="w-3.5 h-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={duplicate} className="gap-2">
            <Copy className="w-3.5 h-3.5" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={toggleEnabled} disabled={isArchived} className="gap-2">
            {isActive ? <PauseCircle className="w-3.5 h-3.5" /> : <PlayCircle className="w-3.5 h-3.5" />}
            {isActive ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setArchiving(true)}
            disabled={isArchived}
            className="gap-2 text-destructive focus:text-destructive"
          >
            <Archive className="w-3.5 h-3.5" /> Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDeliveryDialog
        open={renaming}
        onOpenChange={setRenaming}
        delivery={delivery}
        onRenamed={invalidate}
      />

      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive "{delivery.name || 'this delivery'}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived deliveries are hidden from Routing&apos;s Add Delivery picker and cannot be newly routed.
              If a route is currently assigned to this delivery, archiving takes effect immediately: that route stops
              sending as soon as this delivery is no longer active, not only for new assignments. Historical attempts
              and configuration remain readable, and nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={archive} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
