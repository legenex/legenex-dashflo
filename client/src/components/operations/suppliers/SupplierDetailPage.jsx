import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Megaphone } from 'lucide-react';
import SupplierStatusPill from './SupplierStatusPill';
import SupplierChannelsCell from './SupplierChannelsCell';
import SupplierPayoutTab from './SupplierPayoutTab';
import SupplierNotificationsTab from './SupplierNotificationsTab';
import SupplierSourcesTab from './SupplierSourcesTab';
import PortalEnablementCard from '@/components/shared/PortalEnablementCard';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'leads', label: 'Leads' },
];

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// Full-page supplier (source) detail. Swapped in-place over the list by the
// parent page. Overview lays the reused payout + notifications editors into a
// two-card grid, with the sources/campaigns list full-width below. Leads is a
// stub until its data source is wired.
export default function SupplierDetailPage({ supplier, onBack }) {
  const [tab, setTab] = useState('overview');

  const { data: sources = [] } = useQuery({
    queryKey: ['supplier-sources', supplier.id],
    queryFn: () => api.entities.SupplierSource.filter({ supplier_id: supplier.id }, 'source_code', 500),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Back to suppliers"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-semibold text-foreground truncate">{supplier.name || 'Supplier'}</h1>
            <SupplierStatusPill status={supplier.status} />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="font-mono text-[11px] text-muted-foreground">{supplier.sid || 'No SID'}</span>
            <span className="text-muted-foreground/40">|</span>
            <span className="text-[12px] text-muted-foreground">{supplier.supplier_type || 'Unclassified'}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            {/* Source Profile — reuses the existing editable payout form */}
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-4">Source Profile</p>
              <SupplierPayoutTab supplier={supplier} />
            </div>

            {/* Source Portal — access + invite, then notifications editor */}
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-4">Source Portal</p>
              <PortalEnablementCard
                record={supplier}
                entityName="Supplier"
                contactName={supplier.contact_name}
                contactEmail={supplier.email}
                previewPath={`/supplier-portal?supplier_id=${encodeURIComponent(supplier.id)}`}
                queryKey={['op-suppliers']}
                label="source portal"
              />
              <div className="mt-5 pt-5 border-t border-border">
                <SupplierNotificationsTab supplier={supplier} />
              </div>
            </div>
          </div>

          {/* Campaigns / sources this supplier feeds, full width */}
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-4">Campaigns &amp; Sources</p>
            <SupplierSourcesTab supplier={supplier} />
          </div>
        </div>
      )}

      {tab === 'leads' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <Megaphone className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-[13px] font-medium text-foreground">Leads</p>
          <p className="text-[12px] text-muted-foreground mt-1">Leads from this source will appear here.</p>
        </div>
      )}
    </div>
  );
}