import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44SyncControl } from '@/functions/base44SyncControl';
import { Button } from '@/components/ui/button';
import { RefreshCw, Database, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const fmt = (value) => value ? new Date(value).toLocaleString() : 'Never';

export default function Base44SyncStatus() {
  const [running, setRunning] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [result, setResult] = useState(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['base44-sync-status'],
    queryFn: async () => (await base44SyncControl({ op: 'status', limit: 8 })).data,
    refetchInterval: 60_000,
  });

  const runSync = async () => {
    setRunning(true); setResult(null);
    try {
      const out = (await base44SyncControl({ op: 'sync' })).data;
      setResult(out);
      if (out.status === 'success') toast.success('Base44 delta sync completed');
      else toast.error(`Base44 sync ${out.status || 'failed'}`);
      await refetch();
    } catch (error) { toast.error(error?.message || 'Base44 sync failed'); }
    setRunning(false);
  };

  const reconcile = async () => {
    setReconciling(true); setResult(null);
    try {
      const out = (await base44SyncControl({ op: 'reconcile' })).data;
      setResult(out);
      if (out.clean) toast.success('Reconciliation is clean');
      else toast.error('Reconciliation found differences');
    } catch (error) { toast.error(error?.message || 'Reconciliation failed'); }
    setReconciling(false);
  };

  const last = data?.lastRun;
  const good = last?.status === 'success';

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <div className="text-[13px] font-semibold text-foreground">Base44 migration sync</div>
        <span className={`ml-auto text-[11px] ${data?.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
          {data?.enabled ? 'Automatic sync enabled' : 'Automatic sync disabled'}
        </span>
      </div>
      <div className="p-4 space-y-4">
        {isLoading ? <p className="text-[12px] text-muted-foreground">Loading migration status...</p> : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md border border-border bg-background p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Latest result</div>
                <div className="mt-1 flex items-center gap-1.5 text-[13px] font-medium">
                  {good ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />}
                  {last?.status || (data?.configured ? 'No runs yet' : 'Not configured')}
                </div>
              </div>
              <div className="rounded-md border border-border bg-background p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Last attempted</div>
                <div className="mt-1 text-[12px] text-foreground">{fmt(last?.started_at)}</div>
              </div>
              <div className="rounded-md border border-border bg-background p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Last successful</div>
                <div className="mt-1 text-[12px] text-foreground">{fmt(data?.lastSuccessfulRun?.finished_at)}</div>
              </div>
            </div>
            {last && (
              <p className="text-[12px] text-muted-foreground">
                Inspected {last.records_inspected || 0}, created {last.records_created || 0}, updated {last.records_updated || 0},
                skipped {last.records_skipped || 0}, conflicts {last.records_conflicted || 0}, failed {last.records_failed || 0}.
              </p>
            )}
          </>
        )}

        {result && (
          <div className="rounded-md border border-border bg-background p-3 text-[12px] text-muted-foreground">
            {result.summary
              ? `Reconciliation: ${result.summary.missingLocally || 0} only in Base44, ${result.summary.localOnly || 0} only in DashFlo, ${result.summary.stale || 0} stale, ${result.summary.conflicts || 0} conflicts.`
              : `Sync result: ${result.status || 'unknown'}. ${result.totals?.created || 0} created, ${result.totals?.updated || 0} updated, ${result.totals?.conflicted || 0} conflicts, ${result.totals?.failed || 0} failed.`}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling || running || !data?.configured}>
            {reconciling ? 'Reconciling...' : 'Reconcile'}
          </Button>
          <Button size="sm" onClick={runSync} disabled={running || reconciling || !data?.configured} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Syncing...' : 'Run delta sync'}
          </Button>
        </div>
      </div>
    </div>
  );
}
