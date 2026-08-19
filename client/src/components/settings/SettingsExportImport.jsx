import React, { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { systemExport } from '@/functions/systemExport';
import { systemImport } from '@/functions/systemImport';
import { usePermissions, useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { MigrationProgress } from '@/components/settings/MigrationProgress';
import { MigrationPreviewReport } from '@/components/settings/MigrationPreviewReport';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Download, Upload, ShieldAlert, ShieldCheck, Loader2, FileJson, Lock, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { SECTIONS, BUNDLE_VERSION, entitiesForSections } from '@/lib/systemTransfer';
import { describeMigrationFailure, describeMigrationSuccess } from '@/lib/migrationImportStatus';

// Master admin only. Mirrors the Operations Buyers card / row / badge treatment.
//
// Export walks each selected entity page by page through the systemExport
// function and assembles one bundle client side, so no single request has to
// carry the whole system. Credentials are scrubbed server side before the
// records ever reach this component.

const CONFIG_ONLY = ['schemas', 'settings', 'fields', 'buyers', 'suppliers', 'distribution', 'connectors'];

// Outcome band styling. Busy is deliberately as prominent as the others: an
// operation that takes minutes has to look like it is running.
const STATUS_TONES = {
  busy: 'border-border bg-popover text-muted-foreground',
  success: 'border-primary/40 bg-primary/5 text-primary',
  warn: 'border-chart-3/40 bg-chart-3/5 text-chart-3',
  error: 'border-destructive/40 bg-destructive/5 text-destructive',
};
const PAGE = 500;

function Badge({ tone = 'muted', children }) {
  const tones = {
    muted: 'text-muted-foreground',
    primary: 'text-primary',
    warn: 'text-chart-3',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function SectionRow({ section, checked, count, onToggle, disabled }) {
  return (
    <label
      className={`flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent transition-colors ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} disabled={disabled} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">{section.label}</span>
          {section.isSchemas
            ? <Badge>definitions</Badge>
            : <Badge tone={count > 0 ? 'primary' : 'muted'}>{count == null ? '...' : `${count.toLocaleString()} records`}</Badge>}
        </div>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{section.description}</p>
      </div>
    </label>
  );
}

export default function SettingsExportImport() {
  // usePermissions resolves the effective role (and honours "View as"), useAuth
  // carries the actual user record. Owner short circuits can() by design, so an
  // owner previewing another role correctly loses access to this panel.
  const { can } = usePermissions();
  const { user } = useAuth();
  const isMaster = can('set_export_import');

  const [selected, setSelected] = useState(() => new Set(CONFIG_ONLY));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: '' });
  const [lastResult, setLastResult] = useState(null);
  const [bundlePreview, setBundlePreview] = useState(null);
  const [ordinaryFile, setOrdinaryFile] = useState(null);
  const [ownerFile, setOwnerFile] = useState(null);
  const [ownerPassphrase, setOwnerPassphrase] = useState('');
  const [importBusy, setImportBusy] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // Every migration attempt ends here, success or failure. The panel is not
  // allowed to return to idle with nothing on screen, which is what it did
  // when the only report was a toast and no toaster was mounted.
  const [importStatus, setImportStatus] = useState(null);
  // Where the running import actually is. Populated from the browser's own
  // upload byte counter and from the server's chunk counts, never from a timer.
  // It survives the end of the run so a failure keeps the stage it died at on
  // screen next to the error.
  const [importProgress, setImportProgress] = useState(null);
  // The progress panel already worked. What did not work is that on a long
  // page the operator started an import that runs for minutes and saw nothing,
  // because the panel sits below the fold. Bringing it into view once, when the
  // run starts, is the whole fix: no second indicator competing with the first,
  // and no change to the layout for anyone who could already see it.
  const progressRef = useRef(null);
  const revealProgress = () => {
    const node = progressRef.current;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const { data: counts, isLoading: countsLoading } = useQuery({
    queryKey: ['system-export-counts'],
    enabled: isMaster,
    staleTime: 60000,
    queryFn: async () => {
      const res = await systemExport({ mode: 'counts' });
      return res?.data?.counts || res?.counts || {};
    },
  });

  const sectionCounts = useMemo(() => {
    const out = {};
    for (const s of SECTIONS) {
      out[s.key] = s.entities.reduce((sum, e) => sum + Math.max(counts?.[e] || 0, 0), 0);
    }
    return out;
  }, [counts]);

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of SECTIONS) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    return [...map.entries()];
  }, []);

  const runExport = async () => {
    const keys = [...selected];
    if (keys.length === 0) {
      toast.error('Select at least one section');
      return;
    }

    setBusy(true);
    setLastResult(null);
    const entities = entitiesForSections(keys);
    const bundle = {
      manifest: {
        bundle_version: BUNDLE_VERSION,
        source_app: 'legenex-dashboard',
        exported_at: new Date().toISOString(),
        exported_by: user?.email || 'unknown',
        sections: keys,
        entities,
        counts: {},
        redactions: [],
      },
      entities: {},
    };

    try {
      for (let i = 0; i < entities.length; i += 1) {
        const name = entities[i];
        setProgress({ pct: Math.round((i / entities.length) * 100), label: name });

        const rows = [];
        let offset = 0;
        for (;;) {
          const res = await systemExport({ mode: 'records', entity: name, limit: PAGE, offset });
          const payload = res?.data || res;
          if (payload?.error) throw new Error(`${name}: ${payload.error}`);
          rows.push(...(payload.records || []));
          if (payload.redactions?.length) bundle.manifest.redactions.push(...payload.redactions);
          if (payload.done || !(payload.records || []).length) break;
          offset += payload.returned;
          if (offset > 50000) break;
        }

        bundle.entities[name] = rows;
        bundle.manifest.counts[name] = rows.length;
      }

      setProgress({ pct: 100, label: 'writing file' });

      const total = Object.values(bundle.manifest.counts).reduce((a, b) => a + b, 0);
      const json = JSON.stringify(bundle, null, 2);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `legenex-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setLastResult({
        total,
        entities: entities.length,
        redactions: bundle.manifest.redactions,
        sizeMb: (json.length / 1048576).toFixed(2),
      });
      toast.success(`Exported ${total.toLocaleString()} records`);
    } catch (err) {
      toast.error(err.message || 'Export failed');
    } finally {
      setBusy(false);
      setProgress({ pct: 0, label: '' });
    }
  };

  // Refuse before anything is sent. These are states too, so they are shown in
  // the panel rather than only announced.
  const refuseImport = (title, detail) => {
    setImportStatus({ tone: 'error', code: 'precondition', title, detail });
    toast.error(title);
  };

  const runImport = async (kind, mode) => {
    const file = kind === 'owner' ? ownerFile : ordinaryFile;
    if (!file) return refuseImport('Choose a migration file first', 'No package has been selected.');
    if (kind === 'owner' && ownerPassphrase.length < 16) {
      return refuseImport('Enter the migration passphrase', 'The migration passphrase is at least 16 characters.');
    }
    if (mode === 'apply' && !confirmed) {
      return refuseImport('Confirm the migration before applying it', 'Tick the confirmation above the Apply button.');
    }
    if (mode === 'apply' && !window.confirm('Apply this validated migration to DashFlo? The operation is audited and runs in a database transaction.')) return;

    setImportBusy(`${kind}:${mode}`);
    // A new attempt clears the previous outcome, so a stale preview from an
    // earlier run can never be mistaken for the result of this one.
    setImportStatus({
      tone: 'busy',
      code: null,
      title: mode === 'apply' ? 'Applying migration' : 'Decrypting and validating on the server',
      detail: kind === 'owner'
        ? 'The package is decrypted in server memory. This can take a few minutes for a large export.'
        : 'Validating the export against the DashFlo schema.',
    });
    if (mode === 'preview') setBundlePreview(null);
    setImportProgress({
      phase: 'preparing',
      stage: 'preparing',
      uploadLoaded: 0,
      uploadTotal: file.size || 0,
      serverPercent: null,
      processedChunks: 0,
      totalChunks: 0,
      mode,
      done: false,
      failed: false,
    });
    // After the panel has been committed, not before it exists.
    if (typeof window !== 'undefined') window.requestAnimationFrame?.(revealProgress);

    try {
      const result = await systemImport({
        file,
        kind,
        mode,
        passphrase: ownerPassphrase,
        confirmed: mode === 'apply',
        onUploadProgress: ({ loaded, total, uploaded }) => setImportProgress((prev) => (prev ? {
          ...prev,
          phase: uploaded ? 'server' : 'uploading',
          stage: uploaded ? 'uploaded' : 'uploading',
          uploadLoaded: uploaded ? prev.uploadTotal : loaded,
          uploadTotal: uploaded ? prev.uploadTotal : (total || prev.uploadTotal),
        } : prev)),
        onServerProgress: (state) => setImportProgress((prev) => (prev ? {
          ...prev,
          phase: 'server',
          stage: state?.stage || prev.stage,
          serverPercent: typeof state?.percent === 'number' ? state.percent : prev.serverPercent,
          processedChunks: Number.isInteger(state?.processed_chunks) ? state.processed_chunks : prev.processedChunks,
          totalChunks: Number.isInteger(state?.total_chunks) ? state.total_chunks : prev.totalChunks,
        } : prev)),
      });
      setImportProgress((prev) => (prev ? { ...prev, phase: 'complete', stage: 'complete', done: true } : prev));
      const status = describeMigrationSuccess(result, { mode });
      setImportStatus(status);
      setConfirmed(false);
      if (status.tone === 'error') {
        // A 200 whose body was not usable. No preview is drawn from it.
        toast.error(status.title);
        return;
      }
      setBundlePreview(result);
      if (mode === 'apply') setOwnerPassphrase('');
      if (status.tone === 'success') toast.success(status.title);
      else toast.warning(status.title);
    } catch (err) {
      // Nothing from the thrown value reaches the screen except the server's own
      // safe message, trimmed and bounded. See lib/migrationImportStatus.js.
      const status = describeMigrationFailure(err, { mode });
      setImportStatus(status);
      // The bar stops where it stopped. Which stage failed is diagnostic, so it
      // stays on screen beside the error rather than being cleared.
      setImportProgress((prev) => (prev ? { ...prev, done: true, failed: true } : prev));
      toast.error(status.title);
    } finally {
      setImportBusy('');
    }
  };

  if (!isMaster) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-col items-center text-center py-8">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <p className="mt-2 text-[15px] font-semibold text-foreground">Master admin only</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            System export and import is restricted. Ask the Owner to grant the Export and Import permission.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Credential notice */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="text-[13px] font-medium text-foreground">Ordinary exports never contain credentials</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              API keys, tokens, webhook secrets, authorization headers and credentials inside destination URLs are
              replaced server side before the file is written. The bundle carries a re-entry checklist instead.
              Connectors, webhooks and campaigns from an ordinary export arrive disabled in the receiving app. The
              separate owner migration package below is encrypted and intentionally carries durable credentials.
            </p>
          </div>
        </div>
      </div>

      {/* Export */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-muted-foreground" />
            <span className="text-[13px] font-semibold text-foreground">Export</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set(CONFIG_ONLY))} disabled={busy}>
              Configuration only
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set(SECTIONS.map((s) => s.key)))} disabled={busy}>
              Everything
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set())} disabled={busy}>
              None
            </Button>
          </div>
        </div>

        <div className="divide-y divide-border">
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </div>
              {items.map((s) => (
                <SectionRow
                  key={s.key}
                  section={s}
                  checked={selected.has(s.key)}
                  count={countsLoading ? null : sectionCounts[s.key]}
                  onToggle={() => toggle(s.key)}
                  disabled={busy}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="border-t border-border px-4 py-3">
          {busy ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Exporting {progress.label}
              </div>
              <Progress value={progress.pct} />
            </div>
          ) : (
            <Button onClick={runExport} disabled={selected.size === 0}>
              <Download className="h-4 w-4 mr-2" />
              Export selected
            </Button>
          )}
        </div>
      </div>

      {/* Result */}
      {lastResult && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">
              {lastResult.total.toLocaleString()} records across {lastResult.entities} entities, {lastResult.sizeMb} MB
            </span>
          </div>
          {lastResult.redactions.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] font-medium text-foreground">Re-enter by hand in the receiving app</p>
              <div className="mt-1.5 space-y-1">
                {lastResult.redactions.slice(0, 12).map((r, i) => (
                  <div key={`${r.entity}-${r.field}-${i}`} className="flex items-center justify-between text-[12px]">
                    <span className="text-muted-foreground">{r.entity}.{r.field}</span>
                    <span className="text-muted-foreground">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Import */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <span className="text-[13px] font-semibold text-foreground">Import Base44 data</span>
        </div>

        <div className="p-4 space-y-5">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-popover p-3">
            <ShieldAlert className="h-4 w-4 text-chart-3 mt-0.5 shrink-0" />
            <p className="text-[12px] text-muted-foreground">
              Preview decrypts and validates on the server but writes no business records. Source IDs and relationships
              are preserved. Apply is transactional, audited, and requires a fresh explicit confirmation.
            </p>
          </div>

          <div>
            <div className="text-[13px] font-semibold text-foreground">1. Ordinary Base44 export</div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Redacted, non-secret data. Redacted, blank, missing, masked or placeholder credential fields never replace
              an existing DashFlo credential.
            </p>
            <label className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-border bg-background px-4 py-4 cursor-pointer hover:bg-accent transition-colors">
              <FileJson className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{ordinaryFile?.name || 'Choose ordinary .json export'}</span>
              <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => {
                setOrdinaryFile(e.target.files?.[0] || null); setBundlePreview(null); setConfirmed(false); setImportStatus(null); setImportProgress(null);
              }} />
            </label>
            <Button className="mt-3" variant="outline" disabled={!ordinaryFile || Boolean(importBusy)} onClick={() => runImport('ordinary', 'preview')}>
              {importBusy === 'ordinary:preview' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Preview ordinary import
            </Button>
          </div>

          <div className="border-t border-border pt-5">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">2. Encrypted owner migration export</span>
              <Badge tone="warn">owner only</Badge>
            </div>
            {user?.base_role === 'owner' ? (
              <>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  This package may contain live production supplier, buyer, Meta and connector credentials. It is
                  decrypted only in server memory. The passphrase is sent only for this request and is not stored.
                </p>
                <label className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-border bg-background px-4 py-4 cursor-pointer hover:bg-accent transition-colors">
                  <FileJson className="h-4 w-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{ownerFile?.name || 'Choose encrypted .json.enc migration package'}</span>
                  <input type="file" accept="application/json,.json,.enc" className="hidden" onChange={(e) => {
                    setOwnerFile(e.target.files?.[0] || null); setBundlePreview(null); setConfirmed(false); setImportStatus(null); setImportProgress(null);
                  }} />
                </label>
                <div className="mt-3 max-w-md">
                  <Label className="text-[12px] text-muted-foreground">Migration passphrase</Label>
                  <Input type="password" autoComplete="off" value={ownerPassphrase} onChange={(e) => setOwnerPassphrase(e.target.value)}
                    placeholder="At least 16 characters" className="mt-1 font-mono" />
                </div>
                <Button className="mt-3" variant="outline" disabled={!ownerFile || ownerPassphrase.length < 16 || Boolean(importBusy)} onClick={() => runImport('owner', 'preview')}>
                  {importBusy === 'owner:preview' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Decrypt and preview owner migration
                </Button>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-muted-foreground">Only the account owner can upload or apply a credential-bearing migration package.</p>
            )}
          </div>

          {/* The outcome of the last attempt. Present for every ending: busy,
              success, blocked, refused, timed out, unreachable. This is the
              part that must never be absent. */}
          {importStatus && (
            <div
              role={importStatus.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={`flex items-start gap-3 rounded-lg border p-3 ${STATUS_TONES[importStatus.tone] || STATUS_TONES.error}`}
            >
              {importStatus.tone === 'busy' && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />}
              {importStatus.tone === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
              {importStatus.tone === 'warn' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              {importStatus.tone === 'error' && <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{importStatus.title}</p>
                {importStatus.detail && (
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{importStatus.detail}</p>
                )}
              </div>
            </div>
          )}

          <div ref={progressRef} className="scroll-mt-4">
            {importProgress && <MigrationProgress state={importProgress} />}
          </div>

          {bundlePreview && (
            <div className="rounded-lg border border-border bg-popover p-4">
              <div className="mb-3 flex items-center gap-2">
                {bundlePreview.can_apply ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <AlertTriangle className="h-4 w-4 text-chart-3" />}
                <span className="text-[13px] font-semibold text-foreground">Migration preview</span>
                <Badge>{bundlePreview.kind}</Badge>
              </div>
              <MigrationPreviewReport report={bundlePreview} />
              {bundlePreview.mode === 'preview' && bundlePreview.can_apply && (
                <div className="mt-4 space-y-3 border-t border-border pt-3">
                  <label className="flex items-start gap-2 text-[12px] text-muted-foreground">
                    <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
                    I reviewed this preview and authorize the audited migration apply.
                  </label>
                  <Button disabled={!confirmed || Boolean(importBusy)} onClick={() => runImport(bundlePreview.kind, 'apply')}>
                    {importBusy.endsWith(':apply') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Apply migration
                  </Button>
                </div>
              )}
              {bundlePreview.result === 'success' && (
                <div className="mt-3 text-[12px] text-foreground">Applied successfully. Run ID {bundlePreview.run_id}.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
