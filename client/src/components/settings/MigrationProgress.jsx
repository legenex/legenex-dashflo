import React from 'react';
import { Loader2 } from 'lucide-react';
import { migrationCounts, migrationPercent, stageCopy } from '@/lib/migrationProgressModel';

/* The import progress panel.
 *
 * Sits at the bottom of the import area for the whole operation and stays after
 * it, so the stage a failure died at is still readable next to the error. Every
 * number here is measured: the upload figure is the browser's own byte counter,
 * the server figure is the share of chunks it has actually decrypted. When
 * neither is available the bar is explicitly indeterminate rather than showing a
 * percentage that would be invented.
 *
 * The bar is the same two-tone rounded track the export progress uses, written
 * out here rather than pulled from components/ui/progress so this panel stays
 * renderable without a DOM. That matters because these states are worth testing
 * and the repository test runner has no jsdom.
 */
export function MigrationProgress({ state }) {
  const percent = migrationPercent({
    phase: state.failed ? 'failed' : state.phase,
    uploadLoaded: state.uploadLoaded,
    uploadTotal: state.uploadTotal,
    serverPercent: state.serverPercent,
  });
  const copy = stageCopy(state.stage);
  const counts = migrationCounts(state);
  const determinate = percent !== null && percent !== undefined && !state.failed;

  return (
    <div
      data-testid="migration-progress"
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border bg-popover p-3"
    >
      <div className="flex items-center gap-2">
        {!state.done && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {state.failed ? `Stopped during: ${copy.label}` : copy.label}
        </span>
        {determinate && (
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{percent}%</span>
        )}
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-primary/20">
        {determinate ? (
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        ) : (
          <div className={`h-full rounded-full ${state.failed ? 'w-full bg-destructive/60' : 'w-1/3 animate-pulse bg-primary'}`} />
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">
          {state.failed ? 'See the message above for what to do next.' : copy.detail}
        </span>
        {counts && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{counts}</span>}
      </div>
    </div>
  );
}

export default MigrationProgress;
