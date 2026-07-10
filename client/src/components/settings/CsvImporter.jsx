import React, { useState, useRef } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, Loader2, Sparkles, Check, ArrowRight, Save, Copy, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import Papa from 'papaparse';

// Core target fields per entity. Custom fields (for leads) are appended at runtime.
const LEAD_FIELDS = ['first_name', 'last_name', 'email', 'mobile', 'supplier_name', 'revenue', 'conv_value', 'final_status', 'email_valid'];
const BANK_FIELDS = ['date', 'description', 'amount', 'category', 'external_id'];
const IGNORE = '__ignore__';

// Map arbitrary incoming status text to the exact Lead final_status enum.
const STATUS_LOOKUP = {
  sold: 'Sold',
  unsold: 'Unsold', rejected: 'Unsold', reject: 'Unsold',
  disqualified: 'Disqualified', dq: 'Disqualified',
  duplicate: 'Duplicate', dupe: 'Duplicate', dup: 'Duplicate',
  error: 'Error', err: 'Error',
  queued: 'Queued', queue: 'Queued',
  returned: 'Returned', return: 'Returned',
  processing: 'Processing', new: 'Processing',
};
const normalizeStatus = (raw) => STATUS_LOOKUP[String(raw ?? '').trim().toLowerCase()] || 'Processing';
const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const normMobile = (v) => String(v ?? '').replace(/\D/g, '');

// ---- Deterministic auto-mapping helpers -------------------------------------

// Lowercase and strip everything except a-z0-9 so "First Name", "first_name"
// and "FirstName" all collapse to the same key.
const normKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Source columns whose normalized key means "lead status / disposition" always
// map to final_status (the field that drives Sold/Unsold/Disqualified), never
// to a lead_status custom field.
const STATUS_COLUMN_KEYS = new Set([
  'leadstatus', 'status', 'disposition', 'dispo', 'leaddisposition', 'outcome', 'result', 'finalstatus',
]);

// Synonyms / abbreviations -> target field_name. Keys are normalized.
const SYNONYMS = {
  phone: 'mobile', tel: 'mobile', telephone: 'mobile', cell: 'mobile', cellphone: 'mobile', phonenumber: 'mobile',
  fname: 'first_name', first: 'first_name', givenname: 'first_name',
  lname: 'last_name', surname: 'last_name', last: 'last_name',
  email: 'email', mail: 'email', emailaddress: 'email',
  postal: 'zip', postcode: 'zip', postalcode: 'zip', zipcode: 'zip',
  rev: 'revenue', amount: 'revenue',
};

// Dice coefficient on character bigrams -> similarity ratio 0..1.
const diceCoefficient = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  let total = 0;
  aB.forEach((count, g) => { total += count; });
  bB.forEach((count, g) => {
    total += count;
    const inA = aB.get(g) || 0;
    if (inA > 0) overlap += Math.min(inA, count);
  });
  return (2 * overlap) / total;
};

// Layered matcher: decides one source column, stopping at the first hit.
// entries: [{ field, keys: [normKey(field_name), normKey(label)] }]. Returns a
// target field_name or null when nothing confident matched (leave as Ignore).
const matchColumn = (col, entries) => {
  const key = normKey(col);
  if (!key) return null;

  // 1. Status override.
  if (STATUS_COLUMN_KEYS.has(key)) {
    return entries.some(e => e.field === 'final_status') ? 'final_status' : null;
  }

  const byKey = new Map();
  entries.forEach(e => e.keys.forEach(k => { if (k && !byKey.has(k)) byKey.set(k, e.field); }));

  // 2. Normalized exact match against field_name or label.
  if (byKey.has(key)) return byKey.get(key);

  // 3. Synonym / abbreviation dictionary (only if the target field exists).
  const syn = SYNONYMS[key];
  if (syn && entries.some(e => e.field === syn)) return syn;

  // 4. Fuzzy similarity, accept only above ~0.82.
  let best = null;
  let bestScore = 0;
  byKey.forEach((field, k) => {
    const score = diceCoefficient(key, k);
    if (score > bestScore) { bestScore = score; best = field; }
  });
  return bestScore >= 0.82 ? best : null;
};

export default function CsvImporter() {
  const qc = useQueryClient();
  const fileRef = useRef();
  const [target, setTarget] = useState('lead');
  const [step, setStep] = useState('upload'); // upload | review
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } while lead import runs
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [templateName, setTemplateName] = useState('');
  const [dupChecking, setDupChecking] = useState(false);
  const [dupResult, setDupResult] = useState(null); // { newCount, dupCount }

  const { data: customFields = [] } = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.entities.CustomField.list('sort_order') });
  const { data: templates = [] } = useQuery({ queryKey: ['import-templates'], queryFn: () => api.entities.ImportTemplate.list('-created_date') });

  const targetFields = target === 'lead'
    ? [...LEAD_FIELDS, ...customFields.map(f => f.field_name).filter(n => n && !LEAD_FIELDS.includes(n))]
    : BANK_FIELDS;

  // Matcher entries: each target field plus the normalized keys to match on
  // (field_name, and the custom field label when present).
  const fieldEntries = targetFields.map(f => {
    const cf = customFields.find(c => c.field_name === f);
    const keys = [normKey(f)];
    if (cf?.label) keys.push(normKey(cf.label));
    return { field: f, keys };
  });

  const reset = () => { setStep('upload'); setRows([]); setColumns([]); setMapping({}); setTemplateName(''); setDupResult(null); if (fileRef.current) fileRef.current.value = ''; };

  // First few non-empty sample values for a source column.
  const sampleValues = (col, max = 3) => {
    const out = [];
    for (const r of rows) {
      const v = r?.[col];
      if (v != null && String(v).trim() !== '') out.push(String(v).trim());
      if (out.length >= max) break;
    }
    return out;
  };

  // Which target fields are currently mapped.
  const mappedFields = new Set(Object.values(mapping).filter(f => f && f !== IGNORE));
  // Required-field validation. Returns a list of human-readable missing requirements.
  const missingRequired = (() => {
    if (target === 'lead') {
      return mappedFields.has('email') || mappedFields.has('mobile') ? [] : ['email or mobile'];
    }
    const miss = [];
    if (!mappedFields.has('date')) miss.push('date');
    if (!mappedFields.has('amount')) miss.push('amount');
    return miss;
  })();

  const checkDuplicates = async () => {
    setDupChecking(true);
    try {
      const records = rows.map(r => {
        const out = {};
        Object.entries(mapping).forEach(([col, field]) => { if (field && field !== IGNORE) out[field] = r[col]; });
        return out;
      });
      let existingEmails = new Set();
      let existingMobiles = new Set();
      if (target === 'lead') {
        let page = 0;
        const pageSize = 500;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await api.entities.Lead.list('-created_date', pageSize, page * pageSize);
          batch.forEach(l => {
            const e = normEmail(l.email); if (e) existingEmails.add(e);
            const m = normMobile(l.mobile); if (m) existingMobiles.add(m);
          });
          if (batch.length < pageSize) break;
          page += 1;
        }
      }
      const seenEmails = new Set();
      const seenMobiles = new Set();
      let newCount = 0;
      let dupCount = 0;
      records.forEach(r => {
        const e = normEmail(r.email);
        const m = normMobile(r.mobile);
        const dupExisting = (e && existingEmails.has(e)) || (m && existingMobiles.has(m));
        const dupIntra = (e && seenEmails.has(e)) || (m && seenMobiles.has(m));
        if (dupExisting || dupIntra) { dupCount += 1; return; }
        if (e) seenEmails.add(e);
        if (m) seenMobiles.add(m);
        newCount += 1;
      });
      setDupResult({ newCount, dupCount });
    } catch {
      toast.error('Could not check duplicates');
    }
    setDupChecking(false);
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const name = (file.name || '').toLowerCase();
      const isDelimited = name.endsWith('.csv') || name.endsWith('.tsv');
      let list = [];
      if (isDelimited) {
        // Parse CSV/TSV in the browser. Reliable on large or wide files with
        // quoted fields containing line breaks, where AI extraction fails.
        const text = await file.text();
        const result = Papa.parse(text, { header: true, skipEmptyLines: true });
        list = Array.isArray(result?.data) ? result.data : [];
      } else {
        const { file_url } = await api.integrations.Core.UploadFile({ file });
        const extract = await api.integrations.Core.ExtractDataFromUploadedFile({
          file_url,
          json_schema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
        });
        const parsed = extract?.output?.rows || extract?.output || [];
        list = Array.isArray(parsed) ? parsed : [];
      }
      if (!list.length) { toast.error('No rows found in the file'); setBusy(false); return; }
      const cols = Object.keys(list[0] || {});
      setRows(list); setColumns(cols);

      // Deterministic layered auto-map: status override -> normalized exact ->
      // synonyms -> fuzzy. Each column stops at the first confident hit.
      const finalMap = {};
      const unmatched = [];
      cols.forEach(c => {
        const hit = matchColumn(c, fieldEntries);
        if (hit) finalMap[c] = hit;
        else { finalMap[c] = IGNORE; unmatched.push(c); }
      });

      // AI fallback ONLY for columns still unmatched after the deterministic layers.
      if (unmatched.length) {
        try {
          const ai = await api.integrations.Core.InvokeLLM({
            prompt: `Map each source CSV column to the best matching target field. Source columns: ${JSON.stringify(unmatched)}. Target fields: ${JSON.stringify(targetFields)}. If a column has no good match, map it to "${IGNORE}". Return a JSON object of source column -> target field.`,
            response_json_schema: { type: 'object', properties: { mapping: { type: 'object', additionalProperties: { type: 'string' } } } },
          });
          const auto = ai?.mapping || {};
          unmatched.forEach(c => { if (targetFields.includes(auto[c])) finalMap[c] = auto[c]; });
        } catch {
          // Deterministic mapping already applied; leave unmatched as Ignore.
        }
      }
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
        const mapped = {};
        Object.entries(mapping).forEach(([col, field]) => {
          if (!field || field === IGNORE) return;
          // Core lead fields become top-level columns; anything else is a
          // custom field the Lead entity does not persist as a column, so it
          // is collected into the mapped_fields JSON the app reads from.
          if (target === 'lead' && !LEAD_FIELDS.includes(field)) {
            mapped[field] = r[col];
          } else {
            out[field] = r[col];
          }
        });
        if (target === 'lead' && Object.keys(mapped).length) {
          out.mapped_fields = JSON.stringify(mapped);
        }
        return out;
      });
      if (target === 'lead') {
        // Load every existing lead's email + mobile (all time) into normalized sets for dedup.
        const existingEmails = new Set();
        const existingMobiles = new Set();
        let page = 0;
        const pageSize = 500;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await api.entities.Lead.list('-created_date', pageSize, page * pageSize);
          batch.forEach(l => {
            const e = normEmail(l.email); if (e) existingEmails.add(e);
            const m = normMobile(l.mobile); if (m) existingMobiles.add(m);
          });
          if (batch.length < pageSize) break;
          page += 1;
        }

        const batchId = `import_${Date.now()}`;
        const seenEmails = new Set();
        const seenMobiles = new Set();
        let skipped = 0;
        const clean = [];
        records.forEach(r => {
          const e = normEmail(r.email);
          const m = normMobile(r.mobile);
          const dupExisting = (e && existingEmails.has(e)) || (m && existingMobiles.has(m));
          const dupIntra = (e && seenEmails.has(e)) || (m && seenMobiles.has(m));
          if (dupExisting || dupIntra) { skipped += 1; return; }
          if (e) seenEmails.add(e);
          if (m) seenMobiles.add(m);
          clean.push({
            ...r,
            supplier_name: r.supplier_name || 'CSV Import',
            final_status: normalizeStatus(r.final_status),
            revenue: r.revenue != null ? Number(r.revenue) || 0 : undefined,
            import_batch_id: batchId,
          });
        });

        const chunkSize = 100;
        setProgress({ done: 0, total: clean.length });
        let createdCount = 0;
        let failedCount = 0;
        const failedRecords = [];
        for (let i = 0; i < clean.length; i += chunkSize) {
          const chunk = clean.slice(i, i + chunkSize);
          try {
            await api.entities.Lead.bulkCreate(chunk);
            createdCount += chunk.length;
          } catch {
            // One bad row can fail the whole chunk, so retry the chunk one
            // record at a time and skip only the genuinely bad rows.
            for (const rec of chunk) {
              try {
                await api.entities.Lead.create(rec);
                createdCount += 1;
              } catch {
                failedCount += 1;
                failedRecords.push(rec.email || `${rec.first_name || ''} ${rec.last_name || ''}`.trim() || '(no email)');
              }
            }
          }
          setProgress({ done: Math.min(i + chunk.length, clean.length), total: clean.length });
        }
        setProgress(null);
        qc.invalidateQueries({ queryKey: ['report-leads'] });
        if (failedCount) console.warn('CSV import failed records:', failedRecords);
        toast.success(`Imported ${createdCount} leads, skipped ${skipped} duplicates${failedCount ? `, ${failedCount} failed` : ''}`);
        reset();
        setBusy(false);
        return;
      } else {
        const clean = records.filter(r => r.date && r.amount != null).map(r => ({
          source: 'csv', date: String(r.date).slice(0, 10), description: r.description || '',
          amount: Number(r.amount) || 0, category: r.category || '', external_id: r.external_id || '',
        }));
        await api.entities.BankTransaction.bulkCreate(clean);
        qc.invalidateQueries({ queryKey: ['bank-txns'] });
        toast.success(`Imported ${clean.length} transactions`);
      }
      reset();
    } catch (err) {
      toast.error('Import failed');
    }
    setProgress(null);
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
          <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,.xls,.json" className="hidden" onChange={handleFile} />
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
                    <td className="px-4 py-2 font-mono text-foreground align-top">{col}</td>
                    <td className="px-4 py-2 text-muted-foreground max-w-[200px] align-top">
                      {(() => {
                        const vals = sampleValues(col);
                        if (!vals.length) return <span className="italic opacity-60">empty</span>;
                        return (
                          <div className="space-y-0.5">
                            {vals.map((v, i) => <div key={i} className="truncate">{v}</div>)}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground align-top"><ArrowRight className="w-3.5 h-3.5" /></td>
                    <td className="px-4 py-2 align-top">
                      <Select value={mapping[col]} onValueChange={v => { setMapping(p => ({ ...p, [col]: v })); setDupResult(null); }}>
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
            <div className="flex items-center gap-3">
              {progress && <span className="text-[12px] text-muted-foreground">created {progress.done} of {progress.total}</span>}
              {dupResult && <span className="text-[12px] text-muted-foreground">{dupResult.newCount} new, {dupResult.dupCount} duplicates</span>}
              <Button size="sm" variant="outline" onClick={checkDuplicates} disabled={dupChecking || busy} className="gap-1.5">
                {dupChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
                Check duplicates
              </Button>
              <Button size="sm" onClick={commit} disabled={busy || missingRequired.length > 0} className="gap-1.5">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Import {rows.length} {target === 'lead' ? 'Leads' : 'Transactions'}
              </Button>
            </div>
          </div>

          {missingRequired.length > 0 && (
            <div className="flex items-center gap-2 text-[12px] text-primary bg-status-error-bg rounded-[8px] px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Map {missingRequired.join(' and ')} before importing.</span>
            </div>
          )}

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