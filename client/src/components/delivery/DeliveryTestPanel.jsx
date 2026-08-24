import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Loader2, PlayCircle, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { deliveryPayloadPreview } from '@/functions/deliveryPayloadPreview';
import { deliveryMockSend } from '@/functions/deliveryMockSend';

const DEFAULT_SAMPLE_LEAD = JSON.stringify({
  first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', mobile: '5551234567',
  zip: '90210', accident_state: 'CA', ip_address: '1.2.3.4',
  type_of_injury: 'Back injury', treatment: 'Yes', attorney: 'No',
  incident_date: '2026-07-01', trustedform_url: 'https://cert.trustedform.com/abc123',
}, null, 2);

const DEFAULT_SIMULATED_BODY = '{"result":"accepted","revenue":75,"buyer_lead_id":"TEST-1234"}';

// Testing section of the canonical delivery editor. Two modes, neither of
// which ever reaches the delivery's real target_url:
//   Dry Run   - renders payload_template against the sample lead only.
//   Mock Send - Dry Run, plus classifies an operator-supplied simulated HTTP
//               response through the real classifyResponse evaluator.
// "Live Test" is deliberately NOT offered here. The existing
// campaignDeliveryTest.js function remains the only path that performs a
// real send, and it already refuses outright while distribution_mode is
// legacy_only (the production default) - this panel does not surface it.
export default function DeliveryTestPanel({ subDeliveryId }) {
  const [sampleLead, setSampleLead] = useState(DEFAULT_SAMPLE_LEAD);
  const [simStatus, setSimStatus] = useState('200');
  const [simBody, setSimBody] = useState(DEFAULT_SIMULATED_BODY);
  const [simError, setSimError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const parsedLead = (() => {
    try { return JSON.parse(sampleLead); } catch { return null; }
  })();

  async function runDryRun() {
    if (!subDeliveryId) { toast.error('Save the delivery first'); return; }
    if (!parsedLead) { toast.error('Sample lead must be valid JSON'); return; }
    setRunning(true);
    setResult(null);
    try {
      const resp = await deliveryPayloadPreview({ sub_delivery_id: subDeliveryId, sample_lead: parsedLead });
      setResult({ mode: 'dry_run', ...resp.data });
      if (!resp.data?.ok) toast.error(resp.data?.error || 'Render failed');
    } catch (err) {
      toast.error(err?.message || 'Dry run failed');
    } finally {
      setRunning(false);
    }
  }

  async function runMockSend() {
    if (!subDeliveryId) { toast.error('Save the delivery first'); return; }
    if (!parsedLead) { toast.error('Sample lead must be valid JSON'); return; }
    setRunning(true);
    setResult(null);
    try {
      const simulated = simError.trim()
        ? { error: simError.trim() }
        : { http_status: Number(simStatus) || null, body: simBody };
      const resp = await deliveryMockSend({ sub_delivery_id: subDeliveryId, sample_lead: parsedLead, simulated });
      setResult({ mode: 'mock_send', ...resp.data });
      if (!resp.data?.ok) toast.error(resp.data?.error || 'Render failed');
    } catch (err) {
      toast.error(err?.message || 'Mock send failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
        <p className="text-[11px] text-muted-foreground">
          Neither mode below makes a real network request. Dry Run only renders the payload; Mock Send additionally
          classifies a response you supply. A real send exists only as the separate, gated Live Test on the buyer's
          delivery record, and stays disabled while distribution mode is legacy_only.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px] font-medium">Sample lead (JSON)</Label>
        <Textarea
          value={sampleLead}
          onChange={(e) => setSampleLead(e.target.value)}
          rows={6}
          className={`bg-background font-mono text-[11px] ${parsedLead ? '' : 'border-destructive'}`}
        />
        {!parsedLead && <p className="text-[11px] text-destructive">Invalid JSON</p>}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={runDryRun} disabled={running || !subDeliveryId} className="gap-1.5">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
          Dry Run
        </Button>
      </div>

      <div className="rounded-md border border-border p-3 space-y-2">
        <Label className="text-[12px] font-medium flex items-center gap-1.5"><Radio className="w-3.5 h-3.5" /> Simulated response</Label>
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <Input value={simStatus} onChange={(e) => setSimStatus(e.target.value)} placeholder="HTTP status" className="h-9 bg-background font-mono tabular-nums" />
          <Input value={simError} onChange={(e) => setSimError(e.target.value)} placeholder="or simulate an error, e.g. timeout" className="h-9 bg-background text-[12px]" />
        </div>
        <Textarea value={simBody} onChange={(e) => setSimBody(e.target.value)} rows={2} className="bg-background font-mono text-[11px]" placeholder="Response body" disabled={!!simError.trim()} />
        <Button size="sm" variant="outline" onClick={runMockSend} disabled={running || !subDeliveryId} className="gap-1.5">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
          Mock Send
        </Button>
      </div>

      {!subDeliveryId && (
        <p className="text-[11px] text-muted-foreground">Save this delivery to enable testing.</p>
      )}

      {result && (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{result.mode === 'mock_send' ? 'Mock Send' : 'Dry Run'}</Badge>
            <Badge variant={result.ok ? 'outline' : 'destructive'}>{result.ok ? 'Rendered' : 'Error'}</Badge>
            {result.valid_json && <Badge variant="outline">Valid JSON</Badge>}
          </div>
          {result.error && <p className="text-[12px] text-destructive">{result.error}</p>}
          {result.rendered_payload && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1">Rendered payload</p>
              <pre className="text-[11px] font-mono bg-background rounded p-2 overflow-x-auto border border-border">{result.rendered_payload}</pre>
            </div>
          )}
          {result.simulated_result && (
            <div className="flex items-center gap-3 pt-1 border-t border-border">
              <span className="text-[11px] text-muted-foreground">Classified as</span>
              <Badge variant="outline" className="font-mono">{result.simulated_result.status}</Badge>
              {result.simulated_result.revenue != null && <span className="text-[11px] text-muted-foreground">revenue: <span className="font-mono text-foreground">{result.simulated_result.revenue}</span></span>}
              {result.simulated_result.buyer_lead_id != null && <span className="text-[11px] text-muted-foreground">buyer_lead_id: <span className="font-mono text-foreground">{result.simulated_result.buyer_lead_id}</span></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
