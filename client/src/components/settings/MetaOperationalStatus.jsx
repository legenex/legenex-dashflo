import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { metaConnectionStatus } from '@/functions/metaConnectionStatus';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertTriangle, Facebook, RefreshCw } from 'lucide-react';

const fmt = (value) => value ? new Date(value).toLocaleString() : 'Never';

export default function MetaOperationalStatus() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['meta-connection-status'],
    queryFn: async () => (await metaConnectionStatus({})).data,
  });

  if (isLoading) return <p className="text-[13px] text-muted-foreground">Loading Meta status...</p>;

  const connections = data?.connections || [];
  const accounts = data?.accounts || [];
  const healthy = connections.length > 0 && connections.every((c) => !c.action_required);
  const latest = accounts
    .map((a) => a.last_synced_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const failures = accounts.filter((a) => a.last_sync_status && a.last_sync_status !== 'success');

  return (
    <div className="space-y-5">
      {!data?.meta_app?.configured && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-foreground">Meta application credentials are missing</div>
            <p className="text-[12px] text-muted-foreground mt-0.5">Facebook Login cannot start until the owner configures the platform credential.</p>
          </div>
          <Button size="sm" onClick={() => { window.location.href = '/settings?tab=apikeys'; }}>Manage Meta credentials in API Keys</Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          ['Connection health', healthy ? 'Healthy' : connections.length ? 'Action required' : 'Not connected'],
          ['Connected accounts', connections.length],
          ['Configured ad accounts', accounts.length],
          ['Lead form mappings', data?.mapping_count || 0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-1 text-[16px] font-semibold text-foreground">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <Facebook className="h-4 w-4 text-primary" />
          <div className="text-[13px] font-semibold">Operational status</div>
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5" onClick={() => refetch()}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
        </div>
        <div className="p-4 space-y-3 text-[12px]">
          <div className="flex items-center gap-2">
            {healthy ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <AlertTriangle className="h-4 w-4 text-muted-foreground" />}
            <span>{healthy ? 'All connected Meta credentials are currently healthy.' : 'One or more Meta connections need attention.'}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-muted-foreground">
            <div>Last synchronization <span className="text-foreground">{fmt(latest)}</span></div>
            <div>Latest result <span className="text-foreground">{failures.length ? `${failures.length} account failure(s)` : accounts.length ? 'Success' : 'No sync yet'}</span></div>
            <div>Scheduled sync <span className="text-foreground">{data?.sync?.enabled ? `Every ${data.sync.interval_minutes || 60} minutes` : 'Disabled'}</span></div>
          </div>
          {connections.map((connection) => (
            <div key={connection.id} className="rounded-md border border-border bg-background p-3">
              <div className="font-medium text-foreground">{connection.connected_account_name || connection.name}</div>
              <div className="mt-1 text-muted-foreground">Status: {connection.status || 'unknown'}; last validated: {fmt(connection.last_validated_at)}</div>
              {connection.last_error && <div className="mt-1 text-destructive">{connection.last_error}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
