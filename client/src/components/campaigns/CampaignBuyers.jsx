import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, ArrowDownUp } from 'lucide-react';
import { toast } from 'sonner';
import { money } from '@/lib/partnerMetrics';
import ImportExportDialog from '@/components/shared/ImportExportDialog';
import { TableShell, Row, Tag, EmptyRow } from '@/components/campaigns/campaignTable';
import RowActionsMenu from '@/components/campaigns/RowActionsMenu';

const BUYER_TEMPLATE = '1.6fr 0.8fr 0.9fr 1fr 0.9fr 0.9fr 0.9fr 0.9fr 1fr 0.9fr 0.9fr 0.9fr 0.8fr';

const BLANK = {
  company_name: '', email: '', phone: '', location: '',
  buyer_type: '', vertical: '', billing_mode: 'lead_count',
  billing_model: '', billing_email: '', min_balance: 0,
};

export default function CampaignBuyers() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [editId, setEditId] = useState(null);
  const [ioOpen, setIoOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: buyers = [] } = useQuery({
    queryKey: ['buyers'],
    queryFn: () => api.entities.Buyer.list('-created_date'),
  });
  const { data: verticalList = [] } = useQuery({
    queryKey: ['verticals'],
    queryFn: () => api.entities.Vertical.list(),
  });
  const verticalOptions = verticalList.map(v => ({ value: v.code, label: v.name }));

  const openCreate = () => { setForm(BLANK); setEditId(null); setModal(true); };

  const openEdit = (b, e) => {
    e.stopPropagation();
    setForm({
      company_name: b.company_name || '', email: b.email || '', phone: b.phone || '',
      location: b.location || '', buyer_type: b.buyer_type || '', vertical: b.vertical || '',
      billing_mode: b.billing_mode || 'lead_count', billing_model: b.billing_model || '',
      billing_email: b.billing_email || '', min_balance: b.min_balance ?? 0,
    });
    setEditId(b.id); setModal(true);
  };

  const buyerPayload = () => ({
    company_name: form.company_name,
    email: form.email,
    phone: form.phone,
    location: form.location,
    buyer_type: form.buyer_type,
    vertical: form.vertical,
    billing_mode: form.billing_mode,
    billing_model: form.billing_model,
    billing_email: form.billing_email,
    min_balance: Number(form.min_balance) || 0,
  });

  const createBuyer = async () => {
    await api.entities.Buyer.create({ ...buyerPayload(), portal_enabled: false, balance: 0, active: true });
    qc.invalidateQueries({ queryKey: ['buyers'] });
    setModal(false);
    toast.success('Buyer created');
  };

  const saveEdit = async () => {
    await api.entities.Buyer.update(editId, buyerPayload());
    qc.invalidateQueries({ queryKey: ['buyers'] });
    setModal(false); setEditId(null);
    toast.success('Buyer updated');
  };

  const cloneBuyer = async (b, e) => {
    e.stopPropagation();
    await api.entities.Buyer.create({
      company_name: `${b.company_name} (Copy)`, email: b.email, phone: b.phone,
      location: b.location, buyer_type: b.buyer_type, vertical: b.vertical,
      billing_mode: b.billing_mode, billing_model: b.billing_model, billing_email: b.billing_email,
      min_balance: b.min_balance || 0, portal_enabled: false, balance: 0, active: true,
    });
    qc.invalidateQueries({ queryKey: ['buyers'] });
    toast.success('Buyer cloned');
  };

  const deleteBuyer = async () => {
    if (!deleteTarget) return;
    await api.entities.Buyer.delete(deleteTarget.id);
    setDeleteTarget(null);
    qc.invalidateQueries({ queryKey: ['buyers'] });
    toast.success('Buyer deleted');
  };

  const togglePortal = async (b, e) => {
    e.stopPropagation();
    await api.entities.Buyer.update(b.id, { portal_enabled: !b.portal_enabled });
    qc.invalidateQueries({ queryKey: ['buyers'] });
  };

  const COLS = ['Buyer Name', 'Portal', 'Type', 'Vertical', 'Balance', 'Min Balance', 'Card', 'Auto Recharge', 'Billing', 'Revenue', 'Cost', 'Profit', 'Actions'];

  return (
    <div>
      <div className="flex justify-end gap-2 mb-4">
        <Button size="sm" variant="outline" onClick={() => setIoOpen(true)} className="gap-1.5"><ArrowDownUp className="w-4 h-4" /> Import / Export Fields</Button>
        <Button size="sm" onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> New Buyer</Button>
      </div>

      <ImportExportDialog
        open={ioOpen}
        onOpenChange={setIoOpen}
        entityName="Buyer"
        records={buyers}
        matchKey="company_name"
        labelKey="company_name"
        exportPrefix="buyers"
        queryKeys={[['buyers']]}
        title="Import / Export Buyers"
      />

      <TableShell head={COLS} template={BUYER_TEMPLATE} minWidth="1000px">
        {buyers.length === 0 && <EmptyRow>No buyers yet. Buyers can be created manually or are auto-created from LeadByte sold responses.</EmptyRow>}
        {buyers.map((b, i) => (
          <Row key={b.id} template={BUYER_TEMPLATE} i={i} onClick={() => navigate(`/buyers/${b.id}`)}>
            <span className="min-w-0">
              <span className="block font-medium text-foreground truncate">{b.company_name}</span>
              {b.auto_created && <Badge variant="outline" className="text-[9px] mt-0.5 text-muted-foreground">Auto</Badge>}
            </span>
            <span onClick={e => e.stopPropagation()}>
              <Switch checked={!!b.portal_enabled} onClick={(e) => togglePortal(b, e)} onCheckedChange={() => {}} />
            </span>
            <span className="text-[12px] text-muted-foreground truncate">{b.buyer_type || '-'}</span>
            <span className="text-[12px] text-muted-foreground truncate">{b.vertical || '-'}</span>
            <span className="text-right font-mono text-[12px] text-foreground">{money(b.balance)}</span>
            <span className="text-right font-mono text-[12px] text-foreground">{money(b.min_balance)}</span>
            <span className="text-right font-mono text-[12px] text-foreground">{b.card_last4 ? `•••• ${b.card_last4}` : '-'}</span>
            <span>{b.auto_recharge ? <Tag tone="green">On</Tag> : <span className="text-muted-foreground text-[12px]">Off</span>}</span>
            <span><Badge variant="outline" className="text-[10px]">{b.billing_mode === 'wallet' ? 'Wallet' : 'Lead Count'}</Badge></span>
            <span className="text-right font-mono text-[12px] status-sold">-</span>
            <span className="text-right font-mono text-[12px] text-foreground">-</span>
            <span className="text-right font-mono text-[12px] text-foreground">-</span>
            <span className="flex items-center justify-end">
              <RowActionsMenu
                onEdit={(e) => openEdit(b, e)}
                onClone={(e) => cloneBuyer(b, e)}
                onDelete={(e) => { e.stopPropagation(); setDeleteTarget(b); }}
              />
            </span>
          </Row>
        ))}
      </TableShell>

      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="bg-popover border-border max-w-[520px]">
          <DialogHeader><DialogTitle>{editId ? 'Edit Buyer' : 'New Buyer'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label className="text-[12px]">Company Name *</Label><Input value={form.company_name} onChange={e => setForm(p => ({ ...p, company_name: e.target.value }))} placeholder="e.g. Acme Legal" className="mt-1 bg-background" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-[12px]">Email</Label><Input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="contact@buyer.com" className="mt-1 bg-background" /></div>
              <div><Label className="text-[12px]">Phone</Label><Input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} placeholder="(555) 123-4567" className="mt-1 bg-background" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-[12px]">Location</Label><Input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} className="mt-1 bg-background" /></div>
              <div>
                <Label className="text-[12px]">Buyer Type</Label>
                <SearchableSelect
                  value={form.buyer_type}
                  onValueChange={v => setForm(p => ({ ...p, buyer_type: v }))}
                  className="mt-1 bg-background"
                  placeholder="Select…"
                  options={[
                    { value: 'Direct', label: 'Direct' },
                    { value: 'Aggregator', label: 'Aggregator' },
                    { value: 'Network', label: 'Network' },
                  ]}
                />
              </div>
            </div>
            <div>
              <Label className="text-[12px]">Vertical (optional)</Label>
              <SearchableSelect
                value={form.vertical}
                onValueChange={v => setForm(p => ({ ...p, vertical: v }))}
                className="mt-1 bg-background"
                placeholder="Any vertical"
                options={[{ value: '', label: 'Any vertical' }, ...verticalOptions]}
              />
            </div>
            <div>
              <Label className="text-[12px] mb-2 block">Billing Mode</Label>
              <div className="grid grid-cols-2 gap-2">
                {[{ v: 'lead_count', l: 'Lead Count', d: 'Operator-managed, invoiced' }, { v: 'wallet', l: 'Wallet', d: 'Prepaid, auto-deducted' }].map(o => (
                  <button key={o.v} type="button" onClick={() => setForm(p => ({ ...p, billing_mode: o.v }))}
                    className={`text-left p-2.5 rounded-lg border transition-all ${form.billing_mode === o.v ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-accent/40'}`}>
                    <div className="text-[13px] font-medium text-foreground">{o.l}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{o.d}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-[12px]">Billing Model</Label><Input value={form.billing_model} onChange={e => setForm(p => ({ ...p, billing_model: e.target.value }))} placeholder="e.g. Net 30, Prepaid" className="mt-1 bg-background" /></div>
              <div><Label className="text-[12px]">Billing Email</Label><Input value={form.billing_email} onChange={e => setForm(p => ({ ...p, billing_email: e.target.value }))} className="mt-1 bg-background" /></div>
            </div>
            {form.billing_mode === 'wallet' && (
              <div><Label className="text-[12px]">Min Balance ($)</Label><Input type="number" value={form.min_balance} onChange={e => setForm(p => ({ ...p, min_balance: e.target.value }))} className="mt-1 bg-background font-mono text-[12px]" /></div>
            )}
            <p className="text-[11px] text-muted-foreground">Portal access, wallet funding, and invoicing can be configured after creation.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setModal(false); setEditId(null); }}>Cancel</Button>
            {editId ? (
              <Button onClick={saveEdit} disabled={!form.company_name}>Save Changes</Button>
            ) : (
              <Button onClick={createBuyer} disabled={!form.company_name}>Create Buyer</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete buyer?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete "{deleteTarget?.company_name}". This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteBuyer} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}