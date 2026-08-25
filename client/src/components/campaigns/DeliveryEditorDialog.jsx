import React, { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, Loader2 } from 'lucide-react';
import DeliveryPayloadEditor from '@/components/delivery/DeliveryPayloadEditor';
import RouteFiltersPanel from '@/components/delivery/RouteFiltersPanel';
import RouteScheduleEditor from '@/components/delivery/RouteScheduleEditor';
import RouteCapsEditor from '@/components/delivery/RouteCapsEditor';
import DeliveryResponseRulesEditor from '@/components/delivery/DeliveryResponseRulesEditor';
import DeliveryTestPanel from '@/components/delivery/DeliveryTestPanel';
import DeliveryHistoryTab from '@/components/delivery/DeliveryHistoryTab';
import { ensureDeliveryRouteMember } from '@/functions/ensureDeliveryRouteMember';

// THE canonical delivery/webhook editor. Edits Delivery + SubDelivery
// directly - the same records regardless of whether this dialog was opened
// from Lead Distribution > Webhooks (Native Deliveries tab) or from
// Operations > Buyers > Buyer Deliveries. There is no second, simplified
// editor: the previous buyer-side dialog wrote to a SubDelivery.transports
// field that resolveSubDeliveryCfg/directPost.js never read (verified by
// inspection - the real send path reads target_url/headers/field_map/
// response_mapping), so it silently persisted configuration the routing
// engine never saw. This replaces that with the real SubDelivery contract.
//
// Filters, qualification conditions, caps, and schedule are RouteMember
// fields at runtime, not SubDelivery fields (see engine.js/snapshot.js). This
// dialog surfaces them as part of "one delivery" for the operator, but reads
// and writes them on the associated RouteMember, created lazily and safely
// (see server/src/functions/ensureDeliveryRouteMember.js) only if the
// operator actually sets one of those values - never on dialog open, and
// never in a way that can enter live routing on its own (the RouteGroup it
// creates is always inactive/draft; activating it is a Campaigns/Route
// Groups decision this editor does not make).
export default function DeliveryEditorDialog({ open, onOpenChange, buyerId, buyerName, delivery, primarySub }) {
  const qc = useQueryClient();
  const isEdit = !!delivery;
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [status, setStatus] = useState('draft');
  const [verticalId, setVerticalId] = useState('');
  const [selectedBuyerId, setSelectedBuyerId] = useState(buyerId || '');

  const [targetUrl, setTargetUrl] = useState('');
  const [method, setMethod] = useState('POST');
  const [encoding, setEncoding] = useState('json');
  const [headers, setHeaders] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10000);
  const [payloadTemplate, setPayloadTemplate] = useState('');
  const [responseMapping, setResponseMapping] = useState('');

  const [routeMemberId, setRouteMemberId] = useState(null);
  const [filters, setFilters] = useState('');
  const [conditions, setConditions] = useState('');
  const [caps, setCaps] = useState('');
  const [schedule, setSchedule] = useState('');
  const [loadingRouteMember, setLoadingRouteMember] = useState(false);

  const { data: buyers = [] } = useQuery({
    queryKey: ['op-buyers-picker'],
    queryFn: () => api.entities.Buyer.list(),
    enabled: open && !buyerId,
  });
  const { data: verticals = [] } = useQuery({
    queryKey: ['op-verticals'],
    queryFn: () => api.entities.Vertical.list(),
    enabled: open,
  });
  const { data: customFields = [] } = useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api.entities.CustomField.list(),
    enabled: open,
  });

  const effectiveBuyerId = buyerId || selectedBuyerId;
  const effectiveBuyerName = buyerId ? buyerName : (buyers.find((b) => b.id === selectedBuyerId)?.company_name || '');

  useEffect(() => {
    if (!open) return;
    setName(delivery?.name || '');
    setStatus(delivery?.status || 'draft');
    setVerticalId(delivery?.vertical_id || '');
    setSelectedBuyerId(delivery?.buyer_id || buyerId || '');

    setTargetUrl(primarySub?.target_url || '');
    setMethod(primarySub?.method || 'POST');
    setEncoding(primarySub?.encoding || 'json');
    setHeaders(primarySub?.headers || '');
    setCredentialRef(primarySub?.credential_ref || '');
    setTimeoutMs(primarySub?.timeout_ms || 10000);
    setPayloadTemplate(primarySub?.payload_template || '');
    setResponseMapping(primarySub?.response_mapping || '');

    setRouteMemberId(null);
    setFilters('');
    setConditions('');
    setCaps('');
    setSchedule('');

    if (primarySub?.id) {
      setLoadingRouteMember(true);
      api.entities.RouteMember.filter({ sub_delivery_id: primarySub.id })
        .then((rows) => {
          const rm = rows && rows[0];
          if (rm) {
            setRouteMemberId(rm.id);
            setFilters(rm.filters || '');
            setConditions(rm.conditions || '');
            setCaps(rm.caps || '');
            setSchedule(rm.schedule || '');
          }
        })
        .catch(() => {})
        .finally(() => setLoadingRouteMember(false));
    }
  }, [open, delivery, primarySub, buyerId]);

  const headersValid = useMemo(() => {
    if (!headers.trim()) return true;
    try { JSON.parse(headers); return true; } catch { return false; }
  }, [headers]);

  const payloadValid = useMemo(() => {
    if (!payloadTemplate.trim()) return true;
    try { JSON.parse(payloadTemplate); return true; } catch { return false; }
  }, [payloadTemplate]);

  const routingTouched = filters.trim() || conditions.trim() || caps.trim() || schedule.trim();

  async function save() {
    if (!name.trim()) { toast.error('Give the delivery a name'); return; }
    if (!effectiveBuyerId) { toast.error('Select a buyer'); return; }
    if (!headersValid) { toast.error('Headers must be valid JSON'); return; }
    if (!payloadValid && status === 'active') {
      toast.error('Payload template must be valid JSON before this delivery can be Active');
      return;
    }
    setSaving(true);
    try {
      let deliveryId = delivery?.id;
      let subId = primarySub?.id;

      if (isEdit) {
        await api.entities.Delivery.update(delivery.id, { name: name.trim(), status, vertical_id: verticalId || null });
      } else {
        const created = await api.entities.Delivery.create({
          buyer_id: effectiveBuyerId, name: name.trim(), status, vertical_id: verticalId || null,
        });
        deliveryId = created.id;
      }

      const subPayload = {
        target_url: targetUrl.trim(),
        method,
        encoding,
        headers: headers.trim(),
        credential_ref: credentialRef.trim() || null,
        timeout_ms: Number(timeoutMs) || 10000,
        payload_template: payloadTemplate,
        response_mapping: responseMapping,
      };
      if (subId) {
        await api.entities.SubDelivery.update(subId, subPayload);
      } else {
        const createdSub = await api.entities.SubDelivery.create({
          delivery_id: deliveryId, name: 'Primary', order_index: 0, active: true, ...subPayload,
        });
        subId = createdSub.id;
      }

      // Filters/conditions/caps/schedule live on RouteMember. Only touch that
      // chain if the operator actually set one of them, or one already
      // exists - never create routing config for a delivery that has none.
      if (routingTouched || routeMemberId) {
        const ensured = await ensureDeliveryRouteMember({ sub_delivery_id: subId });
        if (ensured.data?.ok) {
          const rmId = ensured.data.route_member.id;
          await api.entities.RouteMember.update(rmId, {
            filters: filters.trim() || null,
            conditions: conditions.trim() || null,
            caps: caps.trim() || null,
            schedule: schedule.trim() || null,
          });
        } else if (routingTouched) {
          toast.error(ensured.data?.error || 'Could not save routing-scoped settings (filters/caps/schedule)');
        }
      }

      await Promise.all([
        qc.invalidateQueries({ queryKey: ['deliveries'] }),
        qc.invalidateQueries({ queryKey: ['subdeliveries'] }),
        qc.invalidateQueries({ queryKey: ['native-deliveries'] }),
      ]);
      toast.success(isEdit ? 'Delivery saved' : 'Delivery created');
      onOpenChange(false);
    } catch (e) {
      toast.error('Could not save delivery: ' + (e?.message || 'error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-[880px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit delivery' : 'Create delivery'}{effectiveBuyerName ? ` for ${effectiveBuyerName}` : ''}</DialogTitle>
          <DialogDescription className="text-[12px]">
            Deliveries are buyer-owned and edited here the same way whether you opened this from Webhooks or from the
            buyer. Saving updates the one canonical Delivery/SubDelivery record.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Section title="Identity">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Delivery name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Direct - Legal MVA" className="h-9 bg-background" />
              </Field>
              <Field label="Buyer">
                {buyerId ? (
                  <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/40 text-[12px] text-muted-foreground">
                    {buyerName}
                  </div>
                ) : isEdit ? (
                  <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/40 text-[12px] text-muted-foreground">
                    {effectiveBuyerName || delivery.buyer_id}
                  </div>
                ) : (
                  <SearchableSelect
                    value={selectedBuyerId}
                    onValueChange={setSelectedBuyerId}
                    options={buyers.map((b) => ({ value: b.id, label: `${b.company_name || 'Buyer'}${b.buyer_code ? ` (${b.buyer_code})` : ''}` }))}
                    placeholder="Select buyer"
                    className="h-9"
                  />
                )}
              </Field>
              <Field label="Status">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Vertical">
                <Select value={verticalId || 'none'} onValueChange={(v) => setVerticalId(v === 'none' ? '' : v)}>
                  <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select vertical" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {verticals.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          <Section title="HTTP request">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_120px] gap-3">
              <Field label="Endpoint URL">
                <Input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://buyer.example/api" className="h-9 bg-background font-mono text-[12px]" />
              </Field>
              <Field label="Method">
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                    <SelectItem value="GET">GET</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Format">
                <Select value={encoding} onValueChange={setEncoding}>
                  <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">json</SelectItem>
                    <SelectItem value="form">form</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          <Section title="Headers &amp; credential">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Headers (JSON)" hint="Non-secret headers only." error={!headersValid ? 'Invalid JSON' : null}>
                <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} className="bg-background text-xs font-mono" placeholder='{"X-Env":"production"}' />
              </Field>
              <Field label="Credential reference" hint="Opaque reference to a secret resolved server-side at send time. Never the secret value itself.">
                <Input value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} placeholder="e.g. acme_auth" className="h-9 bg-background font-mono text-[12px]" />
              </Field>
            </div>
            <Field label="Timeout (ms)">
              <Input type="number" min="1000" step="500" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} className="h-9 bg-background font-mono tabular-nums max-w-[160px]" />
            </Field>
          </Section>

          <Section title="Payload">
            <DeliveryPayloadEditor value={payloadTemplate} onChange={setPayloadTemplate} customFields={customFields} />
          </Section>

          <CollapsibleSection title="Filters" defaultOpen={!!filters || !!conditions}>
            {loadingRouteMember ? <LoadingRow /> : (
              <RouteFiltersPanel
                value={filters} onChange={setFilters}
                conditionsValue={conditions} onConditionsChange={setConditions}
                fieldOptions={customFields.map((f) => f.field_name)}
              />
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Delivery policy" defaultOpen={!!caps || !!schedule}>
            {loadingRouteMember ? <LoadingRow /> : (
              <div className="space-y-3">
                <RouteScheduleEditor value={schedule} onChange={setSchedule} />
                <RouteCapsEditor value={caps} onChange={setCaps} />
                <StateCoverageSummary
                  buyerId={effectiveBuyerId}
                  verticalCode={verticals.find((v) => v.id === verticalId)?.code || ''}
                />
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Response handling" defaultOpen={!!responseMapping}>
            <DeliveryResponseRulesEditor value={responseMapping} onChange={setResponseMapping} />
          </CollapsibleSection>

          <CollapsibleSection title="Testing" defaultOpen={false}>
            <DeliveryTestPanel subDeliveryId={primarySub?.id} />
          </CollapsibleSection>

          <CollapsibleSection title="Delivery history" defaultOpen={false}>
            <DeliveryHistoryTab subDeliveryId={primarySub?.id} />
          </CollapsibleSection>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isEdit ? 'Save delivery' : 'Create delivery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border">
      <CollapsibleTrigger className="w-full flex items-center justify-between px-3 py-2.5 text-left">
        <span className="text-[12px] font-semibold text-foreground">{title}</span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Field({ label, hint, error, children }) {
  return (
    <div className="space-y-1">
      <Label className="text-[12px] font-medium">{label}</Label>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {!error && hint && <p className="text-[10.5px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading routing settings...
    </div>
  );
}

// Read-only summary of the buyer's existing state coverage (BuyerStateCpl).
// Deliberately NOT an editable field: state pricing/coverage stays owned by
// Operations > Buyers > Coverage, this just links to it so an operator does
// not have to guess whether a state filter here duplicates or conflicts with
// coverage configured elsewhere.
// verticalCode is BuyerStateCpl.vertical's own short-code shape (e.g. "MVA"),
// resolved by the caller from the selected Vertical record's id - BuyerStateCpl
// never stores a Vertical record id.
function StateCoverageSummary({ buyerId, verticalCode }) {
  const { data: rows = [] } = useQuery({
    queryKey: ['buyer-state-cpl-summary', buyerId, verticalCode],
    queryFn: () => api.entities.BuyerStateCpl.filter(verticalCode ? { buyer_id: buyerId, vertical: verticalCode } : { buyer_id: buyerId }),
    enabled: !!buyerId,
  });
  const active = rows.filter((r) => r.active !== false).length;
  if (!buyerId) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <Badge variant="outline">{active} of {rows.length} states active</Badge>
      <span className="text-[11px] text-muted-foreground">
        via Buyer Coverage{verticalCode ? ` (${verticalCode})` : ''}. State eligibility for routing is a separate Filters
        setting above - it is not automatically derived from coverage.
      </span>
    </div>
  );
}
