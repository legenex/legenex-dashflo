import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { metaAssets } from '@/functions/metaAssets';
import { syncMetaSpend } from '@/functions/syncMetaSpend';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Facebook, Save, RefreshCw, Plus, Trash2, Link2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

const SYNC_OPTIONS = [
  { value: '15m', label: 'Every 15 minutes' },
  { value: '1h', label: 'Hourly' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
];

export default function MetaAdSpend() {
  const qc = useQueryClient();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [form, setForm] = useState(null);

  const { data: assets, isLoading, refetch } = useQuery({
    queryKey: ['meta-assets'],
    queryFn: async () => (await metaAssets({})).data,
  });
  const connected = !!assets?.connected;

  const { data: mappings = [] } = useQuery({
    queryKey: ['adspend-mappings'],
    queryFn: () => api.entities.AdSpendMapping.list('-created_date'),
  });
  const { data: verticals = [] } = useQuery({ queryKey: ['verticals'], queryFn: () => api.entities.Vertical.list('sort_order') });
  const { data: brands = [] } = useQuery({ queryKey: ['brands'], queryFn: () => api.entities.Brand.list() });
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.entities.Supplier.list() });

  const saveToken = async () => {
    if (!token.trim()) { toast.error('Enter your Meta access token'); return; }
    setSaving(true);
    try {
      const list = await api.entities.IntegrationConfig.filter({ name: 'meta' });
      const payload = JSON.stringify({ access_token: token.trim() });
      if (list[0]) await api.entities.IntegrationConfig.update(list[0].id, { config: payload });
      else await api.entities.IntegrationConfig.create({ name: 'meta', config: payload });
      toast.success('Meta connected');
      setTokenOpen(false); setToken('');
      await refetch();
    } catch { toast.error('Failed to save token'); }
    setSaving(false);
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await syncMetaSpend({});
      const d = res?.data || {};
      if (d.success) toast.success(`Synced ${d.rows_synced} spend rows from ${d.mappings} mappings`);
      else toast.error(d.error || 'Sync failed');
      qc.invalidateQueries({ queryKey: ['adspend'] });
    } catch (e) { toast.error(e?.response?.data?.error || 'Sync failed'); }
    setSyncing(false);
  };

  const openMap = () => {
    setForm({
      platform: 'meta', ad_account_id: '', ad_account_name: '', meta_campaign_id: '', meta_campaign_name: '',
      match_level: 'ad_account', vertical: '', brand: '', supplier_name: '', cost_source: 'Meta Ads', sync_interval: '1h', enabled: true,
    });
    setMapOpen(true);
  };

  const saveMapping = async () => {
    if (!form.ad_account_id) { toast.error('Select an ad account'); return; }
    const acct = (assets?.ad_accounts || []).find(a => a.id === form.ad_account_id);
    await api.entities.AdSpendMapping.create({ ...form, ad_account_name: acct?.name || '' });
    qc.invalidateQueries({ queryKey: ['adspend-mappings'] });
    setMapOpen(false);
    toast.success('Mapping created');
  };

  const deleteMapping = async (id) => {
    await api.entities.AdSpendMapping.delete(id);
    qc.invalidateQueries({ queryKey: ['adspend-mappings'] });
    toast.success('Mapping removed');
  };

  return (
    <div className="space-y-5">
      {/* Connection card */}
      <div className="bg-card border border-border rounded-[12px] p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Facebook className="w-5 h-5 text-primary" /></div>
            <div>
              <div className="text-[14px] font-semibold text-foreground">Meta (Facebook) Ads</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">Connect to sync ad spend and calculate true CPL per supplier & source.</div>
              {connected && assets?.account && (
                <div className="text-[11px] status-sold inline-flex items-center gap-1 mt-1.5 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Connected as {assets.account.name}
                </div>
              )}
              {assets?.error && <div className="text-[11px] text-destructive mt-1.5">{assets.error}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected && <Button size="sm" variant="outline" className="gap-1.5" onClick={runSync} disabled={syncing}><RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Sync Now</Button>}
            <Button size="sm" variant={connected ? 'outline' : 'default'} className="gap-1.5" onClick={() => setTokenOpen(true)}>
              <Link2 className="w-3.5 h-3.5" /> {connected ? 'Reconnect' : 'Connect'}
            </Button>
          </div>
        </div>

        {connected && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t border-border">
            {[
              { label: 'Business Managers', n: assets.businesses?.length || 0 },
              { label: 'Ad Accounts', n: assets.ad_accounts?.length || 0 },
              { label: 'Pages', n: assets.pages?.length || 0 },
              { label: 'Lead Forms', n: assets.lead_forms?.length || 0 },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className="text-[18px] font-bold text-foreground font-mono">{s.n}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mappings */}
      {connected && (
        <div className="bg-card border border-border rounded-[12px] p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-[13px] font-semibold text-foreground">Campaign Mappings</div>
              <div className="text-[12px] text-muted-foreground">Map ad accounts or campaigns to a vertical, brand and supplier.</div>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openMap}><Plus className="w-3.5 h-3.5" /> Map to Campaign</Button>
          </div>
          {mappings.length === 0 ? (
            <p className="text-[13px] text-muted-foreground py-4 text-center">No mappings yet.</p>
          ) : (
            <div className="space-y-2">
              {mappings.map(m => (
                <div key={m.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background">
                  <div className="min-w-0">
                    <div className="text-[13px] text-foreground truncate">{m.ad_account_name || m.ad_account_id} {m.meta_campaign_name && `· ${m.meta_campaign_name}`}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      <Badge variant="outline" className="text-[10px]">{m.match_level}</Badge>
                      {m.vertical && <Badge variant="outline" className="text-[10px]">{m.vertical}</Badge>}
                      {m.brand && <Badge variant="outline" className="text-[10px]">{m.brand}</Badge>}
                      {m.supplier_name && <Badge variant="outline" className="text-[10px]">{m.supplier_name}</Badge>}
                      <span className="text-[10px] text-muted-foreground">· sync {SYNC_OPTIONS.find(o => o.value === m.sync_interval)?.label}</span>
                    </div>
                  </div>
                  <button onClick={() => deleteMapping(m.id)} className="text-muted-foreground hover:text-destructive p-1"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Token dialog */}
      <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
        <DialogContent className="bg-popover border-border max-w-[480px]">
          <DialogHeader><DialogTitle>Connect Meta</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-[12px]">Meta Access Token</Label>
              <Input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="Long-lived user or system-user token" className="mt-1 bg-background font-mono text-[12px]" />
              <p className="text-[11px] text-muted-foreground mt-1.5">Needs ads_read + leads_retrieval + pages_show_list. Generate a long-lived token in your Meta App and paste it here.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTokenOpen(false)}>Cancel</Button>
            <Button onClick={saveToken} disabled={saving} className="gap-1.5"><Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save & Connect'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mapping dialog */}
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="bg-popover border-border max-w-[480px]">
          <DialogHeader><DialogTitle>Map to Campaign</DialogTitle></DialogHeader>
          {form && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              <div>
                <Label className="text-[12px]">Ad Account *</Label>
                <Select value={form.ad_account_id} onValueChange={v => setForm(p => ({ ...p, ad_account_id: v }))}>
                  <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="Select ad account" /></SelectTrigger>
                  <SelectContent>{(assets?.ad_accounts || []).map(a => <SelectItem key={a.id} value={a.id}>{a.name} ({a.account_id})</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[12px]">Match Level</Label>
                <Select value={form.match_level} onValueChange={v => setForm(p => ({ ...p, match_level: v }))}>
                  <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ad_account">Ad Account</SelectItem>
                    <SelectItem value="campaign">Campaign</SelectItem>
                    <SelectItem value="ad_set">Ad Set</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.match_level !== 'ad_account' && (
                <div>
                  <Label className="text-[12px]">Meta Campaign ID</Label>
                  <Input value={form.meta_campaign_id} onChange={e => setForm(p => ({ ...p, meta_campaign_id: e.target.value }))} placeholder="Campaign / ad set id" className="mt-1 bg-background font-mono text-[12px]" />
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-[12px]">Vertical</Label>
                  <Select value={form.vertical} onValueChange={v => setForm(p => ({ ...p, vertical: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>{verticals.map(v => <SelectItem key={v.id} value={v.code}>{v.code}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[12px]">Brand</Label>
                  <Select value={form.brand} onValueChange={v => setForm(p => ({ ...p, brand: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>{brands.map(b => <SelectItem key={b.id} value={b.brand_code}>{b.brand_code}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[12px]">Supplier</Label>
                  <Select value={form.supplier_name} onValueChange={v => setForm(p => ({ ...p, supplier_name: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>{suppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[12px]">Cost Source</Label>
                  <Input value={form.cost_source} onChange={e => setForm(p => ({ ...p, cost_source: e.target.value }))} className="mt-1 bg-background text-[13px]" />
                </div>
                <div>
                  <Label className="text-[12px]">Auto-Sync</Label>
                  <Select value={form.sync_interval} onValueChange={v => setForm(p => ({ ...p, sync_interval: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue /></SelectTrigger>
                    <SelectContent>{SYNC_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMapOpen(false)}>Cancel</Button>
            <Button onClick={saveMapping}>Create Mapping</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}