import React, { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { classifyResponse, toClassifyResponseMapping, ATTEMPT_STATUS } from '@/lib/distribution/deliveryAttempt.js';
import { parseResponseMapping, getResponsePath as getPath } from '@/lib/deliveryResponseMapping';

// Response Handling editor bound to SubDelivery.response_mapping, the exact
// storage shape toClassifyResponseMapping() (deliveryAttempt.js) normalizes
// into what classifyResponse() reads: regex patterns matched against the
// response body (accepted/rejected/duplicate/queued), a "require accept"
// toggle, and JSON dot-paths for revenue and the buyer's own lead id. This
// preview calls the exact same two functions deliveryResolve.js's
// resolveSubDeliveryCfg calls for the real native send path and
// deliveryMockSend.js calls for Mock Send - one evaluator, one translation,
// three callers. It does not read anything LeadByte-shaped; the legacy
// ResponseMapping entity and its operator/lb_status rows are a separate
// mechanism that only the legacy LeadByteConnector send path in
// processLead.js reads, and stays untouched so it keeps interpreting real
// live traffic correctly. Parsing lives in lib/deliveryResponseMapping.js so
// it can be unit tested without a DOM environment.
export { parseResponseMapping };

const STATUS_LABEL = {
  [ATTEMPT_STATUS.ACCEPTED]: 'Accepted',
  [ATTEMPT_STATUS.REJECTED]: 'Rejected',
  [ATTEMPT_STATUS.DUPLICATE]: 'Duplicate',
  [ATTEMPT_STATUS.QUEUED]: 'Queued',
  [ATTEMPT_STATUS.ERROR]: 'Error',
};

export default function DeliveryResponseRulesEditor({ value, onChange }) {
  const mapping = useMemo(() => parseResponseMapping(value), [value]);
  const [sampleStatus, setSampleStatus] = useState('200');
  const [sampleBody, setSampleBody] = useState('{"result":"accepted","revenue":75,"buyer_lead_id":"WA-1234"}');

  const set = (key, v) => {
    const next = { ...mapping };
    if (v === '' || v == null) delete next[key]; else next[key] = v;
    onChange(Object.keys(next).length ? JSON.stringify(next) : '');
  };

  const preview = useMemo(() => {
    const httpStatus = Number(sampleStatus) || null;
    const evalMapping = toClassifyResponseMapping(mapping);
    const status = classifyResponse({ httpStatus, body: sampleBody, mapping: evalMapping });
    let parsed = null;
    try { parsed = JSON.parse(sampleBody); } catch { /* not JSON, paths just miss */ }
    const revenue = status === ATTEMPT_STATUS.ACCEPTED && parsed ? getPath(parsed, evalMapping.revenuePath) : undefined;
    const buyerLeadId = parsed ? getPath(parsed, evalMapping.leadIdPath) : undefined;
    return { status, revenue, buyerLeadId };
  }, [mapping, sampleStatus, sampleBody]);

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-4">
        <div>
          <div className="text-[13px] font-semibold text-foreground">Response Handling</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Patterns are case-insensitive regexes tested against the raw response body, checked in order: duplicate, reject, queue, accept.
            If none match, the HTTP status decides (2xx accepted, 409 duplicate, 408/429/5xx error, other 4xx rejected).
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <PatternField label="Accept pattern" value={mapping.accepted} onChange={(v) => set('accepted', v)} placeholder='"result"\s*:\s*"accepted"' />
          <PatternField label="Reject pattern" value={mapping.rejected} onChange={(v) => set('rejected', v)} placeholder='"result"\s*:\s*"rejected"' />
          <PatternField label="Duplicate pattern" value={mapping.duplicate} onChange={(v) => set('duplicate', v)} placeholder='"result"\s*:\s*"duplicate"' />
          <PatternField label="Queue pattern" value={mapping.queued} onChange={(v) => set('queued', v)} placeholder='"result"\s*:\s*"queued"' />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2.5">
          <div>
            <Label className="text-[13px]">Require explicit accept</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              When on, a 2xx response that does not match the accept pattern is treated as Rejected, not a false sale.
            </p>
          </div>
          <Switch checked={mapping.require_accept === true} onCheckedChange={(v) => set('require_accept', v || undefined)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <PatternField label="Revenue path" value={mapping.revenue} onChange={(v) => set('revenue', v)} placeholder="revenue" mono />
          <PatternField label="Buyer lead id path" value={mapping.buyer_lead_id} onChange={(v) => set('buyer_lead_id', v)} placeholder="buyer_lead_id" mono />
        </div>

        <div className="pt-3 border-t border-border space-y-2">
          <Label className="text-[12px]">Test against a sample response</Label>
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">HTTP status</Label>
              <Input value={sampleStatus} onChange={(e) => setSampleStatus(e.target.value)} className="h-9 bg-background font-mono tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Response body</Label>
              <Textarea value={sampleBody} onChange={(e) => setSampleBody(e.target.value)} rows={2} className="bg-background font-mono text-[11px]" />
            </div>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[11px] text-muted-foreground">Would be classified as</span>
            <Badge variant="outline" className="font-mono">{STATUS_LABEL[preview.status] || preview.status}</Badge>
            {preview.revenue !== undefined && <span className="text-[11px] text-muted-foreground">revenue: <span className="font-mono text-foreground">{String(preview.revenue)}</span></span>}
            {preview.buyerLeadId !== undefined && <span className="text-[11px] text-muted-foreground">buyer_lead_id: <span className="font-mono text-foreground">{String(preview.buyerLeadId)}</span></span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PatternField({ label, value, onChange, placeholder, mono }) {
  return (
    <div className="space-y-1">
      <Label className="text-[12px] font-medium">{label}</Label>
      <Input
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-9 bg-background text-[12px] ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}
