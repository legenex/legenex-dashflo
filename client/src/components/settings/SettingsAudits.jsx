import React, { useState, useMemo } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/settings/settingsUi';
import { verdictTagClass, severityTagClass, verdictTextClass } from '@/lib/tagColors';
import { toast } from 'sonner';
import {
  Play, ShieldCheck, AlertTriangle, XCircle, CircleHelp, CheckCircle2,
  ArrowUpRight, ArrowDownRight, Clock,
} from 'lucide-react';

const arr = (v) => (Array.isArray(v) ? v : []);

function runLayers(r) {
  try {
    const l = typeof r.layers === 'string' ? JSON.parse(r.layers) : r.layers;
    return arr(l).join(', ');
  } catch { return ''; }
}

const VERDICT_ORDER = ['fail', 'warn', 'needs_env', 'pass', 'skip'];
const VERDICT_LABEL = { fail: 'Failing', warn: 'Warnings', needs_env: 'Needs environment', pass: 'Passing', skip: 'Skipped' };
const VERDICT_ICON = { fail: XCircle, warn: AlertTriangle, needs_env: CircleHelp, pass: CheckCircle2, skip: CircleHelp };

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-CA', {
      timeZone: 'America/Regina', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function Pill({ className = '', children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  );
}

function RollupChip({ icon: Icon, label, value, tone }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2">
      <Icon className={`h-4 w-4 ${tone}`} />
      <div className="leading-tight">
        <div className="text-sm font-semibold text-foreground">{value}</div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function FindingRow({ f }) {
  const showExpectObserve = f.expected || f.observed;
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent">
      <div className="flex flex-wrap items-center gap-2">
        <Pill className={verdictTagClass(f.verdict)}>{f.verdict}</Pill>
        {f.severity && f.severity !== 'info' && (
          <Pill className={severityTagClass(f.severity)}>{f.severity}</Pill>
        )}
        <span className="font-mono text-[12px] text-foreground">{f.check_id}</span>
        {f.category && <span className="text-[11px] text-muted-foreground">{f.category}</span>}
      </div>
      {f.surface && (
        <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all">{f.surface}</div>
      )}
      {showExpectObserve && (
        <div className="mt-2 space-y-1 text-[12px]">
          {f.expected && (
            <div className="text-muted-foreground"><span className="text-foreground">Expected:</span> {f.expected}</div>
          )}
          {f.observed && (
            <div className="text-muted-foreground"><span className="text-foreground">Observed:</span> {f.observed}</div>
          )}
        </div>
      )}
      {f.detail && <div className="mt-1.5 text-[12px] text-muted-foreground">{f.detail}</div>}
      {f.evidence_path && (
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground break-all">{f.evidence_path}</div>
      )}
    </div>
  );
}

export default function SettingsAudits() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(null);

  const { data: runsRaw, isLoading: runsLoading } = useQuery({
    queryKey: ['audit-runs'],
    queryFn: () => api.entities.AuditRun.list('-started_at', 50),
  });
  const runs = arr(runsRaw);

  const activeRunId = selectedRunId || (runs[0] && runs[0].run_id) || null;
  const activeRun = runs.find((r) => r.run_id === activeRunId) || runs[0] || null;

  const { data: findingsRaw, isLoading: findingsLoading } = useQuery({
    queryKey: ['audit-findings', activeRunId],
    queryFn: () => api.entities.AuditFinding.filter({ run_id: activeRunId }, '-created_at', 500),
    enabled: !!activeRunId,
  });
  const findings = arr(findingsRaw);

  const grouped = useMemo(() => {
    const g = {};
    for (const v of VERDICT_ORDER) g[v] = [];
    for (const f of findings) (g[f.verdict] || (g[f.verdict] = [])).push(f);
    return g;
  }, [findings]);

  const runAudit = async () => {
    setRunning(true);
    try {
      const res = await api.functions.invoke('auditRun', { trigger: 'manual' });
      const data = res?.data || res;
      if (data?.error) throw new Error(data.error);
      toast.success(`Audit complete: ${data.totals?.pass ?? 0} pass, ${data.totals?.fail ?? 0} fail, ${data.totals?.warn ?? 0} warn`);
      if (data?.run_id) setSelectedRunId(data.run_id);
      await qc.invalidateQueries({ queryKey: ['audit-runs'] });
      await qc.invalidateQueries({ queryKey: ['audit-findings'] });
    } catch (err) {
      toast.error(`Audit failed: ${err.message || 'Unknown error'}`);
    }
    setRunning(false);
  };

  const RunButton = (
    <Button onClick={runAudit} disabled={running} className="gap-2">
      <Play className="h-4 w-4" />
      {running ? 'Running...' : 'Run audit'}
    </Button>
  );

  // Empty state: no runs yet. This is where the first run settles CAP-2.
  if (!runsLoading && runs.length === 0) {
    return (
      <Panel className="p-8" i={0}>
        <div className="mx-auto max-w-md text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-base font-semibold text-foreground">No audits have run yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The runtime harness probes the live app read only: it settles CAP-2 by importing the
            generated engine in production Deno, reads the distribution mode without touching it,
            counts configuration, and scans the buyer status and active invariant. It never writes
            to any operational record.
          </p>
          <div className="mt-5 flex justify-center">{RunButton}</div>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Read-only runtime probes against the live app. Every probe records a verdict, so the row
          set is the log and pass to fail transitions are visible between runs.
        </p>
        {RunButton}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Run list */}
        <Panel className="lg:col-span-1 overflow-hidden" i={0}>
          <div className="border-b border-border px-4 py-3 text-[13px] font-medium text-foreground">Runs</div>
          <div>
            {runs.map((r) => {
              const isActive = r.run_id === activeRunId;
              const fails = r.checks_fail || 0;
              const warns = r.checks_warn || 0;
              return (
                <button
                  key={r.run_id}
                  onClick={() => setSelectedRunId(r.run_id)}
                  className={`block w-full border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-accent ${isActive ? 'bg-accent' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[13px] text-foreground">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      {fmtTime(r.started_at)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {fails > 0 && <Pill className={verdictTagClass('fail')}>{fails}</Pill>}
                      {warns > 0 && <Pill className={verdictTagClass('warn')}>{warns}</Pill>}
                      {fails === 0 && warns === 0 && <Pill className={verdictTagClass('pass')}>clean</Pill>}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                    {runLayers(r) && <span className="font-mono">{runLayers(r)}</span>}
                    <span>{r.checks_total || 0} checks</span>
                    {(r.new_failures || 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5"><ArrowUpRight className="h-3 w-3" />{r.new_failures} new</span>
                    )}
                    {(r.resolved_since_previous || 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5"><ArrowDownRight className="h-3 w-3" />{r.resolved_since_previous} fixed</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {/* Selected run detail */}
        <div className="lg:col-span-2 space-y-5">
          {activeRun && (
            <Panel className="p-4" i={1}>
              <div className="flex flex-wrap items-center gap-2">
                <RollupChip icon={CheckCircle2} label="Pass" value={activeRun.checks_pass || 0} tone={verdictTextClass('pass')} />
                <RollupChip icon={XCircle} label="Fail" value={activeRun.checks_fail || 0} tone={verdictTextClass('fail')} />
                <RollupChip icon={AlertTriangle} label="Warn" value={activeRun.checks_warn || 0} tone={verdictTextClass('warn')} />
                <RollupChip icon={CircleHelp} label="Needs env" value={activeRun.checks_needs_env || 0} tone={verdictTextClass('needs_env')} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                <span>Mode observed: <span className="font-mono text-foreground">{activeRun.distribution_mode_observed || 'unset'}</span></span>
                {typeof activeRun.duration_ms === 'number' && <span>{activeRun.duration_ms} ms</span>}
                {(activeRun.new_failures || 0) > 0 && <span className="text-foreground">{activeRun.new_failures} new failure(s) since last run</span>}
                {(activeRun.resolved_since_previous || 0) > 0 && <span className="text-foreground">{activeRun.resolved_since_previous} resolved since last run</span>}
              </div>
            </Panel>
          )}

          {findingsLoading ? (
            <Panel className="p-8" i={2}><div className="text-center text-sm text-muted-foreground">Loading findings...</div></Panel>
          ) : (
            VERDICT_ORDER.filter((v) => grouped[v] && grouped[v].length > 0).map((v, idx) => {
              const Icon = VERDICT_ICON[v];
              return (
                <Panel key={v} className="overflow-hidden" i={2 + idx}>
                  <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[13px] font-medium text-foreground">{VERDICT_LABEL[v]}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{grouped[v].length}</span>
                  </div>
                  <div>
                    {grouped[v].map((f) => <FindingRow key={f.id || `${f.check_id}-${f.surface}`} f={f} />)}
                  </div>
                </Panel>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
