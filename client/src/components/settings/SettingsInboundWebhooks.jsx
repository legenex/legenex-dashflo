import React, { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Plus, Copy, RefreshCw, Trash2, ShieldAlert, Webhook } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const WEBHOOK_FN_URL = 'https://api.legenex.com/functions/leadbyteWebhook';
// Inbound URL shown in the list, without the token (token is one-time only).
const INBOUND_BASE_URL = WEBHOOK_FN_URL;

const EVENT_OPTIONS = [
  { value: 'sold', label: 'Sold' },
  { value: 'returned', label: 'Returned' },
  { value: 'unsold', label: 'Unsold' },
  { value: 'rejected', label: 'Rejected' },
];

// 32 random bytes rendered as a 64-char lowercase hex string.
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 hex digest of the exact token string. Identical to the server hash.
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function TokenRevealBox({ token, onClose }) {
  const fullUrl = `${WEBHOOK_FN_URL}?token=${token}`;
  return (
    <div className="space-y-4">
      <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="w-4 h-4 text-primary" />
          <span className="text-[13px] font-semibold text-primary">Copy this URL now - it is shown only once</span>
        </div>
        <div className="font-mono text-[12px] text-foreground break-all bg-background rounded-md p-3 border border-border mt-1">
          {fullUrl}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          The token cannot be retrieved later. Paste this whole URL into the LeadByte webhook URL field. If you lose it, rotate the token to generate a new one.
        </p>
      </div>
      <Button className="w-full gap-2" onClick={() => { navigator.clipboard.writeText(fullUrl); toast.success('Inbound URL copied'); }}>
        <Copy className="w-4 h-4" /> Copy URL
      </Button>
      <Button variant="ghost" className="w-full" onClick={onClose}>Done</Button>
    </div>
  );
}

export default function SettingsInboundWebhooks() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: '', event_type: 'sold' });
  const [reveal, setReveal] = useState(null); // one-time full token string
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: routes = [] } = useQuery({
    queryKey: ['inbound-webhook-routes'],
    queryFn: () => api.entities.InboundWebhookRoute.list('-created_date', 200),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['inbound-webhook-routes'] });

  const openCreate = () => {
    setForm({ name: '', event_type: 'sold' });
    setReveal(null);
    setModalOpen(true);
  };

  const handleCreate = async () => {
    const token = generateToken();
    const token_hash = await sha256Hex(token);
    await api.entities.InboundWebhookRoute.create({
      name: form.name,
      provider: 'leadbyte',
      event_type: form.event_type,
      enabled: true,
      token_hash,
      token_hint: token.slice(-4),
      receipt_count: 0,
      error_count: 0,
    });
    invalidate();
    setReveal(token);
  };

  const handleRotate = async (route) => {
    const token = generateToken();
    const token_hash = await sha256Hex(token);
    await api.entities.InboundWebhookRoute.update(route.id, {
      token_hash,
      token_hint: token.slice(-4),
    });
    invalidate();
    setReveal(token);
  };

  const toggleEnabled = async (route) => {
    await api.entities.InboundWebhookRoute.update(route.id, { enabled: !route.enabled });
    invalidate();
    toast.success(route.enabled ? 'Route disabled' : 'Route enabled');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await api.entities.InboundWebhookRoute.delete(deleteTarget.id);
    invalidate();
    setDeleteTarget(null);
    toast.success('Route deleted');
  };

  return (
    <div className="space-y-6">
      {/* Info panel */}
      <div className="bg-card border border-border rounded-[10px] p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-primary" />
          <div className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wider">LeadByte Outcome Webhooks</div>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          Each route gives LeadByte a token-authenticated URL to post lead outcome data back to. The token is generated in your browser and only its hash is stored, so the full URL is shown only once at creation or rotation. This endpoint records outcome data only - it never re-runs routing, delivery, or verification.
        </p>
        <div className="flex items-center gap-2">
          <code className="text-[12px] text-primary bg-primary/10 px-2 py-0.5 rounded font-mono flex-1 break-all">{INBOUND_BASE_URL}?token=…</code>
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> Create Route</Button>
      </div>

      {/* Routes table */}
      <div className="bg-card border border-border rounded-[10px] overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {['Name', 'Provider', 'Event', 'Enabled', 'Last Received', 'Receipts', 'Errors', 'Token', 'Inbound URL', 'Actions'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {routes.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">No inbound routes yet</td></tr>
            )}
            {routes.map((r) => (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                <td className="px-4 py-3 font-medium text-foreground">{r.name || '-'}</td>
                <td className="px-4 py-3">
                  <Badge className="bg-accent text-muted-foreground text-[10px] border border-border">{r.provider || 'leadbyte'}</Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground text-[12px] capitalize">{r.event_type || '-'}</td>
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
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{r.token_hint ? `...${r.token_hint}` : '-'}</td>
                <td className="px-4 py-3">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" title="Copy inbound URL (without token)"
                    onClick={() => { navigator.clipboard.writeText(INBOUND_BASE_URL); toast.success('Inbound URL copied (no token)'); }}>
                    <Copy className="w-3 h-3" /> URL
                  </Button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" title="Rotate token"
                      onClick={() => handleRotate(r)}>
                      <RefreshCw className="w-3 h-3" /> Rotate
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Delete"
                      onClick={() => setDeleteTarget(r)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create modal + one-time reveal */}
      <Dialog open={modalOpen} onOpenChange={(v) => { if (!v && !reveal) setModalOpen(false); }}>
        <DialogContent className="bg-popover border-border max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{reveal ? 'Route Created' : 'Create Inbound Route'}</DialogTitle>
          </DialogHeader>
          {reveal ? (
            <TokenRevealBox token={reveal} onClose={() => { setReveal(null); setModalOpen(false); }} />
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <Label className="text-[12px]">Name *</Label>
                  <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. LEGAL-MVA LeadByte Sold" className="mt-1 bg-background" />
                </div>
                <div>
                  <Label className="text-[12px]">Event Type</Label>
                  <SearchableSelect
                    value={form.event_type}
                    onValueChange={(v) => setForm((p) => ({ ...p, event_type: v }))}
                    className="mt-1 bg-background"
                    options={EVENT_OPTIONS}
                  />
                </div>
                <div>
                  <Label className="text-[12px]">Provider</Label>
                  <Input value="leadbyte" disabled className="mt-1 bg-background font-mono text-[12px]" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!form.name.trim()}>Generate Route</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete inbound route?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes "{deleteTarget?.name}" and its token immediately stops working. This cannot be undone.
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