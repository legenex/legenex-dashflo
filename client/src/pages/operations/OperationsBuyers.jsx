import React, { useState, useMemo } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme';
import { toast } from 'sonner';
import SectionHeader from '@/components/shared/SectionHeader';
import RefreshButton from '@/components/shared/RefreshButton';
import ColumnManager from '@/components/leads/ColumnManager';
import { PulseDot } from '@/components/settings/settingsUi';
import BuyerTable from '@/components/operations/buyers/BuyerTable';
import BuyersEmptyState from '@/components/operations/buyers/BuyersEmptyState';
import BuyerActionDialog from '@/components/operations/buyers/BuyerActionDialog';
import BuyerDeleteDialog from '@/components/operations/buyers/BuyerDeleteDialog';
import BuyerDetailDrawer from '@/components/operations/buyers/BuyerDetailDrawer';
import BuyerCreateModal from '@/components/operations/buyers/BuyerCreateModal';
import { Button } from '@/components/ui/button';
import { Plus, RefreshCw } from 'lucide-react';
import { computeBlastRadius } from '@/components/operations/buyers/buyerListModel';
import { useRecomputeCoverage } from '@/components/operations/buyers/useRecomputeCoverage';
import RecomputingIndicator from '@/components/operations/buyers/RecomputingIndicator';
import {
  BUYER_AVAILABLE_COLUMNS, loadBuyerColumnConfig, saveBuyerColumnConfig, getBuyerColumnDef,
} from '@/components/operations/buyers/buyerColumns';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'Law Firm', label: 'Law Firms' },
  { key: 'Aggregator', label: 'Aggregators' },
  { key: 'Network', label: 'Networks' },
  { key: 'Reseller', label: 'Resellers' },
  { key: 'unclassified', label: 'Unclassified' },
];

// Match a buyer against a tab. Unclassified = client_type is null/empty.
function matchesTab(buyer, tabKey) {
  if (tabKey === 'all') return true;
  if (tabKey === 'unclassified') return !buyer.client_type;
  return buyer.client_type === tabKey;
}

export default function OperationsBuyers() {
  useTheme();
  const qc = useQueryClient();
  const [tab, setTab] = useState('all');
  const [sortKey, setSortKey] = useState('company_name');
  const [sortDir, setSortDir] = useState('asc');
  const [config, setConfig] = useState(loadBuyerColumnConfig);

  const [actionState, setActionState] = useState(null); // { action, buyer, closesStates }
  const [deleteState, setDeleteState] = useState(null); // { buyer }
  const [drawerBuyerId, setDrawerBuyerId] = useState(null);
  const [drawerTab, setDrawerTab] = useState('profile');
  const [createOpen, setCreateOpen] = useState(false);
  const [manualRecomputing, setManualRecomputing] = useState(false);
  const { recomputing, scheduleRecompute } = useRecomputeCoverage();

  const { data: buyers = [] } = useQuery({
    queryKey: ['op-buyers'],
    queryFn: () => api.entities.Buyer.list('-updated_date', 500),
  });

  const { data: cplRows = [] } = useQuery({
    queryKey: ['op-buyer-state-cpl'],
    queryFn: () => api.entities.BuyerStateCpl.list('', 2000),
  });

  const { data: stateStatuses = [] } = useQuery({
    queryKey: ['op-state-status'],
    queryFn: () => api.entities.StateStatus.list('', 2000),
  });

  const { data: verticals = [] } = useQuery({
    queryKey: ['op-verticals'],
    queryFn: () => api.entities.Vertical.filter({ active: true }, 'sort_order', 200),
  });

  // Resolve the drawer's buyer from the live list so edits reflect immediately.
  const drawerBuyer = buyers.find((b) => b.id === drawerBuyerId) || null;

  const ctx = { cplRows };

  const tabCounts = useMemo(() => {
    const counts = {};
    for (const t of TABS) counts[t.key] = buyers.filter((b) => matchesTab(b, t.key)).length;
    return counts;
  }, [buyers]);

  const rows = useMemo(() => {
    const filtered = buyers.filter((b) => matchesTab(b, tab));
    const col = getBuyerColumnDef(sortKey);
    if (!col) return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const av = col.sortValue(a, ctx);
      const bv = col.sortValue(b, ctx);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [buyers, tab, sortKey, sortDir, cplRows]);

  const onSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const onConfigChange = (next) => {
    setConfig(next);
    saveBuyerColumnConfig(next);
  };

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['op-buyers'] }),
    qc.invalidateQueries({ queryKey: ['op-buyer-state-cpl'] }),
    qc.invalidateQueries({ queryKey: ['op-state-status'] }),
  ]);

  // Instant status-only transition. The active boolean is derived at the data
  // layer, so it is never written from the UI.
  const transition = async (buyer, nextStatus) => {
    await api.entities.Buyer.update(buyer.id, { status: nextStatus });
    toast.success(`Buyer set to ${nextStatus}`);
    qc.invalidateQueries({ queryKey: ['op-buyers'] });
    // A status change flips the buyer's active flag, which changes which states
    // it can cover. Recompute after the write succeeds.
    scheduleRecompute(buyer);
  };

  const openPause = (buyer) => {
    setActionState({ action: 'pause', buyer, closesStates: computeBlastRadius(buyer.id, cplRows, stateStatuses) });
  };
  const openTerminate = (buyer) => {
    setActionState({ action: 'terminate', buyer, closesStates: computeBlastRadius(buyer.id, cplRows, stateStatuses) });
  };

  // Pause / Terminate: write the buyer status, then stamp the reason and paused
  // metadata on every BuyerStateCpl row belonging to this buyer. No engine call
  // and no notification are triggered from this page.
  const confirmAction = async (reason) => {
    const { action, buyer } = actionState;
    const nextStatus = action === 'pause' ? 'paused' : 'terminated';
    await api.entities.Buyer.update(buyer.id, { status: nextStatus });

    let me = null;
    try { me = await api.auth.me(); } catch {}
    const mine = cplRows.filter((r) => r.buyer_id === buyer.id);
    await Promise.all(mine.map((r) => api.entities.BuyerStateCpl.update(r.id, {
      paused_reason: reason,
      paused_at: new Date().toISOString(),
      paused_by: me?.id || '',
    })));

    toast.success(action === 'pause' ? 'Buyer paused' : 'Buyer terminated');
    qc.invalidateQueries({ queryKey: ['op-buyers'] });
    qc.invalidateQueries({ queryKey: ['op-buyer-state-cpl'] });
    scheduleRecompute(buyer);
  };

  const confirmDelete = async () => {
    const buyer = deleteState.buyer;
    await api.entities.Buyer.delete(buyer.id);
    toast.success('Buyer deleted');
    qc.invalidateQueries({ queryKey: ['op-buyers'] });
    scheduleRecompute(buyer);
  };

  const openBuyer = (buyer, atTab = 'profile') => {
    setDrawerTab(atTab);
    setDrawerBuyerId(buyer.id);
  };

  // Manual full recompute across all verticals. No buyer id, events enabled.
  // Reports the returned summary as a toast and refreshes the affected caches.
  const manualRecompute = async () => {
    setManualRecomputing(true);
    try {
      const res = await api.functions.invoke('recomputeStateStatus', { emit_events: true });
      const s = res?.data || {};
      toast.success(
        `Coverage recomputed. ${s.created ?? 0} created, ${s.updated ?? 0} updated, ${s.unchanged ?? 0} unchanged, ${s.events_written ?? 0} events written.`
      );
      await refresh();
    } catch (err) {
      toast.error(`Could not recompute coverage: ${err?.message || 'unknown error'}`);
    } finally {
      setManualRecomputing(false);
    }
  };

  // After creating a buyer, refresh the table and open it on Coverage, since a
  // buyer with no state coverage receives no leads.
  const onCreated = async (created) => {
    await qc.invalidateQueries({ queryKey: ['op-buyers'] });
    openBuyer(created, 'coverage');
  };

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Buyer Management" subtitle="Lifecycle, coverage and pricing for every buyer.">
        <RecomputingIndicator active={recomputing} className="mr-1" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          <PulseDot /> Live
        </span>
        <RefreshButton onClick={refresh} />
        <Button variant="outline" onClick={manualRecompute} disabled={manualRecomputing} className="gap-1.5">
          <RefreshCw className={`w-4 h-4 ${manualRecomputing ? 'animate-spin' : ''}`} />
          {manualRecomputing ? 'Recomputing...' : 'Recompute coverage'}
        </Button>
        <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> Create Buyer
        </Button>
      </SectionHeader>

      {buyers.length === 0 ? (
        <BuyersEmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1 border-b border-border flex-wrap">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3.5 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5
                    ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {t.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${tab === t.key ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {tabCounts[t.key] ?? 0}
                  </span>
                </button>
              ))}
            </div>
            <ColumnManager config={config} availableColumns={BUYER_AVAILABLE_COLUMNS} onChange={onConfigChange} />
          </div>

          <BuyerTable
            buyers={rows}
            config={config}
            ctx={ctx}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            onTransition={transition}
            onPause={openPause}
            onTerminate={openTerminate}
            onDelete={(buyer) => setDeleteState({ buyer })}
            onRowClick={(buyer) => openBuyer(buyer, 'profile')}
          />
        </>
      )}

      <BuyerActionDialog
        open={!!actionState}
        onOpenChange={(v) => { if (!v) setActionState(null); }}
        action={actionState?.action}
        buyer={actionState?.buyer}
        closesStates={actionState?.closesStates || []}
        onConfirm={confirmAction}
      />

      <BuyerDeleteDialog
        open={!!deleteState}
        onOpenChange={(v) => { if (!v) setDeleteState(null); }}
        buyer={deleteState?.buyer}
        onConfirm={confirmDelete}
      />

      <BuyerDetailDrawer
        open={!!drawerBuyer}
        onOpenChange={(v) => { if (!v) setDrawerBuyerId(null); }}
        buyer={drawerBuyer}
        verticals={verticals}
        initialTab={drawerTab}
      />

      <BuyerCreateModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        verticals={verticals}
        onCreated={onCreated}
      />
    </div>
  );
}