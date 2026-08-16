import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/lib/AuthContext';
import { systemKeys } from '@/functions/systemKeys';
import MetaAppCredentialsCard from '@/components/settings/MetaAppCredentialsCard';
import Base44SyncStatus from '@/components/settings/Base44SyncStatus';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { KeyRound, Pencil, Plus, Lock } from 'lucide-react';
import { toast } from 'sonner';

const EMPTY = { name: '', provider: 'other', purpose: '', env_var: '', client_id: '', secret: '', active: true };
const PROVIDERS = ['openai', 'anthropic', 'gemini', 'meta', 'mcp_server', 'other'];

export default function SettingsSystemKeys() {
  const { realRole } = usePermissions();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const { data = [] } = useQuery({
    queryKey: ['system-keys'],
    queryFn: async () => ((await systemKeys({ op: 'system_list' })).data?.keys || []),
    enabled: realRole === 'owner',
  });

  if (realRole !== 'owner') {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <Lock className="h-5 w-5 text-muted-foreground mx-auto" />
        <div className="mt-2 text-[14px] font-semibold">System Keys are owner only</div>
        <p className="mt-1 text-[12px] text-muted-foreground">Supplier and buyer API keys remain available in their own categories.</p>
      </div>
    );
  }

  const edit = (row = null) => {
    setForm(row ? {
      id: row.id, name: row.name || '', provider: row.provider || 'other', purpose: row.purpose || '',
      env_var: row.env_var || '', client_id: row.client_id || '', secret: '', active: row.active !== false,
    } : EMPTY);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const out = (await systemKeys({ op: 'system_save', ...form })).data;
      if (out?.success === false) throw new Error(out.error);
      toast.success(form.id ? 'System key updated' : 'System key created');
      setOpen(false); setForm(EMPTY);
      qc.invalidateQueries({ queryKey: ['system-keys'] });
      qc.invalidateQueries({ queryKey: ['meta-connection-status'] });
    } catch (error) { toast.error(error?.message || 'Could not save system key'); }
    setSaving(false);
  };

  const nonMeta = data.filter((key) => key.provider !== 'meta');

  return (
    <div className="space-y-6">
      <MetaAppCredentialsCard />

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <div className="text-[13px] font-semibold">Other platform credentials</div>
          <Button size="sm" className="ml-auto gap-1.5" onClick={() => edit()}><Plus className="h-3.5 w-3.5" /> Add system key</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead><tr className="border-b border-border bg-muted/50">
              {['Name', 'Provider', 'Purpose', 'Credential', 'State', ''].map((h) => <th key={h} className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {nonMeta.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No additional system keys configured</td></tr>}
              {nonMeta.map((key) => (
                <tr key={key.id}>
                  <td className="px-4 py-3 font-medium">{key.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{key.provider}</td>
                  <td className="px-4 py-3 text-muted-foreground">{key.purpose || '-'}</td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{key.secret_masked || 'Not set'}</td>
                  <td className="px-4 py-3">{key.active === false ? 'Inactive' : 'Active'}</td>
                  <td className="px-4 py-3"><Button size="sm" variant="ghost" onClick={() => edit(key)}><Pencil className="h-3.5 w-3.5" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Base44SyncStatus />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[520px] bg-popover border-border">
          <DialogHeader><DialogTitle>{form.id ? 'Edit system key' : 'Add system key'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input className="mt-1 bg-background" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></div>
            <div><Label>Provider</Label><SearchableSelect className="mt-1 bg-background" value={form.provider} onValueChange={(provider) => setForm((p) => ({ ...p, provider }))} options={PROVIDERS.map((p) => ({ value: p, label: p }))} /></div>
            <div><Label>Purpose</Label><Input className="mt-1 bg-background" value={form.purpose} onChange={(e) => setForm((p) => ({ ...p, purpose: e.target.value }))} /></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label>Environment name</Label><Input className="mt-1 bg-background font-mono" value={form.env_var} onChange={(e) => setForm((p) => ({ ...p, env_var: e.target.value }))} /></div>
              <div><Label>Client ID</Label><Input className="mt-1 bg-background font-mono" value={form.client_id} onChange={(e) => setForm((p) => ({ ...p, client_id: e.target.value }))} /></div>
            </div>
            <div><Label>Secret</Label><Input type="password" autoComplete="new-password" className="mt-1 bg-background font-mono" value={form.secret} onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))} placeholder={form.id ? 'Leave blank to keep the stored value' : 'Credential value'} /></div>
            <div className="flex items-center gap-2"><Switch checked={form.active} onCheckedChange={(active) => setForm((p) => ({ ...p, active }))} /><Label>Active</Label></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={saving || !form.name}>{saving ? 'Saving...' : 'Save'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
