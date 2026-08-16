import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { systemKeys } from '@/functions/systemKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Copy, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

export default function SettingsBuyerKeys() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ buyer_id: '', name: '' });
  const [reveal, setReveal] = useState('');
  const [saving, setSaving] = useState(false);
  const { data: buyers = [] } = useQuery({ queryKey: ['buyers'], queryFn: () => api.entities.Buyer.list('company_name', 500) });
  const { data: keys = [] } = useQuery({
    queryKey: ['buyer-api-keys'],
    queryFn: async () => ((await systemKeys({ op: 'buyer_list' })).data?.keys || []),
  });

  const create = async () => {
    setSaving(true);
    try {
      const out = (await systemKeys({ op: 'buyer_create', ...form })).data;
      if (out?.success === false) throw new Error(out.error);
      setReveal(out.key); setOpen(false); setForm({ buyer_id: '', name: '' });
      qc.invalidateQueries({ queryKey: ['buyer-api-keys'] });
    } catch (error) { toast.error(error?.message || 'Could not create buyer API key'); }
    setSaving(false);
  };

  const toggle = async (key) => {
    const out = (await systemKeys({ op: 'buyer_update', id: key.id, active: key.active === false })).data;
    if (out?.success === false) toast.error(out.error || 'Could not update key');
    else qc.invalidateQueries({ queryKey: ['buyer-api-keys'] });
  };

  const rotate = async (key) => {
    if (!window.confirm(`Rotate ${key.name}? The current value will stop working immediately.`)) return;
    const out = (await systemKeys({ op: 'buyer_rotate', id: key.id })).data;
    if (out?.success === false) toast.error(out.error || 'Could not rotate key');
    else { setReveal(out.key); qc.invalidateQueries({ queryKey: ['buyer-api-keys'] }); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-muted-foreground max-w-2xl">Optional credentials tied to buyers. Existing values and buyer relationships are preserved; supplier gateway keys remain separate.</p>
        <Button size="sm" className="gap-1.5 shrink-0" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> Create buyer key</Button>
      </div>
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead><tr className="border-b border-border bg-muted/50">
            {['Name', 'Buyer', 'Prefix', 'Usage', 'State', 'Actions'].map((h) => <th key={h} className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {keys.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No buyer API keys configured</td></tr>}
            {keys.map((key) => (
              <tr key={key.id}>
                <td className="px-4 py-3 font-medium">{key.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{key.buyer_name || key.buyer_id}</td>
                <td className="px-4 py-3 font-mono text-muted-foreground">{key.key_prefix || key.key_masked || '-'}</td>
                <td className="px-4 py-3 text-muted-foreground">{key.request_count || 0}</td>
                <td className="px-4 py-3">{key.active === false ? 'Inactive' : 'Active'}{key.legacy ? ' (legacy)' : ''}</td>
                <td className="px-4 py-3">
                  {key.legacy ? <span className="text-[11px] text-muted-foreground">Preserved read-only</span> : (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggle(key)}>{key.active === false ? 'Activate' : 'Deactivate'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => rotate(key)} title="Rotate"><RefreshCw className="h-3.5 w-3.5" /></Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[460px] bg-popover border-border">
          <DialogHeader><DialogTitle>Create buyer API key</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Buyer</Label><SearchableSelect className="mt-1 bg-background" value={form.buyer_id} onValueChange={(buyer_id) => setForm((p) => ({ ...p, buyer_id }))} options={buyers.map((b) => ({ value: b.id, label: b.company_name || b.buyer_code || b.id }))} /></div>
            <div><Label>Name</Label><Input className="mt-1 bg-background" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Optional label" /></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create} disabled={saving || !form.buyer_id}>{saving ? 'Creating...' : 'Generate key'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(reveal)} onOpenChange={(value) => { if (!value) setReveal(''); }}>
        <DialogContent className="max-w-[480px] bg-popover border-border">
          <DialogHeader><DialogTitle>Copy this buyer key now</DialogTitle></DialogHeader>
          <p className="text-[12px] text-muted-foreground">The full value is shown only in this response. Store it securely.</p>
          <div className="rounded-md border border-border bg-background p-3 font-mono text-[12px] break-all">{reveal}</div>
          <Button className="gap-1.5" onClick={() => { navigator.clipboard.writeText(reveal); toast.success('Buyer key copied'); }}><Copy className="h-3.5 w-3.5" /> Copy key</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
