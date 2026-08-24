import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { MultiSelect } from '@/components/ui/multi-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { resolveApiBaseUrl } from '@/lib/urls';
import { createSupplierKey, rotateSupplierKey } from '@/lib/supplierKeys';
import { issueApiKey } from '@/functions/issueApiKey';


const DEFAULT_FORM = {
  name: '', sid: '', supplier_type: '', vertical: '', payout_type: '', payout_value: null, email: '',
  landing_page_url: '', brand: [], active: true,
};

function parseBrandArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed) return [String(parsed)];
  } catch {
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export default function SettingsSuppliers() {
  const qc = useQueryClient();
  const [supplierModal, setSupplierModal] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingSupplierId, setEditingSupplierId] = useState(null);
  const [newKeyFull, setNewKeyFull] = useState(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlSaved, setBaseUrlSaved] = useState(false);
  const [apiKeyCreateOpen, setApiKeyCreateOpen] = useState(false);
  const [apiKeyForm, setApiKeyForm] = useState({ name: '', type: 'supplier', supplier_id: '', vertical: '', active: true });

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.entities.Supplier.list('-created_date'),
  });

  const { data: apiKeys = [] } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.entities.ApiKey.list(),
  });

  const { data: appSettingsArr = [] } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => api.entities.AppSettings.list(),
  });

  const { data: brands = [] } = useQuery({
    queryKey: ['brands'],
    queryFn: () => api.entities.Brand.list(),
  });

  const { data: verticalList = [] } = useQuery({
    queryKey: ['verticals'],
    queryFn: () => api.entities.Vertical.list(),
  });
  const verticalOptions = verticalList.map(v => ({ value: v.code, label: v.name }));

  const appSettings = appSettingsArr[0] || {};
  const savedBaseUrl = resolveApiBaseUrl(appSettings.public_api_base_url || appSettings.public_base_url);

  React.useEffect(() => {
    if (appSettingsArr.length > 0 && !baseUrl) {
      setBaseUrl(resolveApiBaseUrl(appSettings.public_api_base_url || appSettings.public_base_url));
    }
  }, [appSettingsArr]);

  const endpointUrl = `${savedBaseUrl}/functions/leads`;

  const saveBaseUrl = async () => {
    if (appSettings.id) {
      await api.entities.AppSettings.update(appSettings.id, { public_api_base_url: baseUrl });
    } else {
      await api.entities.AppSettings.create({ public_api_base_url: baseUrl });
    }
    setBaseUrlSaved(true);
    setTimeout(() => setBaseUrlSaved(false), 2000);
    qc.invalidateQueries({ queryKey: ['app-settings'] });
    toast.success('Base URL saved');
  };

  const requireCert = appSettings.require_trustedform_cert !== false;
  const toggleCertGate = async () => {
    const newVal = !requireCert;
    if (appSettings.id) {
      await api.entities.AppSettings.update(appSettings.id, { require_trustedform_cert: newVal });
    } else {
      await api.entities.AppSettings.create({ require_trustedform_cert: newVal });
    }
    qc.invalidateQueries({ queryKey: ['app-settings'] });
    toast.success(`TrustedForm cert gate ${newVal ? 'enabled' : 'disabled'}`);
  };

  const getKeyForSupplier = (supplierId) =>
    apiKeys.find(k => k.supplier_id === supplierId || k.supplier_name === suppliers.find(s => s.id === supplierId)?.name);

  const openCreate = () => {
    setForm(DEFAULT_FORM);
    setEditingSupplierId(null);
    setNewKeyFull(null);
    setSupplierModal(true);
  };

  const openEdit = (supplier) => {
    setForm({
      name: supplier.name || '',
      sid: supplier.sid || '',
      supplier_type: supplier.supplier_type || '',
      payout_type: supplier.payout_type || '',
      payout_value: supplier.payout_value ?? null,
      email: supplier.email || '',
      landing_page_url: supplier.landing_page_url || '',
      brand: parseBrandArray(supplier.brand),
      vertical: supplier.vertical || '',
      active: supplier.active ?? true,
    });
    setEditingSupplierId(supplier.id);
    setNewKeyFull(null);
    setSupplierModal(true);
  };

  const saveSupplier = async () => {
    const payload = { ...form, brand: Array.isArray(form.brand) ? form.brand.join(', ') : (form.brand || '') };
    let supplierId = editingSupplierId;
    if (editingSupplierId) {
      await api.entities.Supplier.update(editingSupplierId, payload);
      const existingKey = getKeyForSupplier(editingSupplierId);
      if (existingKey) {
        await api.entities.ApiKey.update(existingKey.id, {
          supplier_name: form.name,
          vertical: form.vertical,
          active: form.active,
        }).catch(() => {});
      }
      toast.success('Supplier updated');
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
      setSupplierModal(false);
    } else {
      const supplier = await api.entities.Supplier.create(payload);
      supplierId = supplier.id;
      const issued = await createSupplierKey({
        name: form.name, supplierId, supplierName: form.name, vertical: form.vertical,
      });
      setNewKeyFull(issued.key);
      toast.success('Supplier created - copy the key now!');
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    }
  };

  const regenerateKey = async (supplier) => {
    const existingKey = getKeyForSupplier(supplier.id);
    try {
      const issued = existingKey
        ? await rotateSupplierKey(existingKey.id)
        : await createSupplierKey({
          name: supplier.name, supplierId: supplier.id, supplierName: supplier.name,
        });
      // Shown once, in the reveal dialog, and copied for convenience. The
      // server does not hold the cleartext and cannot show it again.
      setNewKeyFull(issued.key);
      navigator.clipboard.writeText(issued.key).catch(() => {});
      toast.success('New key issued. Copy it now, it is not shown again.');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (error) {
      toast.error(error?.message || 'Could not issue a new key');
    }
  };

  // A key cannot be copied back after it is issued. The server keeps only the
  // SHA-256 hash and the entity route read-denies the rest, so this used to
  // put an empty string on the clipboard and report success.
  const copyKey = (supplier) => {
    const k = getKeyForSupplier(supplier.id);
    if (!k) return toast.error('No key found');
    navigator.clipboard.writeText(k.key_prefix || '');
    toast.info('Copied the key prefix. The full key is shown only when it is issued or rotated.');
  };

  const copyEndpoint = () => {
    // The endpoint, not the credential. A live key in a query string ends up in
    // browser history, proxy logs and Referer headers.
    navigator.clipboard.writeText(endpointUrl);
    toast.success('Endpoint copied. Send the key in the X-API-KEY header.');
  };

  const [deleteTarget, setDeleteTarget] = useState(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const k = getKeyForSupplier(deleteTarget.id);
    if (k) {
      await api.entities.ApiKey.delete(k.id).catch(() => {});
    }
    await api.entities.Supplier.delete(deleteTarget.id);
    qc.invalidateQueries({ queryKey: ['suppliers'] });
    qc.invalidateQueries({ queryKey: ['api-keys'] });
    toast.success('Supplier deleted');
    setDeleteTarget(null);
  };

  const toggleActive = async (supplier) => {
    await api.entities.Supplier.update(supplier.id, { active: !supplier.active });
    const k = getKeyForSupplier(supplier.id);
    if (k) await api.entities.ApiKey.update(k.id, { active: !supplier.active });
    qc.invalidateQueries({ queryKey: ['suppliers'] });
    qc.invalidateQueries({ queryKey: ['api-keys'] });
  };

  const handleCreateApiKey = async () => {
    const supplier = apiKeyForm.supplier_id ? suppliers.find(s => s.id === apiKeyForm.supplier_id) : null;
    try {
      const issued = await issueApiKey({
        op: 'create',
        type: apiKeyForm.type,
        name: apiKeyForm.name,
        supplier_id: apiKeyForm.type === 'master' ? undefined : (supplier?.id || undefined),
        supplier_name: apiKeyForm.type === 'master' ? 'Master' : (supplier?.name || ''),
        vertical: apiKeyForm.vertical,
      });
      const data = issued?.data ?? issued;
      if (!data?.key) throw new Error(data?.error || 'Could not issue the key');
      // A new key is active by definition; the form's active switch applies to
      // deactivating it afterwards, which is a separate update.
      setNewKeyFull(data.key);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      setApiKeyCreateOpen(false);
      setApiKeyForm({ name: '', type: 'supplier', supplier_id: '', vertical: '', active: true });
      toast.success('API key created. Copy it now, it is not shown again.');
    } catch (error) {
      toast.error(error?.message || 'Could not create the API key');
    }
  };

  return (
    <div>
      {/* Endpoint Config */}
      <div className="bg-card border border-primary/30 rounded-[10px] p-4 mb-6">
        <div className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Supplier Endpoint</div>
        <div className="flex items-center gap-2 mb-3">
          <code className="flex-1 bg-background rounded-lg px-3 py-2 font-mono text-[12px] text-primary border border-border">{endpointUrl}</code>
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(endpointUrl); toast.success('Copied'); }}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <Label className="text-[12px] whitespace-nowrap">Base URL</Label>
          <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="bg-background font-mono text-[12px]" />
          <Button size="sm" onClick={saveBaseUrl}>{baseUrlSaved ? 'Saved' : 'Save'}</Button>
        </div>
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
          <div>
            <Label className="text-[12px]">Require TrustedForm Cert</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">When enabled, leads without a valid TrustedForm cert URL are queued before delivery.</p>
          </div>
          <Switch checked={requireCert} onCheckedChange={toggleCertGate} />
        </div>
      </div>

      <div className="flex justify-end mb-4">
        <Button size="sm" onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> Add Supplier</Button>
      </div>

      {/* Suppliers Table */}
      <div className="bg-card border border-border rounded-[10px] overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {['Supplier', 'SID', 'Brand', 'Sup Type', 'Pay Type', 'Key', 'Last Used', 'Requests', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {suppliers.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No suppliers yet</td></tr>
            )}
            {suppliers.map(s => {
              const k = getKeyForSupplier(s.id);
              return (
                <tr key={s.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{s.name}</div>
                    <Badge variant="outline" className={`text-[9px] mt-0.5 ${s.active ? 'status-sold bg-status-sold' : 'text-muted-foreground'}`}>
                      {s.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{s.sid || '-'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{parseBrandArray(s.brand).join(', ') || '-'}</td>
                  <td className="px-4 py-3"><Badge variant="outline" className={`text-[10px] ${s.supplier_type === 'Internal' ? 'status-sold bg-status-sold' : s.supplier_type === 'Calls' ? 'status-queued bg-status-queued' : 'text-muted-foreground'}`}>{s.supplier_type || '-'}</Badge></td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-[10px]">{s.payout_type}</Badge></td>
                  <td className="px-4 py-3">
                    {k ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground" title="Only the prefix is stored in readable form">
                          {`${k.key_prefix}...`}
                        </span>
                      </div>
                    ) : <span className="text-muted-foreground text-[11px]">-</span>}
                  </td>
                  <td className="px-4 py-3 text-[11px] text-muted-foreground font-mono">
                    {k?.last_used_at ? format(new Date(k.last_used_at), 'MMM dd HH:mm') : '-'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px]">{k?.request_count || 0}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(s)} className="h-7 text-[11px] px-2">Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => copyKey(s)} className="h-7 w-7 p-0" title="Copy Key"><Copy className="w-3 h-3" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => regenerateKey(s)} className="h-7 w-7 p-0" title="Regenerate Key"><RefreshCw className="w-3 h-3" /></Button>
                      <Button size="sm" variant="ghost" onClick={copyEndpoint} className="h-7 text-[11px] px-2">Endpoint</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(s)} className="h-7 text-[11px] px-2 text-muted-foreground">
                        {s.active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(s)} className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Delete Supplier"><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteTarget?.name}" and its API key. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Supplier Modal */}
      <Dialog open={supplierModal} onOpenChange={(v) => { if (!v && !newKeyFull) setSupplierModal(false); }}>
        <DialogContent className="bg-popover border-border max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingSupplierId ? 'Edit Supplier' : 'New Supplier'}</DialogTitle>
          </DialogHeader>

          {newKeyFull ? (
            <div className="space-y-4">
              <div className="bg-background border border-primary/30 rounded-lg p-4">
                <div className="text-[12px] font-semibold text-primary mb-2">API Key Generated - Copy Now</div>
                <div className="font-mono text-[12px] text-foreground break-all bg-muted/50 rounded p-3">{newKeyFull}</div>
                <p className="text-[11px] text-muted-foreground mt-2">This key will never be shown in full again. Store it securely.</p>
              </div>
              <Button className="w-full" onClick={() => { navigator.clipboard.writeText(newKeyFull); toast.success('Copied!'); }}>
                <Copy className="w-4 h-4 mr-2" /> Copy Key
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setSupplierModal(false)}>Done</Button>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div><Label className="text-[12px]">Name *</Label><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="mt-1 bg-background" /></div>
                  <div><Label className="text-[12px]">SID</Label><Input value={form.sid} onChange={e => setForm(p => ({ ...p, sid: e.target.value }))} placeholder="e.g. mysup" className="mt-1 bg-background" /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[12px]">Supplier Type *</Label>
                    <SearchableSelect
                      value={form.supplier_type}
                      onValueChange={v => setForm(p => ({ ...p, supplier_type: v }))}
                      className="mt-1 bg-background"
                      options={[
                        { value: 'Internal', label: 'Internal' },
                        { value: 'External', label: 'External' },
                        { value: 'Calls', label: 'Calls' },
                      ]}
                    />
                  </div>
                  <div>
                    <Label className="text-[12px]">Payout Type</Label>
                    <SearchableSelect
                      value={form.payout_type}
                      onValueChange={v => setForm(p => ({ ...p, payout_type: v, payout_value: (v === 'Flat CPL' || v === 'Revenue %' || v === 'Profit %') ? (p.payout_value ?? '') : null }))}
                      className="mt-1 bg-background"
                      options={[
                        { value: '', label: 'None' },
                        { value: 'Flat CPL', label: 'Flat CPL' },
                        { value: 'Revenue %', label: 'Revenue %' },
                        { value: 'Profit %', label: 'Profit %' },
                        { value: 'Inbound Call', label: 'Inbound Call' },
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
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[12px]">Brand(s)</Label>
                    <MultiSelect
                      value={form.brand}
                      onValueChange={v => setForm(p => ({ ...p, brand: v }))}
                      className="mt-1 bg-background"
                      placeholder="Select brands…"
                      options={brands.map(b => ({ value: b.brand_name, label: b.brand_name }))}
                    />
                  </div>
                  <div><Label className="text-[12px]">Email</Label><Input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className="mt-1 bg-background" /></div>
                </div>
                {(form.payout_type === 'Flat CPL' || form.payout_type === 'Revenue %' || form.payout_type === 'Profit %') && (
                  <div>
                    <Label className="text-[12px]">{form.payout_type === 'Flat CPL' ? 'Price ($)' : 'Percentage (%)'}</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={form.payout_value ?? ''}
                      onChange={e => setForm(p => ({ ...p, payout_value: e.target.value === '' ? null : Number(e.target.value) }))}
                      placeholder={form.payout_type === 'Flat CPL' ? 'e.g. 25.00' : 'e.g. 15'}
                      className="mt-1 bg-background font-mono text-[12px]"
                    />
                  </div>
                )}
                <div><Label className="text-[12px]">Landing Page URL</Label><Input value={form.landing_page_url} onChange={e => setForm(p => ({ ...p, landing_page_url: e.target.value }))} className="mt-1 bg-background font-mono text-[12px]" /></div>
                <div className="flex items-center gap-2"><Switch checked={form.active} onCheckedChange={v => setForm(p => ({ ...p, active: v }))} /><Label className="text-[12px]">Active</Label></div>
                <Button type="button" variant="outline" size="sm" className="w-full gap-1.5"
                  onClick={() => { setApiKeyForm({ name: form.name ? `${form.name} Key` : '', type: 'supplier', supplier_id: editingSupplierId || '', vertical: form.vertical || '', active: true }); setApiKeyCreateOpen(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Create New API Key
                </Button>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSupplierModal(false)}>Cancel</Button>
                <Button onClick={saveSupplier} disabled={!form.name || !form.supplier_type}>{editingSupplierId ? 'Save Changes' : 'Create Supplier'}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Nested Create New API Key modal */}
      <Dialog open={apiKeyCreateOpen} onOpenChange={setApiKeyCreateOpen}>
        <DialogContent className="bg-popover border-border max-w-[460px]">
          <DialogHeader><DialogTitle>Create New API Key</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label className="text-[12px]">Name / Label *</Label><Input value={apiKeyForm.name} onChange={e => setApiKeyForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Acme Corp Key" className="mt-1 bg-background" /></div>
            <div>
              <Label className="text-[12px]">Type</Label>
              <SearchableSelect
                value={apiKeyForm.type}
                onValueChange={v => setApiKeyForm(p => ({ ...p, type: v, supplier_id: '' }))}
                className="mt-1 bg-background"
                options={[{ value: 'master', label: 'Master - no linked supplier' }, { value: 'supplier', label: 'Supplier - attributed to a supplier' }]}
              />
            </div>
            {apiKeyForm.type === 'supplier' && (
              <div>
                <Label className="text-[12px]">Linked Supplier</Label>
                <SearchableSelect
                  value={apiKeyForm.supplier_id}
                  onValueChange={v => setApiKeyForm(p => ({ ...p, supplier_id: v }))}
                  className="mt-1 bg-background"
                  placeholder="Select supplier…"
                  options={suppliers.map(s => ({ value: s.id, label: s.name }))}
                />
              </div>
            )}
            <div>
              <Label className="text-[12px]">Vertical (optional)</Label>
              <SearchableSelect
                value={apiKeyForm.vertical}
                onValueChange={v => setApiKeyForm(p => ({ ...p, vertical: v }))}
                className="mt-1 bg-background"
                placeholder="Any vertical"
                options={[{ value: '', label: 'Any vertical' }, ...verticalOptions]}
              />
            </div>
            <div className="flex items-center gap-2"><Switch checked={apiKeyForm.active} onCheckedChange={v => setApiKeyForm(p => ({ ...p, active: v }))} /><Label className="text-[12px]">Active</Label></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApiKeyCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateApiKey} disabled={!apiKeyForm.name || (apiKeyForm.type === 'supplier' && !apiKeyForm.supplier_id)}>Generate Key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
