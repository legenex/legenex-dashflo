import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Sparkles, Check, Trash2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';

// Review banner for buyers and suppliers the inbound webhook created on its own,
// because an outcome payload named one this system had never seen.
//
// They are created inert (draft or new, active false, no pricing, no coverage),
// so nothing routes or bills until an operator accepts here. Accepting does NOT
// invent pricing: it clears the flag and hands the record over so the operator
// can finish it in the normal editor.
//
// kind: 'buyer' | 'supplier'
const CONFIG = {
  buyer: {
    entity: 'Buyer',
    queryKey: ['buyers'],
    label: 'buyer',
    labelPlural: 'buyers',
    nameOf: (r) => r.company_name || r.buyer_code || 'Unnamed',
    codeOf: (r) => r.buyer_code,
    accept: { status: 'draft', active: false, auto_created: false },
    finishHint: 'Set pricing and state coverage before making it active.',
  },
  supplier: {
    entity: 'Supplier',
    queryKey: ['suppliers'],
    label: 'supplier',
    labelPlural: 'suppliers',
    nameOf: (r) => r.name || r.sid || 'Unnamed',
    codeOf: (r) => r.sid,
    accept: { status: 'new', active: false, auto_created: false },
    finishHint: 'Set payout terms before making it active.',
  },
};

export default function AutoCreatedReviewBanner({ kind, onOpenRecord }) {
  const cfg = CONFIG[kind];
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const [discardTarget, setDiscardTarget] = useState(null);

  const { data: records = [] } = useQuery({
    queryKey: [`auto-created-${kind}`],
    queryFn: () => api.entities[cfg.entity].list('-created_date', 200),
  });

  const pending = (records || []).filter((r) => r.auto_created === true);
  if (pending.length === 0) return null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: [`auto-created-${kind}`] });
    qc.invalidateQueries({ queryKey: cfg.queryKey });
  };

  const accept = async (r) => {
    setBusyId(r.id);
    try {
      // status and active are always written together.
      await api.entities[cfg.entity].update(r.id, cfg.accept);
      refresh();
      toast.success(`${cfg.nameOf(r)} kept. ${cfg.finishHint}`);
    } catch (e) {
      toast.error(e?.message || 'Could not accept');
    } finally {
      setBusyId(null);
    }
  };

  const discard = async () => {
    if (!discardTarget) return;
    setBusyId(discardTarget.id);
    try {
      await api.entities[cfg.entity].delete(discardTarget.id);
      refresh();
      toast.success(`${cfg.nameOf(discardTarget)} discarded`);
    } catch (e) {
      toast.error(e?.message || 'Could not discard');
    } finally {
      setBusyId(null);
      setDiscardTarget(null);
    }
  };

  return (
    <div className="bg-card border border-primary/40 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-semibold text-primary">
            {pending.length} new {pending.length === 1 ? cfg.label : cfg.labelPlural} auto-created from an inbound webhook
          </div>
          <p className="text-[12px] text-muted-foreground leading-relaxed mt-0.5">
            An outcome payload named {pending.length === 1 ? 'a ' + cfg.label : cfg.labelPlural} this system had not seen. Each was created with no pricing and left inactive, so nothing routes or bills until you keep it. Keep it and finish the setup, or discard it.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        {pending.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 border-b border-border last:border-b-0 px-3 py-2 hover:bg-accent">
            <div className="min-w-0">
              <div className="text-[13px] text-foreground truncate">{cfg.nameOf(r)}</div>
              {cfg.codeOf(r) && (
                <div className="font-mono text-[11px] text-muted-foreground">{cfg.codeOf(r)}</div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {onOpenRecord && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1"
                  onClick={() => onOpenRecord(r)}>
                  Open <ArrowRight className="w-3 h-3" />
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1 text-primary"
                disabled={busyId === r.id} onClick={() => accept(r)}>
                <Check className="w-3 h-3" /> Keep
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                disabled={busyId === r.id} onClick={() => setDiscardTarget(r)} title="Discard">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={!!discardTarget} onOpenChange={(v) => { if (!v) setDiscardTarget(null); }}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this {cfg.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes "{discardTarget ? cfg.nameOf(discardTarget) : ''}". Leads already attributed to it keep the name on the lead record. If the webhook posts it again it will be re-created. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={discard} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
