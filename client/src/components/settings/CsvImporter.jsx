import React, { useState, useRef } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, Loader2, Sparkles, Check, ArrowRight, Save } from 'lucide-react';
import { toast } from 'sonner';

// Core target fields per entity. Custom fields (for leads) are appended at runtime.
const LEAD_FIELDS = ['first_name', 'last_name', 'email', 'mobile', 'supplier_name', 'revenue', 'conv_value', 'final_status', 'email_valid'];
const BANK_FIELDS = ['date', 'description', 'amount', 'category', 'external_id'];
const IGNORE = '__ignore__';

export default function CsvImporter() {
  const qc = useQueryClient();
  const fileRef = useRef();
  const [target, setTarget] = useState('lead');
  const [step, setStep] = useState('upload'); // upload | review
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [templateName, setTemplateName] = useState('');

  const { data: customFields = [] } = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.entities.CustomField.list('sort_order') });
  const { data: templates = [] } = useQuery({ queryKey: ['import-templates'], queryFn: () => api.entities.ImportTemplate.list('-created_date') });

  const targetFields = target === 'lead'
    ? [...LEAD_FIELDS, ...customFields.map(f => f.field_name).filter(n => n && !LEAD_FIELDS.includes(n))]
    : BANK_FIELDS;

  const reset = () => { setStep('upload'); setRows([]); setColumns([]); setMapping({}); setTemplateName(''); if (fileRef.current) fileRef.current.value = ''; };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      const extract = await api.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      });
      const parsed = extract?.output?.rows || extract?.output || [];
      const list = Array.isArray(parsed) ? parsed : [];
      if (!list.length) { toast.error('No rows found in the file'); setBusy(false); return; }
      const cols = Object.keys(list[0] || {});
      setRows(list); setColumns(cols);

      // AI auto-map the columns to our target fields.
      const ai = await api.integrations.Core.InvokeLLM({
        prompt: `Map each source CSV column to the best matching target field. Source columns: ${JSON.stringify(cols)}. Target fields: ${JSON.stringify(targetFields)}. If a column has no good match, map it to "${IGNORE}". Return a JSON object of source column -> target field.`,
        response_json_schema: { type: 'object', properties: { mapping: { type: 'object', additionalProperties: { type: 'string' } } } },
      });
      const auto = ai?.mapping || {};
      const finalMap = {};
      cols.forEach(c => { finalMap[c] = targetFields.includes(auto[c]) ? auto[c] : IGNORE; });
      setMapping(finalMap);
      setStep('review');
    } catch (err) {
      toast.error('Could not read the file — check the format');
    }
    setBusy(false);
  };

  const applyTemplate = (t) => {
    const saved = (() => { try { return JSON.parse(t.mapping || '{}'); } catch { return {}; } })();
    setTarget(t.target);
    const finalMap = {};
    columns.forEach(c => { finalMap[c] = saved[c] || IGNORE; });
    setMapping(finalMap);
    toast.success(`Applied template "${t.name}"`);
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) { toast.error('Enter a template name'); return; }
    await api.entities.ImportTemplate.create({ name: templateName.trim(), target, mapping: JSON.stringify(mapping) });
    qc.invalidateQueries({ queryKey: ['import-templates'] });
    toast.success('Template saved');
    setTemplateName('');
  };

  const commit = async () => {
    setBusy(true);
    try {
      const records = rows.map(r => {
        const out = {};
        Object.entries(mapping).forEach(([col, field]) => {
          if (field && field !== IGNORE) out[field] = r[col];
        });
        return out;
      });
      if (target === 'lead') {
        const clean = records.map(r => ({
          ...r,
          supplier_name: r.supplier_name || 'CSV Import',
          final_status: r.final_status || 'Processing',
          revenue: r.revenue != null ? Number(r.revenue) || 0 : undefined,
        }));
        await api.entities.Lead.bulkCreate(clean);
        qc.invalidateQueries({ queryKey: ['report-leads'] });
      } else {
        const clean = records.filter(r => r.date && r.amount != null).map(r => ({
          source: 'csv', date: String(r.date).slice(0, 10), description: r.description || '',
          amount: Number(r.amount) || 0, category: r.category || '', external_id: r.external_id || '',
        }));
        await api.entities.BankTransaction.bulkCreate(clean);
        qc.invalidateQueries({ queryKey: ['bank-txns'] });
      }
      toast.success(`Imported ${records.length} ${target === 'lead' ? 'leads' : 'transactions'}`);
      reset();
    } catch (err) {
      toast.error('Import failed');
    }
    setBusy(false);
  };

  return (
    <div className="bg-card border border-border rounded-[12px] p-5">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-primary" />
        <div className="text-[15px] font-semibold text-foreground">CSV Importer</div>
      </div>
      <div className="text-[13px] text-muted-foreground mb-4 max-w-2xl">
        Upload a CSV or Excel file of leads or bank transactions. Columns are auto-mapped with AI — review and confirm before importing. Save a mapping template to reuse per source.
      </div>

      {step === 'upload' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div>
              <Label className="text-[12px]">Import into</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="mt-1 bg-background text-[13px] w-[220px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead">Leads</SelectItem>
                  <SelectItem value="bank">Bank Transactions</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.json" className="hidden" onChange={handleFile} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="w-full border-2 border-dashed border-border rounded-[12px] py-10 flex flex-col items-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
          >
            {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
            <span className="text-[13px]">{busy ? 'Reading & auto-mapping…' : 'Click to upload a CSV / Excel file'}</span>
          </button>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-[13px] text-foreground font-medium">Review mapping · <span className="text-muted-foreground font-normal">{rows.length} rows</span></div>
            <div className="flex items-center gap-2">
              {templates.filter(t => t.target === target).length > 0 && (
                <Select onValueChange={(id) => { const t = templates.find(x => x.id === id); if (t) applyTemplate(t); }}>
                  <SelectTrigger className="bg-background text-[12px] w-[180px] h-8"><SelectValue placeholder="Apply template…" /></SelectTrigger>
                  <SelectContent>{templates.filter(t => t.target === target).map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
              <Button size="sm" variant="ghost" onClick={reset}>Cancel</Button>
            </div>
          </div>

          <div className="border border-border rounded-[10px] overflow-hidden">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-border bg-muted/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Source Column</th><th className="text-left px-4 py-2.5">Sample</th>
                <th className="text-left px-4 py-2.5 w-[40px]"></th><th className="text-left px-4 py-2.5">Maps To</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {columns.map(col => (
                  <tr key={col}>
                    <td className="px-4 py-2 font-mono text-foreground">{col}</td>
                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[160px]">{String(rows[0]?.[col] ?? '')}</td>
                    <td className="px-4 py-2 text-muted-foreground"><ArrowRight className="w-3.5 h-3.5" /></td>
                    <td className="px-4 py-2">
                      <Select value={mapping[col]} onValueChange={v => setMapping(p => ({ ...p, [col]: v }))}>
                        <SelectTrigger className="bg-background text-[12px] h-8 w-[220px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={IGNORE}>— Ignore —</SelectItem>
                          {targetFields.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <Input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="Save mapping as… (source name)" className="bg-background text-[12px] w-[240px] h-8" />
              <Button size="sm" variant="outline" onClick={saveTemplate} className="gap-1.5"><Save className="w-3.5 h-3.5" /> Save Template</Button>
            </div>
            <Button size="sm" onClick={commit} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Import {rows.length} {target === 'lead' ? 'Leads' : 'Transactions'}
            </Button>
          </div>

          {templates.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {templates.map(t => <Badge key={t.id} variant="outline" className="text-[10px] text-muted-foreground">{t.name} · {t.target}</Badge>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}