import React, { useState, useMemo } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus, Copy, Trash2, Pencil, Webhook, KeyRound } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const WEBHOOK_FN_URL = 'https://api.legenex.com/functions/webhook';

// Blank event means dynamic: the status comes from lead_status on the payload.
const DYNAMIC = '__dynamic__';

const EVENT_OPTIONS = [
  { value: DYNAMIC, label: 'Dynamic (read lead_status from payload)' },
  { value: 'Sold', label: 'Sold' },
  { value: 'Unsold', label: 'Unsold' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Duplicate', label: 'Duplicate' },
  { value: 'Disqualified', label: 'Disqualified' },
  { value: 'Converted', label: 'Converted' },
];

const NO_SUPPLIER = '__none__';

const blankForm = { name: '', event_type: DYNAMIC, api_key_id: '', supplier_name: NO_SUPPLIER, notes: '' };

// The full URL a sender posts to. The key authenticates; route is optional and
// only exists so receipts and last-received land on the right row.
function inboundUrl(route, apiKey) {
  const key = apiKey?.key || apiKey?.key_prefix || 'YOUR_KEY';
  const base = `${WEBHOOK_FN_URL}?key=${key}`;
  return route?.id ? `${base}&route=${route.id}` : base;
}

export default function SettingsInboundWebhooks() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: routes = [] } = useQuery({
    queryKey: ['inbound-webhook-routes'],
    queryFn: () => api.entities.InboundWebhookRoute.list('-created_date', 200),
  });

  const { data: apiKeys = [] } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.entities.ApiKey.list('-created_date', 200),
  });

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers-for-webhooks'],
    queryFn: () => api.entities.Supplier.list('name', 200),
  });

  const keyById = useMemo(() => {
    const m = {};
    for (const k of apiKeys || []) m[k.id] = k;
    return m;
  }, [apiKeys]);

  const keyOptions = useMemo(() => (apiKeys || [])
    .filter((k) => k.active !== false)
    .map((k) => ({
      value: k.id,
      label: `${k.name}${k.type === 'master' ? ' (master)' : ''} - ${k.key_prefix}`,
    })), [apiKeys]);

  const supplierOptions = useMemo(() => [
    { value: NO_SUPPLIER, label: 'Match from sid on the payload' },
    ...(suppliers || []).map((s) => ({ value: s.name, label: s.name })),
  ], [suppliers]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['inbound-webhook-routes'] });

  const openCreate = () => {
    const master = (apiKeys || []).find((k) => k.type === 'master' && k.active !== false);
    setEditingId(null);
    setForm({ ...blankForm, api_key_id: master?.id || '' });
    setModalOpen(true);
  };

  const openEdit = (route) => {
    setEditingId(route.id);
    setForm({
      name: route.name || '',
      event_type: route.event_type || DYNAMIC,
      api_key_id: route.api_key_id || '',
      supplier_name: route.supplier_name || NO_SUPPLIER,
      notes: route.notes || '',
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const key = keyById[form.api_key_id];
    const payload = {
      name: form.name.trim(),
      event_type: form.event_type === DYNAMIC ? '' : form.event_type,
      api_key_id: form.api_key_id || '',
      api_key_name: key?.name || '',
      supplier_name: form.supplier_name === NO_SUPPLIER ? '' : form.supplier_name,
      notes: form.notes.trim(),
    };
    try {
      if (editingId) {
        await api.entities.InboundWebhookRoute.update(editingId, payload);
        toast.success('Webhook updated');
      } else {
        await api.entities.InboundWebhookRoute.create({
          ...payload, enabled: true, receipt_count: 0, error_count: 0,
        });
        toast.success('Webhook created');
      }
      invalidate();
      setModalOpen(false);
      setEditingId(null);
    } catch (e) {
      toast.error(e?.message || 'Could not save webhook');
    }
  };

  const toggleEnabled = async (route) => {
    await api.entities.InboundWebhookRoute.update(route.id, { enabled: !route.enabled });
    invalidate();
    toast.success(route.enabled ? 'Webhook disabled' : 'Webhook enabled');
  };

  const copyUrl = (route) => {
    const key = keyById[route.api_key_id];
    if (!key) {
      toast.error('Assign an API key to this webhook first');
      return;
    }
    navigator.clipboard.writeText(inboundUrl(route, key));
    toast.success('Inbound URL copied');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await api.entities.InboundWebhookRoute.delete(deleteTarget.id);
    invalidate();
    setDeleteTarget(null);
    toast.success('Webhook deleted');
  };

  return (
    <div className="space-y-6">
      {/* Info panel */}
      <div className="bg-card border border-border rounded-[10px] p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-primary" />
          <div className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wider">Inbound Webhooks</div>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          One endpoint takes lead outcomes from any platform that can POST JSON. Authentication is an API key on the URL, so there are no per-webhook tokens to rotate: use the master key, or a supplier key to pin every payload to that supplier. The supplier is otherwise read from <code className="font-mono text-[12px] text-foreground">sid</code> on the payload. Leave Event blank and the status is read from <code className="font-mono text-[12px] text-foreground">lead_status</code>. A lead that is not in the system is created; one that matches is updated.
        </p>
        <div className="flex items-center gap-2">
          <code className="text-[12px] text-primary bg-primary/10 px-2 py-0.5 rounded font-mono flex-1 break-all">{WEBHOOK_FN_URL}?key=…</code>
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> Create Webhook</Button>
      </div>

      {/* Webhooks table */}
      <div className="bg-card border border-border rounded-[10px] overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {['Name', 'Event', 'API Key', 'Supplier', 'Enabled', 'Last Received', 'Receipts', 'Errors', 'Actions'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {routes.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No inbound webhooks yet</td></tr>
            )}
            {routes.map((r) => {
              const key = keyById[r.api_key_id];
              return (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                <td className="px-4 py-3 font-medium text-foreground">{r.name || '-'}</td>
                <td className="px-4 py-3 text-[12px]">
                  {r.event_type
                    ? <span className="text-muted-foreground">{r.event_type}</span>
                    : <span className="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-primary">dynamic</span>}
                </td>
                <td className="px-4 py-3 text-[12px]">
                  {key
                    ? (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground font-mono text-[11px]">
                        <KeyRound className="w-3 h-3" />{key.key_prefix}…
                      </span>
                    )
                    : <span className="text-muted-foreground">unassigned</span>}
                </td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{r.supplier_name || 'from sid'}</td>
                <td className="px-4 py-3">
                  <Switch checked={!!r.enabled} onCheckedChange={() => toggleEnabled(r)} />
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.last_received_at ? format(new Date(r.last_received_at), 'MMM dd HH:mm') : '-'}
                </td>
                <td className="px-4 py-3 font-mono text-[12px]">{r.receipt_count || 0}</td>
                <td className="px-4 py-3 font-mono text-[12px]">
                  <span className={r.error_count ? 'status-error' : ''}>{r.error_count || 0}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" title="Copy the full inbound URL including the key"
                      onClick={() => copyUrl(r)}>
                      <Copy className="w-3 h-3" /> URL
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" title="Edit webhook"
                      onClick={() => openEdit(r)}>
                      <Pencil className="w-3 h-3" /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Delete"
                      onClick={() => setDeleteTarget(r)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Create and edit */}
      <Dialog open={modalOpen} onOpenChange={(v) => { if (!v) { setModalOpen(false); setEditingId(null); } }}>
        <DialogContent className="bg-popover border-border max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Webhook' : 'Create Webhook'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-[12px]">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Inbounds Webhook" className="mt-1 bg-background" />
            </div>
            <div>
              <Label className="text-[12px]">Event</Label>
              <SearchableSelect
                value={form.event_type}
                onValueChange={(v) => setForm((p) => ({ ...p, event_type: v }))}
                className="mt-1 bg-background"
                options={EVENT_OPTIONS}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Leave on Dynamic unless this sender only ever posts one status. Dynamic reads lead_status from the payload.
              </p>
            </div>
            <div>
              <Label className="text-[12px]">API Key *</Label>
              <SearchableSelect
                value={form.api_key_id}
                onValueChange={(v) => setForm((p) => ({ ...p, api_key_id: v }))}
                className="mt-1 bg-background"
                options={keyOptions}
                placeholder="Select an API key"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Keys are managed in Settings, API Keys. Several webhooks can share one key.
              </p>
            </div>
            <div>
              <Label className="text-[12px]">Supplier</Label>
              <SearchableSelect
                value={form.supplier_name}
                onValueChange={(v) => setForm((p) => ({ ...p, supplier_name: v }))}
                className="mt-1 bg-background"
                options={supplierOptions}
              />
            </div>
            <div>
              <Label className="text-[12px]">Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional" className="mt-1 bg-background" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setModalOpen(false); setEditingId(null); }}>Cancel</Button>
            <Button onClick={handleSave} disabled={!form.name.trim() || !form.api_key_id}>
              {editingId ? 'Save Changes' : 'Create Webhook'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete inbound webhook?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes "{deleteTarget?.name}". The API key keeps working elsewhere, but receipts stop being counted against this row. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
