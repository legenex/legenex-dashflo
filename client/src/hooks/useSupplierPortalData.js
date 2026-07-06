import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useSupplierPortalScope } from './useSupplierPortalScope';

// Fetches supplier-scoped portal data (leads, returns, api key, ad reporting)
// via the backend function, which enforces scoping server-side.
export function useSupplierPortalData() {
  const { previewSupplierId } = useSupplierPortalScope();

  const query = useQuery({
    queryKey: ['supplier-portal-data', previewSupplierId || 'self'],
    queryFn: async () => {
      const res = await api.functions.invoke('supplierPortalData', previewSupplierId ? { supplier_id: previewSupplierId } : {});
      return res.data;
    },
    retry: false,
  });

  return query;
}