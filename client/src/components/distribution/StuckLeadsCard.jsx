import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

// Stuck Leads queue. Work unit W4-REAPER, forge-pack/CONTRACT.md D1.
//
// D1: "A lead at queued + failed is a stuck lead, surfaced in the Stuck Leads
// queue and picked up by the reaper." This is that queue.
//
// Read-only by default and by design. It calls reapStuckLeads with
// dry_run: true, which classifies and reports and performs no Lead write and no
// call into the retry worker, so opening this card can never resume a lead or
// cause a send. The Run reaper button is the only control that clears the dry
// run, and it is the operator's explicit action, not a side effect of looking.
//
// Every row answers three questions an operator actually has: which stage did
// this lead stall at, how long has it been there, and what is the system going
// to do about it. The last one is the disposition, and the reason line under it
// is the plain-language version of why the reaper made that call. A lead the
// reaper will not touch says so, and says why, rather than sitting in a list of
// problems with no explanation.
//
// No contact data is rendered. The queue spans every supplier and buyer, and it
// needs the lead number, the supplier and the stage to do its job, not the
// person's name, email or phone.

const DISPOSITION_META = {
  RESUME_DELIVERY: {
    label: 'Resuming',
    tone: 'status-warn-bg status-unsold',
    blurb: 'Handed to the native retry worker, which re-sends through the same reservation and idempotency key the first attempt used.',
  },
  AMBIGUOUS_HOLD: {
    label: 'Needs reconciliation',
    tone: 'status-error-bg status-error',
    blurb: 'Never resumed automatically. A delivery may already have landed and there is no recorded response proving otherwise.',
  },
  NO_SAFE_REENTRY: {
    label: 'Needs an operator',
    tone: 'status-error-bg status-error',
    blurb: 'Nothing was delivered and nothing was billed, but there is no safe automatic way back into the pipeline from this stage.',
  },
  ALREADY_SOLD: {
    label: 'Already sold',
    tone: 'bg-status-duplicate status-duplicate',
    blurb: 'Carries the write-once sale flags. Resuming it could only produce a second sale.',
  },
  EXCLUDED_MIGRATED: {
    label: 'Pre-cutover, excluded',
    tone: 'tag-neutral',
    blurb: 'Migrated history that has had no live activity since. Deliberately never re-driven.',
  },
};

const STAGE_LABEL = {
  received: 'Received, before validation',
  validating: 'Validating',
  routing: 'Routing',
  failed: 'Failed',
  ambiguous: 'Delivery outcome unknown',
};

function stageLabel(stage) {
  return STAGE_LABEL[stage] || stage || 'Unknown stage';
}

function dwellLabel(minutes) {
  if (minutes === null || minutes === undefined) return 'unknown';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Row({ row }) {
  const meta = DISPOSITION_META[row.disposition] || { label: row.disposition, tone: 'tag-neutral', blurb: '' };
  return (
    <div className="px-5 py-3 flex items-start gap-3 hover:bg-accent/30 transition-colors">
      <span className={`text-[10px] font-semibold px-2 py-1 rounded-md whitespace-nowrap mt-0.5 ${meta.tone}`}>
        {meta.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-foreground font-medium truncate">
          Lead {row.lead_id ?? row.id}
          {row.supplier_name ? <span className="text-muted-foreground font-normal"> from {row.supplier_name}</span> : null}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
          Stalled at <span className="text-foreground font-medium">{stageLabel(row.stage)}</span>
          {row.status_reason ? <span className="font-mono"> ({row.status_reason})</span> : null}
          {'. '}
          {row.reason || meta.blurb}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <div className="flex items-center gap-1.5 text-[12px] font-mono text-muted-foreground whitespace-nowrap">
          <Clock className="w-3.5 h-3.5" />
          {dwellLabel(row.stalled_minutes)}
        </div>
        {/* The retry worker has its own rollback control. A lead that could be
            resumed but was not, because that control is off, must say so rather
            than sitting under a "Resuming" label that never happened. */}
        {row.held_by_native_retry_gate === true && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">retry worker off</span>
        )}
        {row.actionable === false && (
          <span className="text-[10px] text-muted-foreground">held</span>
        )}
      </div>
    </div>
  );
}

// `fetcher` is injectable so this card can be rendered in a test or a preview
// without a live backend. Production uses the default, which is the dry run.
export default function StuckLeadsCard({ fetcher, autoLoad = true }) {
  const [state, setState] = useState({ status: autoLoad ? 'loading' : 'idle', data: null, error: null });
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);

  const invoke = useCallback(async (body) => {
    if (fetcher) return fetcher(body);
    const res = await api.functions.invoke('reapStuckLeads', body);
    return res?.data ?? res;
  }, [fetcher]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const data = await invoke({ dry_run: true });
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      setState({ status: 'error', data: null, error: err?.message || 'Could not read the stuck lead queue.' });
    }
  }, [invoke]);

  useEffect(() => { if (autoLoad) load(); }, [autoLoad, load]);

  const runReaper = useCallback(async () => {
    setRunning(true);
    try {
      const data = await invoke({});
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: err?.message || 'The reaper pass failed.' }));
    } finally {
      setRunning(false);
    }
  }, [invoke]);

  const rows = useMemo(() => (Array.isArray(state.data?.stuck) ? state.data.stuck : []), [state.data]);
  const PREVIEW = 8;
  const visible = expanded ? rows : rows.slice(0, PREVIEW);
  const disabled = state.status === 'ready' && state.data?.enabled === false;

  return (
    <div className="bg-card border border-border rounded-[10px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-primary" /> Stuck Leads
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Leads still at queued whose processing has not advanced in fifteen minutes
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={load} disabled={state.status === 'loading'}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${state.status === 'loading' ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={runReaper} disabled={running || disabled}>
            {running ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
            Run reaper
          </Button>
        </div>
      </div>

      {/* Honest states. A queue that cannot be read says so; it never renders an
          empty list as if it had looked and found nothing. */}
      {state.status === 'loading' && (
        <div className="px-5 py-8 text-[13px] text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading the queue
        </div>
      )}

      {state.status === 'error' && (
        <div className="px-5 py-8 text-[13px] status-error flex items-center justify-center gap-2 text-center">
          <ShieldAlert className="w-4 h-4 shrink-0" /> {state.error}
        </div>
      )}

      {state.status === 'ready' && disabled && (
        <div className="px-5 py-8 text-[13px] text-muted-foreground text-center leading-relaxed">
          The stuck lead reaper is switched off.
          <div className="text-[11px] mt-1">
            It is disabled by default until its test has passed in staging. Set
            <span className="font-mono"> STUCK_LEAD_REAPER_ENABLED=true </span>
            on the server to arm it. Nothing is being scanned or recovered while it is off.
          </div>
        </div>
      )}

      {state.status === 'ready' && !disabled && rows.length === 0 && (
        <div className="px-5 py-8 text-[13px] status-sold flex items-center justify-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> No stuck leads. Every queued lead is still advancing.
        </div>
      )}

      {state.status === 'ready' && !disabled && rows.length > 0 && (
        <>
          <div className="px-5 py-2 border-b border-border/60 flex items-center gap-4 flex-wrap text-[11px] text-muted-foreground">
            <span><span className="text-foreground font-semibold">{rows.length}</span> stuck</span>
            {Object.entries(state.data?.counts?.by_disposition || {}).map(([code, count]) => (
              <span key={code}>
                {(DISPOSITION_META[code]?.label || code)}: <span className="text-foreground font-semibold">{count}</span>
              </span>
            ))}
            {state.data?.resumed?.routing_runs > 0 && (
              <span>
                Routing runs started: <span className="text-foreground font-semibold">{state.data.resumed.routing_runs}</span>
              </span>
            )}
            {state.data?.native_retry_enabled === false && (
              <span className="status-unsold">Retry worker off, nothing is being re-sent</span>
            )}
            {/* A truncated scan is never silent. Stuck leads are old leads, so
                the scan runs oldest first and the cap drops the newest rows,
                but an operator still needs to know the cap was reached. */}
            {state.data?.scan?.truncated && (
              <span className="status-unsold">
                Scan capped at <span className="text-foreground font-semibold">{state.data.scan.limit}</span> queued rows
              </span>
            )}
            {state.data?.dry_run && <span className="italic">read only</span>}
          </div>

          <div className="divide-y divide-border">
            {visible.map((row) => <Row key={row.id} row={row} />)}
          </div>

          {rows.length > PREVIEW && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="w-full px-5 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors border-t border-border flex items-center justify-center gap-1.5"
            >
              {expanded ? 'Show less' : `Show all ${rows.length} stuck leads`}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
