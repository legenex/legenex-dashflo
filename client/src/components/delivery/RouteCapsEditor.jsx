import React, { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { CAP_WINDOWS as WINDOWS, parseCaps, capLimit as limitOf, withCapLimit, serializeCaps } from '@/lib/routeCaps';

// Caps editor bound to RouteMember.caps, the exact shape
// client/src/lib/distribution/engine.js's exhaustedCap gate reads. `count` is
// intentionally never written here - it is injected at evaluation time from
// the real CapCounter rows (snapshot.js), so this editor only ever persists
// the configured limit per window. Parsing/serialization live in
// lib/routeCaps.js so they can be unit tested without a DOM environment.
//
// State-specific caps are NOT offered: CapCounter.scope_type lists "state" as
// a schema enum value, but snapshotLoader.js only ever queries the
// route_member scope, so a per-state cap would be a UI field the runtime
// silently ignores. Same for budget_caps (RouteMember.budget_caps exists on
// the schema but nothing in the engine reads it).
export default function RouteCapsEditor({ value, onChange }) {
  const caps = useMemo(() => parseCaps(value), [value]);
  const anySet = WINDOWS.some((w) => limitOf(caps, w.key) !== '');

  const setLimit = (key, raw) => onChange(serializeCaps(withCapLimit(caps, key, raw)));

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-3">
        <div>
          <div className="text-[13px] font-semibold text-foreground">Caps</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {anySet
              ? 'Leads stop routing here once a window is exhausted, enforced atomically at send time.'
              : 'No cap set on any window: unlimited leads.'}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {WINDOWS.map((w) => (
            <div key={w.key} className="space-y-1">
              <Label className="text-[12px] font-medium">{w.label}</Label>
              <Input
                type="number" min="0" step="1"
                value={limitOf(caps, w.key)}
                onChange={(e) => setLimit(w.key, e.target.value)}
                placeholder="Unlimited"
                className="h-9 bg-background font-mono tabular-nums"
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
