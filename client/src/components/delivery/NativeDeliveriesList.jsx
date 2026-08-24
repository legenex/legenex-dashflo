import React, { useMemo, useState } from 'react';
import { api } from '@/api/client';
import { fetchAll } from '@/lib/fetchAll';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus, Pencil } from 'lucide-react';
import { parseSchedule } from '@/lib/routeSchedule';
import { parseCaps } from '@/lib/routeCaps';
import DeliveryEditorDialog from '@/components/campaigns/DeliveryEditorDialog';

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

function capSummary(caps) {
  const set = ['total', 'hourly', 'daily', 'weekly', 'monthly'].filter((k) => caps[k]?.limit != null);
  if (set.length === 0) return 'Unlimited';
  return set.map((k) => `${k}: ${caps[k].limit}`).join(', ');
}

function scheduleSummary(schedule) {
  const windows = schedule?.windows || [];
  if (windows.length === 0) return 'Always on';
  return `${windows.length} window${windows.length === 1 ? '' : 's'} (${schedule.timezone || 'UTC'})`;
}

// Primary surface of /webhooks: every native Delivery across every buyer,
// each backed by the SAME canonical DeliveryEditorDialog used from Operations
// > Buyers > Buyer Deliveries. There is deliberately no separate "create"
// flow here - opening a row or "New delivery" mounts the identical editor.
export default function NativeDeliveriesList() {
  const [dialog, setDialog] = useState(null);

  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: ['native-deliveries'],
    queryFn: () => fetchAll((limit, skip) => api.entities.Delivery.list('-created_date', limit, skip)),
  });
  const { data: subs = [] } = useQuery({
    queryKey: ['subdeliveries'],
    queryFn: () => fetchAll((limit, skip) => api.entities.SubDelivery.list('-created_date', limit, skip)),
  });
  const { data: buyers = [] } = useQuery({
    queryKey: ['op-buyers-picker'],
    queryFn: () => api.entities.Buyer.list(),
  });
  const { data: routeMembers = [] } = useQuery({
    queryKey: ['route-members-summary'],
    queryFn: () => fetchAll((limit, skip) => api.entities.RouteMember.list('-created_date', limit, skip)),
  });

  const buyersById = useMemo(() => Object.fromEntries(buyers.map((b) => [b.id, b])), [buyers]);
  const subsByDelivery = useMemo(() => {
    const map = {};
    (subs || []).forEach((s) => { (map[s.delivery_id] ||= []).push(s); });
    Object.values(map).forEach((list) => list.sort((a, b) => (a.order_index || 0) - (b.order_index || 0)));
    return map;
  }, [subs]);
  const routeMemberBySubId = useMemo(
    () => Object.fromEntries((routeMembers || []).filter((m) => m.sub_delivery_id).map((m) => [m.sub_delivery_id, m])),
    [routeMembers],
  );

  const rows = useMemo(() => (deliveries || []).map((d) => {
    const primary = (subsByDelivery[d.id] || [])[0] || null;
    const rm = primary ? routeMemberBySubId[primary.id] : null;
    return { delivery: d, sub: primary, buyer: buyersById[d.buyer_id], routeMember: rm };
  }), [deliveries, subsByDelivery, buyersById, routeMemberBySubId]);

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">
          {rows.length} native {rows.length === 1 ? 'delivery' : 'deliveries'}. Buyer-owned, edited with the same
          canonical editor as Operations &gt; Buyers &gt; Buyer Deliveries.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setDialog({ delivery: null, buyerId: null, buyerName: null })}>
          <Plus className="w-3.5 h-3.5" /> New delivery
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden overflow-x-auto">
        <div className="min-w-[960px]">
          <div className="grid grid-cols-[1fr_140px_90px_90px_1fr_90px_1fr_1fr_60px] gap-2 px-3 py-2 border-b border-border bg-background/40 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Name</span><span>Buyer</span><span>Status</span><span>Vertical</span>
            <span>Endpoint host</span><span>Method</span><span>Schedule</span><span>Caps</span><span />
          </div>
          {rows.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              No native deliveries yet. Deliveries created here are buyer-owned and stay Draft until an operator
              activates them elsewhere.
            </div>
          )}
          {rows.map(({ delivery, sub, buyer, routeMember }) => (
            <button
              key={delivery.id}
              onClick={() => setDialog({ delivery, buyerId: delivery.buyer_id, buyerName: buyer?.company_name })}
              className="w-full grid grid-cols-[1fr_140px_90px_90px_1fr_90px_1fr_1fr_60px] gap-2 px-3 py-2.5 border-b border-border last:border-b-0 items-center text-left hover:bg-accent/30 transition-colors"
            >
              <span className="text-[12px] font-medium text-foreground truncate">{delivery.name || 'Unnamed delivery'}</span>
              <span className="text-[12px] text-muted-foreground truncate">{buyer?.company_name || delivery.buyer_id}</span>
              <StatusBadge status={delivery.status} />
              <span className="text-[11px] text-muted-foreground">{delivery.vertical_id || '-'}</span>
              <span className="text-[11px] font-mono text-muted-foreground truncate">{sub ? hostOf(sub.target_url) || 'No URL' : 'No endpoint'}</span>
              <span className="text-[11px] font-mono text-muted-foreground">{sub?.method || '-'}</span>
              <span className="text-[11px] text-muted-foreground truncate">{routeMember ? scheduleSummary(parseSchedule(routeMember.schedule)) : 'Not routed'}</span>
              <span className="text-[11px] text-muted-foreground truncate">{routeMember ? capSummary(parseCaps(routeMember.caps)) : '-'}</span>
              <Pencil className="w-3.5 h-3.5 text-muted-foreground justify-self-end" />
            </button>
          ))}
        </div>
      </div>

      <DeliveryEditorDialog
        open={!!dialog}
        onOpenChange={(v) => { if (!v) setDialog(null); }}
        buyerId={dialog?.buyerId || null}
        buyerName={dialog?.buyerName || null}
        delivery={dialog?.delivery || null}
        primarySub={dialog?.delivery ? (subsByDelivery[dialog.delivery.id] || [])[0] || null : null}
      />
    </div>
  );
}

function StatusBadge({ status }) {
  const variant = status === 'active' ? 'outline' : status === 'archived' ? 'destructive' : 'outline';
  return <Badge variant={variant} className="w-fit text-[10.5px]">{status || 'draft'}</Badge>;
}
