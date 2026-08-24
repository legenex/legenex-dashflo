import React from 'react';
import { api } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';

const STATUS_VARIANT = {
  accepted: 'outline', rejected: 'destructive', duplicate: 'outline',
  queued: 'outline', error: 'destructive', dead_letter: 'destructive', pending: 'outline', sent: 'outline',
};

// Delivery history for one native SubDelivery, read from the real
// DeliveryAttempt entity (server/src/schemas/entities/DeliveryAttempt.json).
// request_meta/response_meta are already redacted and minimized server-side
// (deliveryAttempt.js's buildAttemptRecord) before they ever reach this
// query, so nothing further needs to be hidden here.
export default function DeliveryHistoryTab({ subDeliveryId }) {
  const { data: attempts = [], isLoading } = useQuery({
    queryKey: ['delivery-attempts', subDeliveryId],
    queryFn: () => api.entities.DeliveryAttempt.filter({ sub_delivery_id: subDeliveryId }, '-created_date', 100),
    enabled: !!subDeliveryId,
  });

  if (!subDeliveryId) {
    return <p className="text-[12px] text-muted-foreground py-4">Save this delivery to see its history.</p>;
  }
  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }
  if (attempts.length === 0) {
    return <p className="text-[12px] text-muted-foreground py-4">No delivery attempts recorded yet.</p>;
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="grid grid-cols-[140px_90px_70px_70px_1fr_110px] gap-2 px-3 py-2 border-b border-border bg-background/40 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>When</span><span>Status</span><span>HTTP</span><span>Attempt</span><span>Error</span><span>Lead</span>
      </div>
      {attempts.map((a) => (
        <div key={a.id} className="grid grid-cols-[140px_90px_70px_70px_1fr_110px] gap-2 px-3 py-2 border-b border-border last:border-b-0 items-center text-[12px]">
          <span className="text-muted-foreground text-[11px]">
            {a.completed_at || a.created_date ? format(new Date(a.completed_at || a.created_date), 'MMM d HH:mm:ss') : '-'}
          </span>
          <Badge variant={STATUS_VARIANT[a.status] || 'outline'} className="w-fit font-mono">{a.status}</Badge>
          <span className="font-mono text-muted-foreground">{a.http_status ?? '-'}</span>
          <span className="font-mono text-muted-foreground">{a.attempt_number ?? 1}{a.is_primary === false ? ' (retry)' : ''}</span>
          <span className="text-muted-foreground truncate">{a.error_class || '-'}</span>
          <span className="font-mono text-muted-foreground truncate">{a.lead_id || '-'}</span>
        </div>
      ))}
    </div>
  );
}
