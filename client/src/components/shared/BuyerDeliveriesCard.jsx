import React, { useMemo } from 'react';
import { api } from '@/api/client';
import { fetchAll } from '@/lib/fetchAll';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import BuyerDeliveryRows from '@/components/campaigns/BuyerDeliveryRows';

// Buyer Deliveries card.
//
// Deliveries are buyer-owned, so this card is the SAME surface wherever it
// appears: Operations > Buyers (where buyers are managed) and Lead Distribution
// (where an operator arranging routing needs to add one without leaving the
// page). Both read and write the same Delivery and SubDelivery records
// through the same full-page editor (/webhooks/:deliveryId), so there is one
// editor rather than two that can drift.
export default function BuyerDeliveriesCard({ buyerId }) {
  const qc = useQueryClient();

  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => fetchAll((limit, skip) => api.entities.Delivery.list('-created_date', limit, skip)),
  });
  const { data: subs = [] } = useQuery({
    queryKey: ['subdeliveries'],
    queryFn: () => fetchAll((limit, skip) => api.entities.SubDelivery.list('-created_date', limit, skip)),
  });

  const mine = useMemo(
    () => (deliveries || []).filter((d) => String(d.buyer_id) === String(buyerId)),
    [deliveries, buyerId],
  );
  const subsByDelivery = useMemo(() => {
    const map = {};
    (subs || []).forEach((s) => { (map[s.delivery_id] ||= []).push(s); });
    Object.values(map).forEach((list) => list.sort((a, b) => (a.order_index || 0) - (b.order_index || 0)));
    return map;
  }, [subs]);

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['deliveries'] });
    qc.invalidateQueries({ queryKey: ['subdeliveries'] });
    qc.invalidateQueries({ queryKey: ['native-deliveries'] });
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-5 pt-5">
        <Send className="w-4 h-4 text-muted-foreground" />
        <p className="text-[13px] font-semibold text-foreground">Buyer Deliveries ({mine.length})</p>
      </div>
      <p className="px-5 pt-1 text-[11px] text-muted-foreground">
        Where this buyer&apos;s accepted leads are sent. Campaigns point at these, they do not own them.
      </p>

      {isLoading ? (
        <div className="px-5 py-6 text-[12px] text-muted-foreground">Loading deliveries...</div>
      ) : (
        <div className="pt-2">
          <BuyerDeliveryRows
            deliveries={mine}
            subsByDelivery={subsByDelivery}
            buyerId={buyerId}
            onChanged={invalidateAll}
          />
        </div>
      )}
    </div>
  );
}
