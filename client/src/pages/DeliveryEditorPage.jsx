import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';

import SectionHeader from '@/components/shared/SectionHeader';
import DeliveryActionsMenu from '@/components/delivery/DeliveryActionsMenu';
import RenameDeliveryDialog from '@/components/delivery/RenameDeliveryDialog';
import KeyValueRowsEditor from '@/components/delivery/KeyValueRowsEditor';
import CredentialReferencePicker from '@/components/delivery/CredentialReferencePicker';
import DeliveryPayloadEditor from '@/components/delivery/DeliveryPayloadEditor';
import DeliveryFormFieldsEditor from '@/components/delivery/DeliveryFormFieldsEditor';
import RouteFiltersPanel from '@/components/delivery/RouteFiltersPanel';
import RouteScheduleEditor from '@/components/delivery/RouteScheduleEditor';
import RouteCapsEditor from '@/components/delivery/RouteCapsEditor';
import DeliveryResponseRulesEditor from '@/components/delivery/DeliveryResponseRulesEditor';
import DeliveryTestPanel from '@/components/delivery/DeliveryTestPanel';
import DeliveryHistoryTab from '@/components/delivery/DeliveryHistoryTab';
import { ensureDeliveryRouteMember } from '@/functions/ensureDeliveryRouteMember';
import { deliveryHistory } from '@/functions/deliveryHistory';
import { methodSendsBody } from '@/lib/distribution/methodSemantics';

// THE canonical full-page delivery editor. Opened identically from Webhooks
// (Native Deliveries) and Operations > Buyers > Buyer Deliveries - always the
// same route, the same Delivery + SubDelivery record, the same component.
// There is no modal version of this anymore: a real integration
// configuration (method-aware request, large payload workspace, routing
// rules, caps/schedule, response mapping, retries, history) needs real page
// space, not a 880px dialog.
//
// Filters/conditions/caps/schedule are RouteMember fields at runtime, not
// SubDelivery fields (see engine.js/snapshot.js) - this page still presents
// them as part of "one delivery" for the operator, reading/writing them on
// the associated RouteMember, created lazily via ensureDeliveryRouteMember
// only when the operator actually sets one of those values. The RouteGroup
// it creates is always inactive/draft; activating it is a separate Routing
// decision this page never makes.
export default function DeliveryEditorPage() {
  const { deliveryId: rawId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !rawId || rawId === 'new';
  const buyerIdParam = searchParams.get('buyerId') || '';
  const verticalIdParam = searchParams.get('verticalId') || '';
  const autoRename = searchParams.get('rename') === '1';

  // Remount the entire editor whenever the target record changes (a real
  // route navigation between two deliveries, or from an existing delivery to
  // "new") so every field's local state resets cleanly, rather than trying to
  // sync dozens of useState values against a changing id in an effect.
  return (
    <DeliveryEditorPageInner
      key={isNew ? `new:${buyerIdParam}:${verticalIdParam}` : rawId}
      deliveryId={isNew ? null : rawId}
      buyerIdParam={buyerIdParam}
      verticalIdParam={verticalIdParam}
      autoRename={autoRename}
      navigate={navigate}
    />
  );
}

function DeliveryEditorPageInner({ deliveryId, buyerIdParam, verticalIdParam, autoRename, navigate }) {
  const qc = useQueryClient();
  const isEdit = !!deliveryId;
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(autoRename);
  const [tab, setTab] = useState('overview');

  const [delivery, setDelivery] = useState(null);
  const [primarySub, setPrimarySub] = useState(null);
  const [otherSubsCount, setOtherSubsCount] = useState(0);
  const [routeMemberId, setRouteMemberId] = useState(null);

  const [name, setName] = useState('');
  const [status, setStatus] = useState('draft');
  const [verticalId, setVerticalId] = useState(verticalIdParam || '');
  const [selectedBuyerId, setSelectedBuyerId] = useState(buyerIdParam || '');

  const [targetUrl, setTargetUrl] = useState('');
  const [method, setMethod] = useState('POST');
  const [encoding, setEncoding] = useState('json');
  const [headers, setHeaders] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10000);
  const [payloadTemplate, setPayloadTemplate] = useState('');
  const [queryParams, setQueryParams] = useState('');
  const [deleteWithBody, setDeleteWithBody] = useState(false);
  const [responseMapping, setResponseMapping] = useState('');
  const [retryPolicy, setRetryPolicy] = useState({ maxAttempts: 5, baseMs: 1000, factor: 2, maxMs: 3600000 });

  const [filters, setFilters] = useState('');
  const [conditions, setConditions] = useState('');
  const [caps, setCaps] = useState('');
  const [schedule, setSchedule] = useState('');

  const { data: buyers = [] } = useQuery({ queryKey: ['op-buyers-picker'], queryFn: () => api.entities.Buyer.list() });
  const { data: verticals = [] } = useQuery({ queryKey: ['op-verticals'], queryFn: () => api.entities.Vertical.list() });
  const { data: customFields = [] } = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.entities.CustomField.list() });

  const effectiveBuyerId = isEdit ? (delivery?.buyer_id || '') : (buyerIdParam || selectedBuyerId);
  const buyer = useMemo(() => buyers.find((b) => b.id === effectiveBuyerId) || null, [buyers, effectiveBuyerId]);
  const vertical = useMemo(() => verticals.find((v) => v.id === verticalId) || null, [verticals, verticalId]);
  // A Delivery's vertical is a single optional scalar - it is never
  // "reused across several verticals" at once, so once it is known (from an
  // existing record, or from the campaign/buyer context this page was opened
  // from) there is nothing genuine to choose: show it read-only. Only a
  // brand-new delivery opened with no context at all (no verticalIdParam,
  // never-before-saved) gets an actual picker, because nothing determines it
  // yet.
  const verticalIsFixed = isEdit || !!verticalIdParam;

  useEffect(() => {
    let cancelled = false;
    if (!isEdit) { setLoading(false); return; }
    setLoading(true);
    (async () => {
      try {
        const d = await api.entities.Delivery.get(deliveryId);
        const subs = await api.entities.SubDelivery.filter({ delivery_id: deliveryId });
        if (cancelled) return;
        const sorted = [...(subs || [])].sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
        const primary = sorted.find((s) => s.active !== false) || sorted[0] || null;
        setDelivery(d);
        setPrimarySub(primary);
        setOtherSubsCount(Math.max(0, sorted.length - (primary ? 1 : 0)));

        setName(d?.name || '');
        setStatus(d?.status || 'draft');
        setVerticalId(d?.vertical_id || '');
        setSelectedBuyerId(d?.buyer_id || '');

        setTargetUrl(primary?.target_url || '');
        setMethod(primary?.method || 'POST');
        setEncoding(primary?.encoding || 'json');
        setHeaders(primary?.headers || '');
        setCredentialRef(primary?.credential_ref || '');
        setTimeoutMs(primary?.timeout_ms || 10000);
        setPayloadTemplate(primary?.payload_template || '');
        setQueryParams(primary?.query_params || '');
        setDeleteWithBody(primary?.delete_with_body === true);
        setResponseMapping(primary?.response_mapping || '');
        try {
          const parsedRetry = primary?.retry_policy ? JSON.parse(primary.retry_policy) : null;
          if (parsedRetry) setRetryPolicy({ maxAttempts: 5, baseMs: 1000, factor: 2, maxMs: 3600000, ...parsedRetry });
        } catch { /* keep defaults */ }

        if (primary?.id) {
          const rmRows = await api.entities.RouteMember.filter({ sub_delivery_id: primary.id });
          const rm = rmRows && rmRows[0];
          if (!cancelled && rm) {
            setRouteMemberId(rm.id);
            setFilters(rm.filters || '');
            setConditions(rm.conditions || '');
            setCaps(rm.caps || '');
            setSchedule(rm.schedule || '');
          }
        }
      } catch (e) {
        toast.error('Could not load delivery: ' + (e?.message || 'error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deliveryId]);

  const headersValid = useMemo(() => {
    if (!headers.trim()) return true;
    try { JSON.parse(headers); return true; } catch { return false; }
  }, [headers]);
  const payloadValid = useMemo(() => {
    if (!payloadTemplate.trim()) return true;
    try { JSON.parse(payloadTemplate); return true; } catch { return false; }
  }, [payloadTemplate]);

  const sendsBody = methodSendsBody(method, deleteWithBody);
  const routingTouched = filters.trim() || conditions.trim() || caps.trim() || schedule.trim();

  async function invalidateAll() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['deliveries'] }),
      qc.invalidateQueries({ queryKey: ['subdeliveries'] }),
      qc.invalidateQueries({ queryKey: ['native-deliveries'] }),
    ]);
  }

  async function save() {
    if (!name.trim()) { toast.error('Give the delivery a name'); return; }
    if (!effectiveBuyerId) { toast.error('Select a buyer'); return; }
    if (!headersValid) { toast.error('Headers must be valid JSON'); return; }
    if (sendsBody && !payloadValid && status === 'active') {
      toast.error('Payload must be valid JSON before this delivery can be Active');
      return;
    }
    setSaving(true);
    try {
      let dId = delivery?.id;
      let subId = primarySub?.id;

      if (isEdit) {
        await api.entities.Delivery.update(delivery.id, {
          name: name.trim(), status, vertical_id: verticalId || null,
        });
      } else {
        const created = await api.entities.Delivery.create({
          buyer_id: effectiveBuyerId, name: name.trim(), status, vertical_id: verticalId || null,
        });
        dId = created.id;
      }

      const subPayload = {
        target_url: targetUrl.trim(),
        method,
        encoding,
        headers: headers.trim(),
        credential_ref: credentialRef.trim() || null,
        timeout_ms: Number(timeoutMs) || 10000,
        payload_template: sendsBody ? payloadTemplate : '',
        query_params: queryParams,
        delete_with_body: method === 'DELETE' ? deleteWithBody : false,
        response_mapping: responseMapping,
        retry_policy: JSON.stringify(retryPolicy),
      };
      if (subId) {
        await api.entities.SubDelivery.update(subId, subPayload);
      } else {
        const createdSub = await api.entities.SubDelivery.create({
          delivery_id: dId, name: 'Primary', order_index: 0, active: true, ...subPayload,
        });
        subId = createdSub.id;
      }

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
          setRouteMemberId(rmId);
        } else if (routingTouched) {
          toast.error(ensured.data?.error || 'Could not save routing-scoped settings (filters/caps/schedule)');
        }
      }

      await invalidateAll();
      toast.success(isEdit ? 'Delivery saved' : 'Delivery created');
      if (!isEdit) navigate(`/webhooks/${dId}`, { replace: true });
    } catch (e) {
      toast.error('Could not save delivery: ' + (e?.message || 'error'));
    } finally {
      setSaving(false);
    }
  }

  function backTarget() {
    if (buyerIdParam) return `/operations/buyers?buyer=${buyerIdParam}`;
    return '/webhooks';
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <button
          type="button"
          onClick={() => navigate(backTarget())}
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> {buyerIdParam ? 'Back to buyer' : 'Back to Webhooks'}
        </button>

        <SectionHeader
          title={isEdit ? name || 'Edit delivery' : 'New delivery'}
          subtitle={buyer ? `Buyer: ${buyer.company_name || buyer.buyer_code || buyer.id}` : (isNewNoBuyer(effectiveBuyerId) ? 'Select a buyer below' : '')}
        >
          <div className="flex items-center gap-2">
            {isEdit && (
              <DeliveryActionsMenu delivery={delivery} showEdit={false} onChanged={invalidateAll} />
            )}
            <Button onClick={save} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? 'Save delivery' : 'Create delivery'}
            </Button>
          </div>
        </SectionHeader>

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="request">Request</TabsTrigger>
            <TabsTrigger value="payload">Payload</TabsTrigger>
            <TabsTrigger value="routing">Routing Rules</TabsTrigger>
            <TabsTrigger value="capsSchedule">Caps &amp; Schedule</TabsTrigger>
            <TabsTrigger value="response">Response</TabsTrigger>
            <TabsTrigger value="retries">Retries &amp; Health</TabsTrigger>
            <TabsTrigger value="history" disabled={!isEdit}>History</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pt-4">
            <OverviewTab
              isEdit={isEdit} delivery={delivery} buyer={buyer} vertical={vertical}
              name={name} status={status}
              targetUrl={targetUrl} method={method} encoding={encoding}
              subDeliveryId={primarySub?.id} otherSubsCount={otherSubsCount}
              onRename={() => setRenaming(true)}
            />
          </TabsContent>

          <TabsContent value="request" className="pt-4 space-y-4">
            <Section title="Identity">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Delivery name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Direct - Legal MVA" className="h-9 bg-background" />
                </Field>
                <Field label="Buyer">
                  {isEdit || buyerIdParam ? (
                    <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/40 text-[12px] text-muted-foreground">
                      {buyer?.company_name || effectiveBuyerId || 'Unknown buyer'}
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
                  {verticalIsFixed ? (
                    <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/40 text-[12px] text-muted-foreground">
                      {vertical?.name || 'Global (not vertical-scoped)'}
                    </div>
                  ) : (
                    <Select value={verticalId || 'none'} onValueChange={(v) => setVerticalId(v === 'none' ? '' : v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select vertical" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Global (not vertical-scoped)</SelectItem>
                        {verticals.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
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
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                      <SelectItem value="DELETE">DELETE</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Format" hint={method === 'GET' ? 'Not used for GET' : undefined}>
                  <Select value={encoding} onValueChange={setEncoding} disabled={method === 'GET'}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="form">Form</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {method === 'DELETE' && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
                  <Switch checked={deleteWithBody} onCheckedChange={setDeleteWithBody} />
                  <div>
                    <p className="text-[12px] font-medium text-foreground">Include a request body (advanced)</p>
                    <p className="text-[10.5px] text-muted-foreground">
                      DELETE sends no body by default, like GET. Only enable this if the destination requires one.
                    </p>
                  </div>
                </div>
              )}
              {!sendsBody ? (
                <Field
                  label="Query parameters"
                  hint="Key/value pairs appended to the URL. Values may use {{token}}/{{token|transform}} placeholders, resolved the same way as the payload."
                >
                  <KeyValueRowsEditor
                    value={queryParams}
                    onChange={setQueryParams}
                    keyPlaceholder="Parameter"
                    valuePlaceholder="Value"
                    addLabel="+ Add parameter"
                    emptyHint="No query parameters. This request will be sent with no query string."
                  />
                </Field>
              ) : (
                <p className="text-[10.5px] text-muted-foreground">
                  Query parameters are configured on GET (or DELETE without a body). Switch Method to see them.
                </p>
              )}
            </Section>

            <Section title="Headers &amp; credential">
              <Field label="Headers" hint="Non-secret headers only.">
                <KeyValueRowsEditor
                  value={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Header"
                  valuePlaceholder="Value"
                  addLabel="+ Add header"
                  emptyHint="No custom headers."
                />
                {!headersValid && <p className="text-[11px] text-destructive mt-1">Stored headers are not valid JSON.</p>}
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label="Credential reference" hint="Resolved server-side at send time. The secret value is never shown here.">
                  <CredentialReferencePicker value={credentialRef} onChange={setCredentialRef} />
                </Field>
                <Field label="Timeout (ms)">
                  <Input type="number" min="1000" step="500" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} className="h-9 bg-background font-mono tabular-nums" />
                </Field>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="payload" className="pt-4">
            {!sendsBody ? (
              <div className="rounded-md border border-border bg-muted/20 px-4 py-6 text-center">
                <p className="text-[12px] text-muted-foreground">
                  {method} does not send a request body. Configure Query parameters on the Request tab instead.
                </p>
              </div>
            ) : encoding === 'form' ? (
              <DeliveryFormFieldsEditor value={payloadTemplate} onChange={setPayloadTemplate} customFields={customFields} />
            ) : (
              <DeliveryPayloadEditor value={payloadTemplate} onChange={setPayloadTemplate} customFields={customFields} minHeight={520} />
            )}
          </TabsContent>

          <TabsContent value="routing" className="pt-4">
            <RouteFiltersPanel
              value={filters} onChange={setFilters}
              conditionsValue={conditions} onConditionsChange={setConditions}
              fieldOptions={customFields.map((f) => f.field_name)}
            />
          </TabsContent>

          <TabsContent value="capsSchedule" className="pt-4 space-y-3">
            <RouteScheduleEditor value={schedule} onChange={setSchedule} />
            <RouteCapsEditor value={caps} onChange={setCaps} />
            <StateCoverageSummary buyerId={effectiveBuyerId} verticalCode={vertical?.code || ''} />
          </TabsContent>

          <TabsContent value="response" className="pt-4">
            <DeliveryResponseRulesEditor value={responseMapping} onChange={setResponseMapping} />
          </TabsContent>

          <TabsContent value="retries" className="pt-4 space-y-4">
            <Section title="Retry policy">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Max attempts">
                  <Input type="number" min="1" max="10" value={retryPolicy.maxAttempts}
                    onChange={(e) => setRetryPolicy((p) => ({ ...p, maxAttempts: Number(e.target.value) || 1 }))}
                    className="h-9 bg-background font-mono tabular-nums" />
                </Field>
                <Field label="Base backoff (ms)">
                  <Input type="number" min="100" step="100" value={retryPolicy.baseMs}
                    onChange={(e) => setRetryPolicy((p) => ({ ...p, baseMs: Number(e.target.value) || 1000 }))}
                    className="h-9 bg-background font-mono tabular-nums" />
                </Field>
                <Field label="Backoff factor">
                  <Input type="number" min="1" step="0.5" value={retryPolicy.factor}
                    onChange={(e) => setRetryPolicy((p) => ({ ...p, factor: Number(e.target.value) || 2 }))}
                    className="h-9 bg-background font-mono tabular-nums" />
                </Field>
                <Field label="Max backoff (ms)">
                  <Input type="number" min="1000" step="1000" value={retryPolicy.maxMs}
                    onChange={(e) => setRetryPolicy((p) => ({ ...p, maxMs: Number(e.target.value) || 3600000 }))}
                    className="h-9 bg-background font-mono tabular-nums" />
                </Field>
              </div>
              <p className="text-[10.5px] text-muted-foreground">
                Only takes effect once native retries are enabled for the account. Disabled in every environment today.
              </p>
            </Section>
            <Section title="Health">
              <DeliveryHealthSummary subDeliveryId={primarySub?.id} />
            </Section>
            <Section title="Test">
              <DeliveryTestPanel subDeliveryId={primarySub?.id} />
            </Section>
          </TabsContent>

          <TabsContent value="history" className="pt-4">
            <DeliveryHistoryTab subDeliveryId={primarySub?.id} />
          </TabsContent>
        </Tabs>
      </div>

      {isEdit && (
        <RenameDeliveryDialog
          open={renaming}
          onOpenChange={setRenaming}
          delivery={delivery}
          onRenamed={(newName) => { setName(newName); setDelivery((d) => ({ ...d, name: newName })); invalidateAll(); }}
        />
      )}
    </div>
  );
}

function isNewNoBuyer(effectiveBuyerId) { return !effectiveBuyerId; }

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
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

function OverviewTab({
  isEdit, delivery, buyer, vertical, name, status, targetUrl, method, encoding,
  subDeliveryId, otherSubsCount, onRename,
}) {
  const host = useMemo(() => { try { return new URL(targetUrl).host; } catch { return targetUrl || '-'; } }, [targetUrl]);
  const { data } = useQuery({
    queryKey: ['delivery-history-summary', subDeliveryId],
    queryFn: async () => (await deliveryHistory({ sub_delivery_id: subDeliveryId, limit: 25 })).data?.attempts || [],
    enabled: !!subDeliveryId,
  });
  const attempts = data || [];
  const lastSuccess = attempts.find((a) => a.status === 'accepted');
  const lastFailure = attempts.find((a) => ['error', 'rejected', 'dead_letter'].includes(a.status));

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-md border border-border bg-card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Row label="Delivery name">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">{name || 'Unnamed delivery'}</span>
            {isEdit && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onRename}>Rename</Button>}
          </div>
        </Row>
        <Row label="Buyer">{buyer?.company_name || delivery?.buyer_id || '-'}</Row>
        <Row label="Status">
          <StatusBadge status={status} />
        </Row>
        <Row label="Vertical">{vertical?.name || 'Global (not vertical-scoped)'}</Row>
        <Row label="Endpoint">
          <span className="font-mono text-[12px] truncate block">{host}</span>
        </Row>
        <Row label="Method / Format">
          <span className="font-mono text-[12px]">{method}{method !== 'GET' ? ` / ${encoding.toUpperCase()}` : ''}</span>
        </Row>
        <Row label="Endpoint variants">
          {otherSubsCount > 0 ? `1 primary + ${otherSubsCount} other${otherSubsCount === 1 ? '' : 's'} (internal)` : '1 (no variants)'}
        </Row>
        <Row label="Created">{delivery?.created_date ? format(new Date(delivery.created_date), 'MMM d, yyyy') : '-'}</Row>
        <Row label="Updated">{delivery?.updated_date ? format(new Date(delivery.updated_date), 'MMM d, yyyy HH:mm') : '-'}</Row>
      </div>

      <div className="rounded-md border border-border bg-card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Row label="Last successful delivery">
          {lastSuccess ? (
            <span className="inline-flex items-center gap-1.5 text-[12px]"><CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--chart-5))]" /> {format(new Date(lastSuccess.completed_at || lastSuccess.created_date), 'MMM d, yyyy HH:mm')}</span>
          ) : <span className="text-[12px] text-muted-foreground">None yet</span>}
        </Row>
        <Row label="Last failure">
          {lastFailure ? (
            <span className="inline-flex items-center gap-1.5 text-[12px]"><XCircle className="w-3.5 h-3.5 text-destructive" /> {format(new Date(lastFailure.completed_at || lastFailure.created_date), 'MMM d, yyyy HH:mm')} ({lastFailure.status})</span>
          ) : <span className="text-[12px] text-muted-foreground">None recorded</span>}
        </Row>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="text-[13px] text-foreground">{children}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    active: { label: 'Active', cls: 'status-sold' },
    draft: { label: 'Draft', cls: 'text-muted-foreground' },
    paused: { label: 'Disabled', cls: 'text-muted-foreground' },
    archived: { label: 'Archived', cls: 'text-muted-foreground' },
  };
  const cfg = map[status] || map.draft;
  return <Badge variant="outline" className={cfg.cls}>{cfg.label}</Badge>;
}

// Simple, honest health read derived from the same safe attempt history
// deliveryHistory.js already exposes (no separate DestinationHealth read
// needed): "healthy" if the most recent attempt succeeded, "failing" if the
// last several in a row did not, otherwise "mixed". This is a summary for a
// human, not the circuit-breaker's own state machine.
function DeliveryHealthSummary({ subDeliveryId }) {
  const { data, isLoading } = useQuery({
    queryKey: ['delivery-health-summary', subDeliveryId],
    queryFn: async () => (await deliveryHistory({ sub_delivery_id: subDeliveryId, limit: 10 })).data?.attempts || [],
    enabled: !!subDeliveryId,
  });
  if (!subDeliveryId) return <p className="text-[12px] text-muted-foreground">Save this delivery to see health.</p>;
  if (isLoading) return <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>;
  const attempts = data || [];
  if (attempts.length === 0) return <p className="text-[12px] text-muted-foreground">No delivery attempts recorded yet.</p>;
  const recentFailures = [];
  for (const a of attempts) { if (a.status === 'accepted') break; recentFailures.push(a); }
  let label = 'Healthy'; let icon = <CheckCircle2 className="w-4 h-4 text-[hsl(var(--chart-5))]" />;
  if (recentFailures.length >= 3) { label = 'Failing'; icon = <XCircle className="w-4 h-4 text-destructive" />; }
  else if (recentFailures.length > 0) { label = 'Recovering'; icon = <Clock className="w-4 h-4 text-muted-foreground" />; }
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
      {icon}
      <span className="text-[12px] font-medium">{label}</span>
      <span className="text-[11px] text-muted-foreground">based on the last {attempts.length} attempt{attempts.length === 1 ? '' : 's'}</span>
    </div>
  );
}

// Read-only summary of the buyer's existing state coverage (BuyerStateCpl).
// Deliberately NOT editable here: state pricing/coverage stays owned by
// Operations > Buyers > Coverage, this just links to it so an operator does
// not have to guess whether a state filter here duplicates or conflicts.
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
        via Buyer Coverage{verticalCode ? ` (${verticalCode})` : ''}. State eligibility for routing is a separate
        Routing Rules setting - it is not automatically derived from coverage.
      </span>
    </div>
  );
}
