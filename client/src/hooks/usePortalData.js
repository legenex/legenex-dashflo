import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { usePortalScope } from './usePortalScope';

// Fetches buyer-scoped portal data (leads, feedback, returns) via the backend
// function, which enforces scoping server-side.
export function usePortalData() {
  const { previewBuyerId } = usePortalScope();

  const query = useQuery({
    queryKey: ['portal-data', previewBuyerId || 'self'],
    queryFn: async () => {
      const res = await api.functions.invoke('portalData', previewBuyerId ? { buyer_id: previewBuyerId } : {});
      return res.data;
    },
    retry: false,
  });

  return query;
}