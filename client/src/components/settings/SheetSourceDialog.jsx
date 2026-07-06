import React, { useState, useEffect } from 'react';
import { api } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Loader2, Sparkles, Check } from 'lucide-react';
import { toast } from 'sonner';
import { CORE_LEAD_FIELDS, IGNORE } from '@/components/settings/leadSourceFields';
import MappingReviewTable from '@/components/settings/MappingReviewTable';

// Extract a spreadsheet ID from a full Google Sheets URL or return the raw ID.
function extractSheetId(input) {
  if (!input) return '';
  const m = String(input).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(input).trim();
}

const SCHEDULES = [
  { value: '15m', label: 'Every 15 minutes' },
  { value: '1h', label: 'Hourly' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
];

export default function SheetSourceDialog({ open, onOpenChange, source, onSaved }) {
  const editing = !!source;
  const [step, setStep] = useState('config'); // config | review
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', sheetInput: '', worksheet: 'Sheet1', supplier_name: '', campaign_id: '',
    sync_interval: '1h', dedupe_column: '', enabled: true,
  });
  const [columns, setColumns] = useState([]);
  const [sample, setSample] = useState({});
  const [mapping, setMapping] = useState({});

  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.entities.Supplier.list('-created_date', 200) });
  const { data: campaigns = [] } = useQuery({ queryKey: ['campaigns'], queryFn: () => api.entities.Campaign.list('-created_date', 200) });
  const { data: customFields = [] } = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.entities.CustomField.list('sort_order') });

  const targetFields = [...CORE_LEAD_FIELDS, ...customFields.map(f => f.field_name).filter(n => n && !CORE_LEAD_FIELDS.includes(n))];

  useEffect(() => {
    if (open) {
      if (source) {
        setForm({
          name: source.name || '', sheetInput: source.sheet_id || '', worksheet: source.worksheet || 'Sheet1',
          supplier_name: source.supplier_name || '', campaign_id: source.campaign_id || '',
          sync_interval: source.sync_interval || '1h', dedupe_column: source.dedupe_column || '', enabled: source.enabled ?? true,
        });
        try { setMapping(JSON.parse(source.mapping || '{}')); } catch { setMapping({}); }
        setColumns(Object.keys((() => { try { return JSON.parse(source.mapping || '{}'); } catch { return {}; } })()));
      } else {
        setForm({ name: '', sheetInput: '', worksheet: 'Sheet1', supplier_name: '', campaign_id: '', sync_interval: '1h', dedupe_column: '', enabled: true });
        setMapping({}); setColumns([]); setSample({});
      }
      setStep('config');
    }
  }, [open, source]);

  const loadColumns = async () => {
    const sheetId = extractSheetId(form.sheetInput);
    if (!sheetId) { toast.error('Enter a sheet URL or ID'); return; }
    setBusy(true);
    try {
      const res = await api.functions.invoke('syncGoogleSheets', { preview: true, sheet_id: sheetId, worksheet: form.worksheet });
      if (res.data?.error) { toast.error(res.data.error); setBusy(false); return; }
      const cols = res.data?.columns || [];
      if (!cols.length) { toast.error('No columns found in that tab'); setBusy(false); return; }
      setColumns(cols); setSample(res.data?.sample || {});

      // Reuse AI auto-mapping (same approach as the CSV importer).
      const ai = await api.integrations.Core.InvokeLLM({
        prompt: `Map each Google Sheet column to the best matching target lead field. Columns: ${JSON.stringify(cols)}. Target fields: ${JSON.stringify(targetFields)}. If a column has no good match, map it to "${IGNORE}". Return a JSON object of column -> target field.`,
        response_json_schema: { type: 'object', properties: { mapping: { type: 'object', additionalProperties: { type: 'string' } } } },
      });
      const auto = ai?.mapping || {};
      const finalMap = {};
      cols.forEach(c => { finalMap[c] = targetFields.includes(auto[c]) ? auto[c] : IGNORE; });
      setMapping(finalMap);
      setStep('review');
    } catch (err) {
      toast.error('Could not read the sheet — check sharing & tab name');
    }
    setBusy(false);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return; }
    if (!form.supplier_name) { toast.error('Pick a supplier to attribute'); return; }
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(), kind: 'google_sheets', enabled: form.enabled,
        supplier_name: form.supplier_name, campaign_id: form.campaign_id,
        sheet_id: extractSheetId(form.sheetInput), worksheet: form.worksheet,
        sync_interval: form.sync_interval, dedupe_column: form.dedupe_column,
        mapping: JSON.stringify(mapping),
      };
      let saved;
      if (editing) { saved = await api.entities.LeadSource.update(source.id, payload); }
      else { saved = await api.entities.LeadSource.create(payload); }
      // Provision the ingestion API key.
      await api.functions.invoke('provisionLeadSource', { source_id: saved.id });
      toast.success(editing ? 'Source updated' : 'Google Sheets source added');
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not save source');
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> {editing ? 'Edit' : 'Add'} Google Sheets Source
          </DialogTitle>
        </DialogHeader>

        {step === 'config' && (
          <div className="space-y-4">
            <div>
              <Label className="text-[12px]">Source Name *</Label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Facebook Sheet Feed" className="mt-1 bg-background" />
            </div>
            <div>
              <Label className="text-[12px]">Sheet URL or ID *</Label>
              <Input value={form.sheetInput} onChange={e => setForm(p => ({ ...p, sheetInput: e.target.value }))} placeholder="https://docs.google.com/spreadsheets/d/…" className="mt-1 bg-background font-mono text-[12px]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[12px]">Worksheet / Tab</Label>
                <Input value={form.worksheet} onChange={e => setForm(p => ({ ...p, worksheet: e.target.value }))} placeholder="Sheet1" className="mt-1 bg-background" />
              </div>
              <div>
                <Label className="text-[12px]">Sync Schedule</Label>
                <Select value={form.sync_interval} onValueChange={v => setForm(p => ({ ...p, sync_interval: v }))}>
                  <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{SCHEDULES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[12px]">Attribute to Supplier *</Label>
                <SearchableSelect value={form.supplier_name} onValueChange={v => setForm(p => ({ ...p, supplier_name: v }))} className="mt-1 bg-background" placeholder="Select supplier…" options={suppliers.map(s => ({ value: s.name, label: s.name }))} />
              </div>
              <div>
                <Label className="text-[12px]">Attribute to Campaign</Label>
                <SearchableSelect value={form.campaign_id} onValueChange={v => setForm(p => ({ ...p, campaign_id: v }))} className="mt-1 bg-background" placeholder="Optional" options={[{ value: '', label: 'None' }, ...campaigns.map(c => ({ value: c.id, label: c.name }))]} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={loadColumns} disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Read & Auto-Map Columns
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <div className="text-[13px] text-foreground font-medium">Review column mapping</div>
            <MappingReviewTable columns={columns} sample={sample} mapping={mapping} setMapping={setMapping} targetFields={targetFields} />
            <div>
              <Label className="text-[12px]">De-dupe key column</Label>
              <Select value={form.dedupe_column || '__none__'} onValueChange={v => setForm(p => ({ ...p, dedupe_column: v === '__none__' ? '' : v }))}>
                <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue placeholder="Hash whole row (default)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Hash whole row (default)</SelectItem>
                  {columns.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">A unique column (e.g. email or row ID) prevents the same row being ingested twice.</p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('config')}>Back</Button>
              <Button onClick={save} disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {editing ? 'Save Source' : 'Add Source'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}