import React, { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { SCHEDULE_DAYS as DAYS, parseSchedule, scheduleToRows, rowsToScheduleJson } from '@/lib/routeSchedule';

// Schedule editor bound to RouteMember.schedule, the exact shape
// client/src/lib/distribution/schedule.js's isWithinSchedule reads. day 0 =
// Sunday .. 6 = Saturday. No schedule, or an empty windows array, means
// "always on" - this editor represents that as every day disabled.
//
// The UI is per-day (enabled + open + close), which is emitted as one window
// per enabled day on save. A schedule saved elsewhere with a single window
// spanning several days is expanded into matching per-day rows on load, so
// editing here never silently drops an existing multi-day window's times.
// Parsing/serialization live in lib/routeSchedule.js so they can be unit
// tested without a DOM environment.
export default function RouteScheduleEditor({ value, onChange }) {
  const schedule = useMemo(() => parseSchedule(value), [value]);
  const timezone = schedule?.timezone || 'UTC';
  const rows = useMemo(() => scheduleToRows(schedule), [schedule]);
  const anyEnabled = Object.values(rows).some((r) => r.enabled);

  const commit = (nextRows, nextTz) => onChange(rowsToScheduleJson(nextRows, nextTz));

  const setRow = (idx, patch) => commit({ ...rows, [idx]: { ...rows[idx], ...patch } }, timezone);
  const setTimezone = (tz) => commit(rows, tz);

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-3">
        <div>
          <div className="text-[13px] font-semibold text-foreground">Schedule</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {anyEnabled
              ? 'Leads are only delivered inside the enabled windows below.'
              : 'No day enabled: this delivery accepts leads at any time (always on).'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[12px] font-medium">Timezone</Label>
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
            className="h-9 bg-background font-mono text-[12px] max-w-[240px]"
          />
          <p className="text-[10.5px] text-muted-foreground">IANA timezone name, e.g. America/New_York, America/Los_Angeles, UTC.</p>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <div className="grid grid-cols-[1fr_110px_110px_90px] gap-2 px-3 py-2 border-b border-border bg-background/40 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Day</span><span>Open</span><span>Close</span><span>Enabled</span>
          </div>
          {DAYS.map((d) => {
            const row = rows[d.idx];
            return (
              <div key={d.idx} className="grid grid-cols-[1fr_110px_110px_90px] gap-2 px-3 py-2 border-b border-border last:border-b-0 items-center">
                <span className="text-[12px] text-foreground">{d.label}</span>
                <Input
                  type="time"
                  value={row.start}
                  disabled={!row.enabled}
                  onChange={(e) => setRow(d.idx, { start: e.target.value })}
                  className="h-8 bg-background text-[12px]"
                />
                <Input
                  type="time"
                  value={row.end}
                  disabled={!row.enabled}
                  onChange={(e) => setRow(d.idx, { end: e.target.value })}
                  className="h-8 bg-background text-[12px]"
                />
                <Switch checked={row.enabled} onCheckedChange={(v) => setRow(d.idx, { enabled: v })} />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
