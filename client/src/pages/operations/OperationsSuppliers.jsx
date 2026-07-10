import React, { useState, useMemo } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SectionHeader from '@/components/shared/SectionHeader';
import RefreshButton from '@/components/shared/RefreshButton';
import ColumnManager from '@/components/leads/ColumnManager';
import { PulseDot } from '@/components/settings/settingsUi';
import SupplierTable from '@/components/operations/suppliers/SupplierTable';
import SuppliersEmptyState from '@/components/operations/suppliers/SuppliersEmptyState';
import SupplierCreateModal from '@/components/operations/suppliers/SupplierCreateModal';
import SupplierActionDialog from '@/components/operations/suppliers/SupplierActionDialog';
import SupplierDeleteDialog from '@/components/operations/suppliers/SupplierDeleteDialog';
import NoChannelBanner from '@/components/operations/suppliers/NoChannelBanner';
import SupplierDetailDrawer from '@/components/operations/suppliers/SupplierDetailDrawer';
import { suppliersWithNoChannel } from '@/components/operations/suppliers/supplierListModel';
import {
  SUPPLIER_AVAILABLE_COLUMNS, loadSupplierColumnConfig, saveSupplierColumnConfig, getSupplierColumnDef,
} from '@/components/operations/suppliers/supplierColumns';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'Internal', label: 'Internal' },
  { key: 'External', label: 'External' },
  { key: 'Calls', label: 'Calls' },
];

// Match a supplier against a tab by its supplier_type field.
function matchesTab(supplier, tabKey) {
  if (tabKey === 'all') return true;
  return supplier.supplier_type === tabKey;
}

export default function OperationsSuppliers() {
  useTheme();
  const qc = useQueryClient();
  const [tab, setTab] = useState('all');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [config, setConfig] = useState(loadSupplierColumnConfig);

  const [actionState, setActionState] = useState(null); // { action, supplier }
  const [deleteState, setDeleteState] = useState(null); // { supplier }
  const [drawer, setDrawer] = useState(null); // { supplierId, tab }
  const [createOpen, setCreateOpen] = useState(false);

  const { data: suppliers = [] } = useQuery({
    queryKey: ['op-suppliers'],
    queryFn: () => api.entities.Supplier.list('-updated_date', 500),
  });

  const { data: sources = [] } = useQuery({
    queryKey: ['op-supplier-sources'],
    queryFn: () => api.entities.SupplierSource.list('', 2000),
  });

  const ctx = { sources };

  const tabCounts = useMemo(() => {
    const counts = {};
    for (const t of TABS) counts[t.key] = suppliers.filter((s) => matchesTab(s, t.key)).length;
    return counts;
  }, [suppliers]);

  const noChannelCount = useMemo(() => suppliersWithNoChannel(suppliers).length, [suppliers]);

  const rows = useMemo(() => {
    const filtered = suppliers.filter((s) => matchesTab(s, tab));
    const col = getSupplierColumnDef(sortKey);
    if (!col) return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const av = col.sortValue(a, ctx);
      const bv = col.sortValue(b, ctx);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [suppliers, tab, sortKey, sortDir, sources]);

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
    saveSupplierColumnConfig(next);
  };

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['op-suppliers'] }),
    qc.invalidateQueries({ queryKey: ['op-supplier-sources'] }),
  ]);

  // Instant status-only transition. The active boolean is derived at the data
  // layer, so it is never written from the UI.
  const transition = async (supplier, nextStatus) => {
    await api.entities.Supplier.update(supplier.id, { status: nextStatus });
    toast.success(`Supplier set to ${nextStatus}`);
    qc.invalidateQueries({ queryKey: ['op-suppliers'] });
  };

  const openPause = (supplier) => setActionState({ action: 'pause', supplier });
  const openTerminate = (supplier) => setActionState({ action: 'terminate', supplier });

  // Pause / Terminate: write only the Supplier status field. No engine call and
  // no notification are triggered from this page.
  const confirmAction = async () => {
    const { action, supplier } = actionState;
    const nextStatus = action === 'pause' ? 'paused' : 'terminated';
    await api.entities.Supplier.update(supplier.id, { status: nextStatus });
    toast.success(action === 'pause' ? 'Supplier paused' : 'Supplier terminated');
    qc.invalidateQueries({ queryKey: ['op-suppliers'] });
  };

  const confirmDelete = async () => {
    await api.entities.Supplier.delete(deleteState.supplier.id);
    toast.success('Supplier deleted');
    qc.invalidateQueries({ queryKey: ['op-suppliers'] });
  };

  // After a create, refresh the table then open the new supplier on Sources,
  // since a supplier with no source falls back to its supplier level payout.
  const onCreated = async (created) => {
    await refresh();
    setDrawer({ supplierId: created.id, tab: 'sources' });
  };

  // Open the detail drawer. Row click lands on Payout; the Channels Fix link
  // lands on Notifications.
  const openSupplier = (supplier) => setDrawer({ supplierId: supplier.id, tab: 'payout' });
  const fixChannel = (supplier) => setDrawer({ supplierId: supplier.id, tab: 'notifications' });

  // Resolve the live record so the drawer reflects list refreshes after saves.
  const drawerSupplier = drawer ? suppliers.find((s) => s.id === drawer.supplierId) : null;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Supplier Management" subtitle="Payouts, sources and notification health for every supplier.">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          <PulseDot /> Live
        </span>
        <RefreshButton onClick={refresh} />
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> Create Supplier
        </Button>
      </SectionHeader>

      {suppliers.length === 0 ? (
        <SuppliersEmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <NoChannelBanner count={noChannelCount} />

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
            <ColumnManager config={config} availableColumns={SUPPLIER_AVAILABLE_COLUMNS} onChange={onConfigChange} />
          </div>

          <SupplierTable
            suppliers={rows}
            sources={sources}
            config={config}
            ctx={ctx}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            onTransition={transition}
            onPause={openPause}
            onTerminate={openTerminate}
            onDelete={(supplier) => setDeleteState({ supplier })}
            onRowClick={openSupplier}
            onFixChannel={fixChannel}
          />
        </>
      )}

      <SupplierActionDialog
        open={!!actionState}
        onOpenChange={(v) => { if (!v) setActionState(null); }}
        action={actionState?.action}
        supplier={actionState?.supplier}
        onConfirm={confirmAction}
      />

      <SupplierDeleteDialog
        open={!!deleteState}
        onOpenChange={(v) => { if (!v) setDeleteState(null); }}
        supplier={deleteState?.supplier}
        onConfirm={confirmDelete}
      />

      <SupplierDetailDrawer
        open={!!drawer}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        supplier={drawerSupplier}
        initialTab={drawer?.tab || 'payout'}
      />

      <SupplierCreateModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onCreated}
      />
    </div>
  );
}