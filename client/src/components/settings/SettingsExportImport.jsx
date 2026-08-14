import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { systemExport } from '@/functions/systemExport';
import { usePermissions, useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Download, Upload, ShieldAlert, ShieldCheck, Loader2, FileJson, Lock, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { SECTIONS, BUNDLE_VERSION, entitiesForSections } from '@/lib/systemTransfer';

// Master admin only. Mirrors the Operations Buyers card / row / badge treatment.
//
// Export walks each selected entity page by page through the systemExport
// function and assembles one bundle client side, so no single request has to
// carry the whole system. Credentials are scrubbed server side before the
// records ever reach this component.

const CONFIG_ONLY = ['schemas', 'settings', 'fields', 'buyers', 'suppliers', 'distribution', 'connectors'];
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

  const readBundle = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed.manifest || !parsed.entities) throw new Error('Not a system export bundle');
        if (parsed.manifest.bundle_version !== BUNDLE_VERSION) {
          throw new Error(`Bundle version ${parsed.manifest.bundle_version} does not match this app (${BUNDLE_VERSION})`);
        }
        setBundlePreview(parsed);
        toast.success('Bundle read and validated');
      } catch (err) {
        setBundlePreview(null);
        toast.error(err.message || 'Could not read bundle');
      }
    };
    reader.readAsText(file);
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
            <p className="text-[13px] font-medium text-foreground">Credentials never leave the app</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              API keys, tokens, webhook secrets, authorization headers and credentials inside destination URLs are
              replaced server side before the file is written. The bundle carries a re-entry checklist instead.
              Connectors, webhooks and campaigns always arrive disabled in the receiving app.
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
          <span className="text-[13px] font-semibold text-foreground">Import</span>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-popover p-3">
            <ShieldAlert className="h-4 w-4 text-chart-3 mt-0.5 shrink-0" />
            <p className="text-[12px] text-muted-foreground">
              Reading a bundle is safe and writes nothing. Applying an import is a write to every selected entity and
              runs a dry run first. Record references are remapped to new ids on the way in.
            </p>
          </div>

          <label className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-4 py-8 cursor-pointer hover:bg-accent transition-colors">
            <FileJson className="h-4 w-4 text-muted-foreground" />
            <span className="mt-2 text-[13px] text-foreground">Choose a bundle file</span>
            <span className="mt-0.5 text-[12px] text-muted-foreground">A .json file produced by this export</span>
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readBundle(f); }}
            />
          </label>

          {bundlePreview && (
            <div className="rounded-lg border border-border bg-popover p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span className="text-[13px] font-semibold text-foreground">Bundle validated</span>
              </div>
              <div className="mt-2 space-y-1 text-[12px] text-muted-foreground">
                <div>Exported {new Date(bundlePreview.manifest.exported_at).toLocaleString()} by {bundlePreview.manifest.exported_by}</div>
                <div>{Object.keys(bundlePreview.entities).length} entities, {Object.values(bundlePreview.manifest.counts || {}).reduce((a, b) => a + b, 0).toLocaleString()} records</div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-card p-3">
                <AlertTriangle className="h-4 w-4 text-chart-3 mt-0.5 shrink-0" />
                <p className="text-[12px] text-muted-foreground">
                  Apply is not enabled yet. The reference remapping and dry run report land in the next pass, so no
                  bundle can be written into this app until that is proven.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
