import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { metaAssets } from '@/functions/metaAssets';
import { syncMetaSpend } from '@/functions/syncMetaSpend';
import { validateMetaToken } from '@/functions/validateMetaToken';
import MetaAccountSelectDialog from '@/components/settings/MetaAccountSelectDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Facebook, RefreshCw, Plus, Trash2, CheckCircle2, ShieldCheck, XCircle, Search, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';

const SYNC_OPTIONS = [
  { value: '15m', label: 'Every 15 minutes' },
  { value: '1h', label: 'Hourly' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
];

// Mask a token so only its last 4 characters are visible.
const maskToken = (tok) => {
  const s = String(tok || '');
  if (s.length <= 4) return '••••';
  return `••••••••${s.slice(-4)}`;
};

const genId = () => `tok_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Read the stored meta config, returning the IntegrationConfig record (or null) and parsed config object.
const loadMetaConfig = async () => {
  const list = await api.entities.IntegrationConfig.filter({ name: 'meta' });
  const record = list[0] || null;
  let config = {};
  try { config = JSON.parse(record?.config || '{}'); } catch { config = {}; }
  return { record, config };
};

// Normalize whatever is stored into a tokens array, migrating a legacy single token.
const readTokens = (config) => {
  if (Array.isArray(config.tokens) && config.tokens.length) {
    return config.tokens.filter(t => t && t.token).map((t, i) => ({ id: t.id || `token_${i}`, label: t.label || `Token ${i + 1}`, token: t.token, account_ids: Array.isArray(t.account_ids) ? t.account_ids : [] }));
  }
  const legacy = config.system_user_token || config.master_token || config.access_token || '';
  if (legacy) return [{ id: 'default', label: 'Default', token: legacy, account_ids: [] }];
  return [];
};

export default function MetaAdSpend() {
  const qc = useQueryClient();
  const [storedTokens, setStoredTokens] = useState([]);
  const [newLabel, setNewLabel] = useState('');
  const [newToken, setNewToken] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  // Account-selection dialog state. mode 'add' = validating a new token, 'edit' = managing an existing one.
  const [selDialog, setSelDialog] = useState(null); // { mode, label, token, tokenId, accounts, chosen:Set, search, saving }
  const [removingId, setRemovingId] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [syncedIds, setSyncedIds] = useState([]);
  const [acctSearch, setAcctSearch] = useState('');

  const { data: assets, refetch } = useQuery({
    queryKey: ['meta-assets'],
    queryFn: async () => (await metaAssets({})).data,
  });

  // Load the stored token list (labels + tokens for masking) alongside the live summary.
  useQuery({
    queryKey: ['meta-config-tokens'],
    queryFn: async () => {
      const { config } = await loadMetaConfig();
      const toks = readTokens(config);
      setStoredTokens(toks);
      setSyncedIds(Array.isArray(config.synced_account_ids) ? config.synced_account_ids : []);
      return toks;
    },
  });

  const tokenSummaries = assets?.tokens || [];
  const validCount = tokenSummaries.filter(t => t.valid).length;
  const connected = validCount > 0;
  // Only accounts selected in synced_account_ids are shown and counted.
  const syncedAccounts = (assets?.ad_accounts || []).filter(a => syncedIds.includes(a.id));
  const adAccountCount = syncedAccounts.length;

  const { data: mappings = [] } = useQuery({
    queryKey: ['adspend-mappings'],
    queryFn: () => api.entities.AdSpendMapping.list('-created_date'),
  });
  const { data: verticals = [] } = useQuery({ queryKey: ['verticals'], queryFn: () => api.entities.Vertical.list('sort_order') });
  const { data: brands = [] } = useQuery({ queryKey: ['brands'], queryFn: () => api.entities.Brand.list() });
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.entities.Supplier.list() });

  // Persist the given tokens array onto the meta config, then refresh both the
  // stored list and the live per-token summary from metaAssets.
  const persistTokens = async (tokens) => {
    const { record, config } = await loadMetaConfig();
    const payload = JSON.stringify({ ...config, tokens });
    if (record) await api.entities.IntegrationConfig.update(record.id, { config: payload });
    else await api.entities.IntegrationConfig.create({ name: 'meta', config: payload });
    setStoredTokens(tokens);
    await refetch();
    qc.invalidateQueries({ queryKey: ['meta-config-tokens'] });
  };

  const addToken = async () => {
    setAddError('');
    if (!newLabel.trim()) { toast.error('Enter a Business Manager label'); return; }
    if (!newToken.trim()) { toast.error('Enter a Meta system-user token'); return; }
    setAdding(true);
    try {
      // Validate the pasted token against the Graph API before saving it.
      const check = (await validateMetaToken({ token: newToken.trim() })).data || {};
      if (!check.valid) {
        setAddError(check.error || 'Meta rejected this token');
        setAdding(false);
        return;
      }
      // Valid: do not save yet. Open the account selection step with the reachable accounts.
      setSelDialog({
        mode: 'add',
        label: newLabel.trim(),
        token: newToken.trim(),
        tokenId: null,
        accounts: check.ad_accounts || [],
        chosen: (check.ad_accounts || []).map(a => a.id),
        saving: false,
      });
    } catch (e) {
      setAddError(e?.response?.data?.error || 'Failed to validate token');
    }
    setAdding(false);
  };

  // Open the selection dialog for an existing token so its accounts can be managed.
  const manageAccounts = async (row) => {
    setSelDialog({ mode: 'edit', label: row.label, token: row.token, tokenId: row.id, accounts: [], chosen: row.account_ids || [], saving: true, loading: true });
    try {
      const check = (await validateMetaToken({ token: row.token })).data || {};
      if (!check.valid) {
        toast.error(check.error || 'Meta rejected this token');
        setSelDialog(null);
        return;
      }
      setSelDialog(s => s ? { ...s, accounts: check.ad_accounts || [], saving: false, loading: false } : s);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load accounts');
      setSelDialog(null);
    }
  };

  // Confirm the selection: save the token (or update it) with account_ids, and
  // reconcile config.synced_account_ids so it always contains the chosen ids.
  const confirmSelection = async (chosenIds) => {
    if (!selDialog) return;
    setSelDialog(s => ({ ...s, saving: true }));
    try {
      const { record, config } = await loadMetaConfig();
      const current = readTokens(config);
      let nextTokens;
      let prevIds = [];
      if (selDialog.mode === 'add') {
        nextTokens = [...current, { id: genId(), label: selDialog.label, token: selDialog.token, account_ids: chosenIds }];
      } else {
        const existing = current.find(t => t.id === selDialog.tokenId);
        prevIds = existing?.account_ids || [];
        nextTokens = current.map(t => t.id === selDialog.tokenId ? { ...t, account_ids: chosenIds } : t);
      }
      // Reconcile synced_account_ids: drop this token's previous ids, then add chosen.
      const baseSynced = Array.isArray(config.synced_account_ids) ? config.synced_account_ids : [];
      const withoutPrev = baseSynced.filter(id => !prevIds.includes(id));
      const nextSynced = Array.from(new Set([...withoutPrev, ...chosenIds]));

      const payload = JSON.stringify({ ...config, tokens: nextTokens, synced_account_ids: nextSynced });
      if (record) await api.entities.IntegrationConfig.update(record.id, { config: payload });
      else await api.entities.IntegrationConfig.create({ name: 'meta', config: payload });

      setStoredTokens(nextTokens);
      setSyncedIds(nextSynced);
      await refetch();
      qc.invalidateQueries({ queryKey: ['meta-config-tokens'] });
      if (selDialog.mode === 'add') { setNewLabel(''); setNewToken(''); }
      setSelDialog(null);
      toast.success(selDialog.mode === 'add' ? `Token added with ${chosenIds.length} account${chosenIds.length === 1 ? '' : 's'}` : 'Accounts updated');
    } catch {
      toast.error('Failed to save selection');
      setSelDialog(s => s ? { ...s, saving: false } : s);
    }
  };

  const removeToken = async (id) => {
    setRemovingId(id);
    try {
      const { record, config } = await loadMetaConfig();
      const tokens = readTokens(config);
      const removed = tokens.find(t => t.id === id);
      const next = tokens.filter(t => t.id !== id);
      const removedIds = removed?.account_ids || [];
      const baseSynced = Array.isArray(config.synced_account_ids) ? config.synced_account_ids : [];
      const nextSynced = baseSynced.filter(x => !removedIds.includes(x));
      const payload = JSON.stringify({ ...config, tokens: next, synced_account_ids: nextSynced });
      if (record) await api.entities.IntegrationConfig.update(record.id, { config: payload });
      setStoredTokens(next);
      setSyncedIds(nextSynced);
      await refetch();
      qc.invalidateQueries({ queryKey: ['meta-config-tokens'] });
      toast.success('Token removed');
    } catch { toast.error('Failed to remove token'); }
    setRemovingId('');
  };

  // Refresh the live summary and show combined + per-token coverage.
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const fresh = (await metaAssets({})).data;
      qc.setQueryData(['meta-assets'], fresh);
      const summaries = fresh?.tokens || [];
      setTestResult({
        total_accounts: fresh?.ad_accounts?.length || 0,
        valid: summaries.filter(t => t.valid).length,
        tokens: summaries,
      });
    } catch (e) {
      setTestResult({ error: e?.response?.data?.error || 'Connection test failed' });
    }
    setTesting(false);
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
    const acct = syncedAccounts.find(a => a.id === form.ad_account_id);
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

  // Merge stored token metadata (label, masked value) with the live summary by id.
  const rows = storedTokens.map(st => {
    const summary = tokenSummaries.find(s => s.id === st.id) || {};
    return { ...st, valid: summary.valid, accounts: summary.accounts || 0, error: summary.error || '' };
  });

  return (
    <div className="space-y-5">
      {/* Connection card */}
      <div className="bg-card border border-border rounded-[12px] p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Facebook className="w-5 h-5 text-primary" /></div>
            <div>
              <div className="text-[14px] font-semibold text-foreground">Meta (Facebook) Ads</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">Add one system-user token per Business Manager to sync ad spend and calculate true CPL per supplier and source.</div>
              {connected && (
                <div className="text-[11px] status-sold inline-flex items-center gap-1 mt-1.5 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Connected with {validCount} valid token{validCount === 1 ? '' : 's'}
                </div>
              )}
              {assets?.error && <div className="text-[11px] text-destructive mt-1.5">{assets.error}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected && <Button size="sm" variant="outline" className="gap-1.5" onClick={testConnection} disabled={testing}><ShieldCheck className={`w-3.5 h-3.5 ${testing ? 'animate-pulse' : ''}`} /> Test connection and coverage</Button>}
            {connected && <Button size="sm" variant="outline" className="gap-1.5" onClick={runSync} disabled={syncing}><RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Sync Now</Button>}
          </div>
        </div>

        {connected && (
          <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-border">
            {[
              { label: 'Business Managers', n: validCount },
              { label: 'Ad Accounts', n: adAccountCount },
              { label: 'Tokens', n: rows.length },
            ].map(s => (
              <div key={s.label} className="text-center">
                <div className="text-[18px] font-bold text-foreground font-mono">{s.n}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Token manager */}
        <div className="mt-4 pt-4 border-t border-border">
          <div className="text-[13px] font-semibold text-foreground mb-2">Business Manager Tokens</div>
          {rows.length === 0 ? (
            <p className="text-[12px] text-muted-foreground py-2">No tokens yet. Add a system-user token for each Business Manager below.</p>
          ) : (
            <div className="space-y-2">
              {rows.map(r => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] text-foreground font-medium truncate">{r.label}</div>
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{maskToken(r.token)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.valid === true ? (
                      <span className="text-[11px] status-sold inline-flex items-center gap-1 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Valid · {(r.account_ids || []).length} account{(r.account_ids || []).length === 1 ? '' : 's'} synced
                      </span>
                    ) : r.valid === false ? (
                      <span className="text-[11px] status-error inline-flex items-center gap-1 font-medium max-w-[220px] truncate" title={r.error}>
                        <XCircle className="w-3.5 h-3.5 shrink-0" /> {r.error || 'Invalid token'}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Checking…</span>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={() => manageAccounts(r)}><SlidersHorizontal className="w-3 h-3" /> Manage accounts</Button>
                    <button onClick={() => removeToken(r.id)} disabled={removingId === r.id} className="text-muted-foreground hover:text-destructive p-1 disabled:opacity-50"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add token */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_auto] gap-2 mt-3">
            <div>
              <Label className="text-[11px] text-muted-foreground">Business Manager label</Label>
              <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. Acme BM" className="mt-1 bg-background text-[13px]" />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">System-user token</Label>
              <Input value={newToken} onChange={e => { setNewToken(e.target.value); setAddError(''); }} type="password" placeholder="Long-lived system-user token" className="mt-1 bg-background font-mono text-[12px]" />
            </div>
            <div className="flex items-end">
              <Button size="sm" className="gap-1.5 w-full" onClick={addToken} disabled={adding}><Plus className="w-3.5 h-3.5" /> {adding ? 'Checking…' : 'Add'}</Button>
            </div>
          </div>
          {addError && (
            <div className="mt-2 text-[11px] status-error inline-flex items-start gap-1.5 font-medium">
              <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {addError}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-1.5">Each token needs ads_read plus leads_retrieval plus pages_show_list. A system-user token reaches one Business Manager, so add one per Business Manager.</p>
        </div>

        {/* Ad accounts selected for sync (read only; selection happens per token) */}
        {connected && (() => {
          const q = acctSearch.trim().toLowerCase();
          const filtered = q
            ? syncedAccounts.filter(a =>
                `${a.name || ''} ${a.account_id || ''} ${a.token_label || ''}`.toLowerCase().includes(q))
            : syncedAccounts;
          return (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-[13px] font-semibold text-foreground">Ad Accounts Synced</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {syncedAccounts.length} account{syncedAccounts.length === 1 ? '' : 's'} selected for sync. Use Manage accounts on a token above to change the selection.
                  </div>
                </div>
              </div>

              {syncedAccounts.length === 0 ? (
                <div className="mt-2 text-[11px] tag-neutral inline-flex items-center gap-1.5 rounded-md px-2 py-1">
                  No accounts selected yet. Nothing will sync until you pick some when adding or managing a token.
                </div>
              ) : (
                <>
                  <div className="relative mt-3">
                    <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <Input value={acctSearch} onChange={e => setAcctSearch(e.target.value)} placeholder="Search accounts by name, id or Business Manager" className="pl-8 bg-background text-[13px]" />
                  </div>
                  {filtered.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground py-3">No accounts match "{acctSearch}".</p>
                  ) : (
                    <div className="mt-3 space-y-2 max-h-[320px] overflow-y-auto pr-1">
                      {filtered.map(a => (
                        <div key={a.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] text-foreground font-medium truncate">{a.name || a.account_id}</div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className="text-[11px] text-muted-foreground font-mono">{a.account_id}</span>
                              {a.currency && <Badge variant="outline" className="text-[10px]">{a.currency}</Badge>}
                              {a.token_label && <Badge variant="outline" className="text-[10px]">{a.token_label}</Badge>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {testResult && (
          <div className="mt-4 pt-4 border-t border-border">
            {testResult.error ? (
              <div className="p-3 rounded-lg bg-status-error border border-border">
                <div className="text-[12px] status-error inline-flex items-center gap-1.5 font-medium"><XCircle className="w-4 h-4" /> {testResult.error}</div>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-status-sold border border-border">
                <div className="text-[12px] status-sold inline-flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="w-4 h-4" /> {testResult.valid} valid token{testResult.valid === 1 ? '' : 's'} reaching {testResult.total_accounts} ad account{testResult.total_accounts === 1 ? '' : 's'} combined
                </div>
                <div className="mt-2 space-y-1 text-[11px]">
                  {testResult.tokens.map(t => (
                    <div key={t.id} className={t.valid ? 'text-foreground' : 'status-error'}>
                      <span className="font-medium">{t.label}:</span> {t.valid ? `valid, ${t.accounts} account${t.accounts === 1 ? '' : 's'}` : (t.error || 'invalid token')}
                    </div>
                  ))}
                </div>
              </div>
            )}
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
                  <SelectContent>{syncedAccounts.map(a => <SelectItem key={a.id} value={a.id}>{a.name} ({a.account_id})</SelectItem>)}</SelectContent>
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
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="Any" /></SelectTrigger>
                    <SelectContent>{verticals.map(v => <SelectItem key={v.id} value={v.code}>{v.code}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[12px]">Brand</Label>
                  <Select value={form.brand} onValueChange={v => setForm(p => ({ ...p, brand: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="Any" /></SelectTrigger>
                    <SelectContent>{brands.map(b => <SelectItem key={b.id} value={b.brand_code}>{b.brand_code}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[12px]">Supplier</Label>
                  <Select value={form.supplier_name} onValueChange={v => setForm(p => ({ ...p, supplier_name: v }))}>
                    <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="Any" /></SelectTrigger>
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

      <MetaAccountSelectDialog
        state={selDialog}
        onChange={(next) => setSelDialog(s => s ? { ...s, chosen: next } : s)}
        onConfirm={confirmSelection}
        onCancel={() => setSelDialog(null)}
      />
    </div>
  );
}