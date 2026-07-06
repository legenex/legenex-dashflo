import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import ToolTile from '@/components/tools/ToolTile';
import { leadField } from '@/lib/reportMetrics';
import { Users, Factory, MapPin, ReceiptText, UserPlus, Megaphone } from 'lucide-react';

const num = (n) => (n ?? 0).toLocaleString();

function StatCard({ label, value, hint, tone }) {
  const toneClass = tone === 'good' ? 'status-sold' : tone === 'warn' ? 'status-unsold' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.4)]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground/70 truncate">{label}</div>
      <div className={`text-[24px] font-bold font-mono tabular-nums mt-1 leading-none whitespace-nowrap ${toneClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground/70 mt-1.5 truncate">{hint}</div>}
    </div>
  );
}

// Operations landing dashboard: who is live right now, mirroring the Tools dashboard.
export default function OperationsDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['operations-dashboard'],
    queryFn: async () => {
      const [buyers, suppliers, campaigns, brands, verticals, leads] = await Promise.all([
        api.entities.Buyer.list(),
        api.entities.Supplier.list(),
        api.entities.Campaign.list(),
        api.entities.Brand.list(),
        api.entities.Vertical.list(),
        api.entities.Lead.list('-created_date', 2000),
      ]);
      const cutoff = Date.now() - 30 * 86400000;
      const recent = leads.filter(l => l.created_date && new Date(l.created_date).getTime() >= cutoff);
      const activeSuppliers = new Set(recent.map(l => l.supplier_name).filter(Boolean));
      const activeStates = new Set(recent.map(l => l.state).filter(Boolean));
      const activeBuyers = new Set(recent.map(l => leadField(l, 'buyer_id')).filter(Boolean));
      return {
        buyersTotal: buyers.length,
        suppliersTotal: suppliers.length,
        activeBuyers: activeBuyers.size,
        activeSuppliers: activeSuppliers.size,
        activeStates: activeStates.size,
        activeCampaigns: campaigns.filter(c => c.active).length,
        campaignsTotal: campaigns.length,
        activeBrands: brands.filter(b => b.active).length,
        activeVerticals: verticals.filter(v => v.active).length,
        recentLeads: recent.length,
      };
    },
  });

  const d = data || {};
  const dash = (v) => (isLoading ? '-' : num(v));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[19px] font-semibold text-foreground">
          Operations <span className="text-muted-foreground/70 font-normal">/ Dashboard</span>
        </h1>
        <p className="text-[13px] text-muted-foreground mt-1">Who is live right now: active buyers, suppliers and states across the last 30 days.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Active Buyers" value={dash(d.activeBuyers)} hint={`${dash(d.buyersTotal)} total`} tone="good" />
        <StatCard label="Active Suppliers" value={dash(d.activeSuppliers)} hint={`${dash(d.suppliersTotal)} total`} tone="good" />
        <StatCard label="Active States" value={dash(d.activeStates)} hint="states receiving leads" tone="good" />
        <StatCard label="Active Campaigns" value={dash(d.activeCampaigns)} hint={`${dash(d.campaignsTotal)} total`} tone={(d.activeCampaigns ?? 0) > 0 ? 'good' : 'warn'} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToolTile
          to="/operations/buyers"
          icon={Users}
          title="Buyers"
          description="Active buyers, acceptance and exposure across campaigns."
          status={(d.activeBuyers ?? 0) > 0 ? 'ok' : 'warn'}
          stats={[{ label: 'Active', value: dash(d.activeBuyers) }, { label: 'Total', value: dash(d.buyersTotal) }]}
        />
        <ToolTile
          to="/operations/suppliers"
          icon={Factory}
          title="Suppliers"
          description="Sources sending leads and their recent volume."
          status={(d.activeSuppliers ?? 0) > 0 ? 'ok' : 'warn'}
          stats={[{ label: 'Active', value: dash(d.activeSuppliers) }, { label: 'Total', value: dash(d.suppliersTotal) }]}
        />
        <ToolTile
          to="/operations/active-states"
          icon={MapPin}
          title="Active States"
          description="Geographic coverage of leads in the last 30 days."
          status={(d.activeStates ?? 0) > 0 ? 'ok' : 'warn'}
          stats={[{ label: 'States', value: dash(d.activeStates) }, { label: 'Leads 30d', value: dash(d.recentLeads) }]}
        />
        <ToolTile
          to="/operations/billing-reports"
          icon={ReceiptText}
          title="Billing Reports"
          description="Per-buyer billing exports and reconciliation."
          status="ok"
          stats={[{ label: 'Brands', value: dash(d.activeBrands) }, { label: 'Verticals', value: dash(d.activeVerticals) }]}
        />
        <ToolTile
          to="/operations/buyer-onboarding"
          icon={UserPlus}
          title="Buyer Onboarding"
          description="Bring a new buyer live: mapping, caps and go-live checks."
          status="ok"
          stats={[{ label: 'Campaigns', value: dash(d.activeCampaigns) }, { label: 'Hint', value: 'Set up flow' }]}
        />
        <ToolTile
          to="/campaigns"
          icon={Megaphone}
          title="Campaigns"
          description="Manage campaigns, verticals, buyers, suppliers and brands."
          status="ok"
          stats={[{ label: 'Active', value: dash(d.activeCampaigns) }, { label: 'Total', value: dash(d.campaignsTotal) }]}
        />
      </div>
    </div>
  );
}
