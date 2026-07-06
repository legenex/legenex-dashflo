import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Sheet as SheetIcon, Phone, Plus, RefreshCw, Pencil, Trash2, Loader2, Copy } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import SheetSourceDialog from '@/components/settings/SheetSourceDialog';
import CallSourceDialog from '@/components/settings/CallSourceDialog';

const KIND_META = {
  google_sheets: { label: 'Google Sheets', icon: SheetIcon },
  ringba: { label: 'Ringba', icon: Phone },
  truecall: { label: 'TrueCall', icon: Phone },
};

export default function LeadSourcesPanel() {
  const qc = useQueryClient();
  const [sheetDialog, setSheetDialog] = useState({ open: false, source: null });
  const [callDialog, setCallDialog] = useState({ open: false, source: null, provider: 'ringba' });
  const [syncing, setSyncing] = useState(null);

  const { data: sources = [] } = useQuery({ queryKey: ['lead-sources'], queryFn: () => api.entities.LeadSource.list('-created_date', 100) });
  const { data: appSettingsArr = [] } = useQuery({ queryKey: ['app-settings'], queryFn: () => api.entities.AppSettings.list() });
  const baseUrl = appSettingsArr[0]?.public_base_url || 'https://api.legenex.com';

  const refresh = () => qc.invalidateQueries({ queryKey: ['lead-sources'] });

  const syncNow = async (s) => {
    setSyncing(s.id);
    try {
      const res = await api.functions.invoke('syncGoogleSheets', { source_id: s.id });
      const r = res.data?.results?.[0];
      if (r?.error) toast.error(`Sync failed: ${r.error}`);
      else toast.success(`Synced — ingested ${r?.ingested ?? 0} of ${r?.rows ?? 0} rows`);
      refresh();
    } catch (err) {
      toast.error('Sync failed');
    }
    setSyncing(null);
  };

  const toggleEnabled = async (s) => {
    await api.entities.LeadSource.update(s.id, { enabled: !s.enabled });
    refresh();
  };

  const remove = async (s) => {
    await api.entities.LeadSource.delete(s.id);
    toast.success('Source removed');
    refresh();
  };

  const editSource = (s) => {
    if (s.kind === 'google_sheets') setSheetDialog({ open: true, source: s });
    else setCallDialog({ open: true, source: s, provider: s.kind });
  };

  const copyEndpoint = (s) => {
    const url = `${baseUrl}/functions/callWebhook?key=${s.webhook_key}`;
    navigator.clipboard.writeText(url);
    toast.success('Endpoint URL copied');
  };

  return (
    <div className="bg-card border border-border rounded-[12px] p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[15px] font-semibold text-foreground">Lead Sources</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSheetDialog({ open: true, source: null })}><Plus className="w-3.5 h-3.5" /> Google Sheets</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCallDialog({ open: true, source: null, provider: 'ringba' })}><Plus className="w-3.5 h-3.5" /> Ringba</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCallDialog({ open: true, source: null, provider: 'truecall' })}><Plus className="w-3.5 h-3.5" /> TrueCall</Button>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground mb-4 max-w-2xl">
        Connected ingestion paths that flow through the same processing pipeline as your API and LeadByte — validation, dedup, conversion events and revenue all run. LeadByte and the generic webhook are unaffected.
      </div>

      {sources.length === 0 && (
        <div className="text-[13px] text-muted-foreground py-8 text-center border border-dashed border-border rounded-[10px]">
          No lead sources yet. Add a Google Sheets pull or a Ringba / TrueCall call webhook.
        </div>
      )}

      <div className="space-y-2">
        {sources.map(s => {
          const meta = KIND_META[s.kind] || KIND_META.google_sheets;
          const Icon = meta.icon;
          const isCall = s.kind === 'ringba' || s.kind === 'truecall';
          return (
            <div key={s.id} className="flex items-center gap-3 border border-border rounded-[10px] px-4 py-3">
              <Icon className="w-4 h-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground truncate">{s.name}</span>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">{meta.label}</Badge>
                  {!s.enabled && <Badge variant="outline" className="text-[10px] text-muted-foreground">Paused</Badge>}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.supplier_name || 'No supplier'}
                  {s.last_synced_at ? ` · ${s.last_sync_status || 'synced'} · ${formatDistanceToNow(new Date(s.last_synced_at), { addSuffix: true })}` : ' · never synced'}
                  {` · ${s.ingested_count || 0} ingested`}
                </div>
              </div>
              <Switch checked={s.enabled} onCheckedChange={() => toggleEnabled(s)} />
              {s.kind === 'google_sheets' && (
                <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-[12px]" onClick={() => syncNow(s)} disabled={syncing === s.id}>
                  {syncing === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
                </Button>
              )}
              {isCall && s.webhook_key && (
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="Copy endpoint URL" onClick={() => copyEndpoint(s)}><Copy className="w-3.5 h-3.5" /></Button>
              )}
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => editSource(s)}><Pencil className="w-3.5 h-3.5" /></Button>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => remove(s)}><Trash2 className="w-3.5 h-3.5" /></Button>
            </div>
          );
        })}
      </div>

      <SheetSourceDialog open={sheetDialog.open} source={sheetDialog.source} onOpenChange={(v) => setSheetDialog(p => ({ ...p, open: v }))} onSaved={refresh} />
      <CallSourceDialog open={callDialog.open} source={callDialog.source} provider={callDialog.provider} onOpenChange={(v) => setCallDialog(p => ({ ...p, open: v }))} onSaved={refresh} />
    </div>
  );
}