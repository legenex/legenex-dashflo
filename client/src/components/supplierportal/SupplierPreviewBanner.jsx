import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, X } from 'lucide-react';
import { useSupplierPortalScope } from '@/hooks/useSupplierPortalScope';

// Shown when an operator is viewing the portal as a supplier (preview mode).
export default function SupplierPreviewBanner({ supplierName }) {
  const navigate = useNavigate();
  const { previewing, previewSupplierId } = useSupplierPortalScope();
  if (!previewing) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-primary/15 border border-primary/30 rounded-lg px-4 py-2.5 mb-5">
      <div className="flex items-center gap-2 text-[13px] text-foreground">
        <Eye className="w-4 h-4 text-primary" />
        <span>Preview Mode — viewing the portal as <span className="font-semibold">{supplierName || 'this supplier'}</span>.</span>
      </div>
      <button
        onClick={() => navigate(`/suppliers/${previewSupplierId}`)}
        className="flex items-center gap-1 text-[12px] text-primary hover:underline shrink-0"
      >
        <X className="w-3.5 h-3.5" /> Exit preview
      </button>
    </div>
  );
}