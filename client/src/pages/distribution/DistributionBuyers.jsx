import React, { useMemo, useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import SectionHeader from '@/components/shared/SectionHeader';
import { Button } from '@/components/ui/button';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Loader2, Plus, ExternalLink, GitBranch, Users } from 'lucide-react';
import RouteMemberEditor from '@/components/distribution/RouteMemberEditor';
import BuyerDeliveriesPanel from '@/components/distribution/BuyerDeliveriesPanel';

const buyerLabel = (b) => b?.company_name || b?.name || b?.id || 'Unknown buyer';
const isBuyerActive = (b) => (b?.status ? String(b.status).toLowerCase() === 'active' && b.active === true : b?.active === true);

// Status badge per DESIGN-SYSTEM.md: rounded-full pill, bordered, token colors only.
function StatusBadge({ active, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium ${active ? 'text-primary' : 'text-muted-foreground'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-primary' : 'bg-muted-foreground'}`} />
      {label}
    </span>
  );
}

const DETAIL_TABS = [
  { key: 'routing', label: 'Routing' },
  { key: 'deliveries', label: 'Deliveries' },
  { key: 'summary', label: 'Summary' },
];

// Underline tab strip per DESIGN-SYSTEM.md.
function UnderlineTabs({ tabs, value, onChange }) {
  return (
    <div className="border-b border-border flex gap-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
            value === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function DistributionBuyers() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: buyers = [], isLoading } = useQuery({ queryKey: ['buyers'], queryFn: () => api.entities.Buyer.list('-created_date', 1000) });

  const selected = buyers.find((b) => b.id === id) || null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <SectionHeader title="Buyers" subtitle="Buyer-centric routing, deliveries, and commercial summary" />
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(260px,320px)_1fr] gap-5 items-start overflow-hidden pb-8">
        {/* Buyer list card */}
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {isLoading && (
            <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading buyers...
            </div>
          )}
          {!isLoading && buyers.length === 0 && (
            <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              <Users className="w-7 h-7 text-muted-foreground mx-auto mb-2" /> No buyers.
            </div>
          )}
          <div className="divide-y divide-border">
            {buyers.map((b) => (
              <button
                key={b.id}
                onClick={() => navigate(`/distribution/buyers/${b.id}`)}
                className={`w-full text-left px-4 py-3 flex items-center justify-between gap-2 text-[13px] transition-colors ${
                  id === b.id ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent'
                }`}
              >
                <span className="truncate">{buyerLabel(b)}</span>
                <StatusBadge active={isBuyerActive(b)} label={isBuyerActive(b) ? 'active' : (b?.status || 'inactive')} />
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="min-w-0">
          {!selected ? (
            <div className="rounded-lg border border-border bg-card p-12 text-center">
              <Users className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <div className="text-[13px] font-medium text-foreground">Select a buyer</div>
              <div className="text-[12px] text-muted-foreground mt-1">Manage routing, deliveries, and view the commercial summary.</div>
            </div>
          ) : (
            <BuyerDetail buyer={selected} />
          )}
        </div>
      </div>
    </div>
  );
}

function BuyerDetail({ buyer }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = DETAIL_TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'routing';
  const setTab = (v) => setSearchParams((p) => { p.set('tab', v); return p; }, { replace: true });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base font-semibold text-foreground truncate">{buyerLabel(buyer)}</span>
          <StatusBadge active={isBuyerActive(buyer)} label={isBuyerActive(buyer) ? 'active' : (buyer?.status || 'inactive')} />
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/operations/buyers"><ExternalLink className="w-4 h-4 mr-1.5" />Manage in Operations</Link>
        </Button>
      </div>

      <UnderlineTabs tabs={DETAIL_TABS} value={tab} onChange={setTab} />

      <div className="pt-1">
        {tab === 'routing' && <RoutingTab buyer={buyer} />}
        {tab === 'deliveries' && <BuyerDeliveriesPanel buyerId={buyer.id} />}
        {tab === 'summary' && <SummaryTab buyer={buyer} />}
      </div>
    </div>
  );
}

// Routing tab: this buyer's RouteMembers with the existing typed editor. Creating
// a member auto-attaches it to the chosen campaign's default RouteGroup (created
// lazily, lifecycle draft, if the campaign has none yet).
function RoutingTab({ buyer }) {
  const qc = useQueryClient();
  const [campaignId, setCampaignId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorGroup, setEditorGroup] = useState(null);
  const [editorMember, setEditorMember] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data: campaigns = [] } = useQuery({ queryKey: ['campaigns'], queryFn: () => api.entities.Campaign.list('-created_date', 500) });
  const { data: groups = [] } = useQuery({ queryKey: ['routegroups'], queryFn: () => api.entities.RouteGroup.list('-created_date', 1000) });
  const { data: members = [] } = useQuery({ queryKey: ['routemembers'], queryFn: () => api.entities.RouteMember.list('-created_date', 5000) });

  const groupById = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups]);
  const campaignById = useMemo(() => Object.fromEntries(campaigns.map((c) => [c.id, c])), [campaigns]);
  const buyerMembers = members.filter((m) => m.buyer_id === buyer.id);

  async function ensureDefaultGroup(cid) {
    const existing = groups
      .filter((g) => String(g.campaign_id) === String(cid))
      .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
    if (existing.length) return existing[0];
    const created = await api.entities.RouteGroup.create({
      campaign_id: cid, name: 'Default', method: 'priority', order_index: 0, lifecycle: 'draft', active: false,
    });
    await qc.invalidateQueries({ queryKey: ['routegroups'] });
    return created;
  }

  async function startCreate() {
    if (!campaignId) { toast.error('Pick a campaign first'); return; }
    setBusy(true);
    try {
      const group = await ensureDefaultGroup(campaignId);
      setEditorGroup(group);
      setEditorMember({ buyer_id: buyer.id, active: true, priority: 1, weight: 1, price_mode: 'fixed' });
      setEditorOpen(true);
    } catch (e) { toast.error(e.message || 'Could not prepare the default group'); } finally { setBusy(false); }
  }

  function startEdit(m) {
    setEditorGroup(groupById[m.route_group_id] || null);
    setEditorMember(m);
    setEditorOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-64">
          <div className="text-[12px] text-muted-foreground mb-1">Campaign for new routing</div>
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select campaign" /></SelectTrigger>
            <SelectContent>{campaigns.map((c) => <SelectItem key={c.id} value={c.id}>{c.name || c.id}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={startCreate} disabled={busy || !campaignId}>
          {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plus className="w-4 h-4 mr-1.5" />}Add routing
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {buyerMembers.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            <GitBranch className="w-7 h-7 text-muted-foreground mx-auto mb-2" /> This buyer has no routing members yet.
          </div>
        )}
        <div className="divide-y divide-border">
          {buyerMembers.map((m) => {
            const g = groupById[m.route_group_id];
            const c = g && campaignById[g.campaign_id];
            const active = m.active !== false;
            return (
              <button key={m.id} onClick={() => startEdit(m)} className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-accent text-[13px] transition-colors">
                <span className="flex items-center gap-2 min-w-0">
                  <GitBranch className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-foreground">{c ? (c.name || c.id) : 'Unknown campaign'} · {g ? (g.name || 'group') : 'no group'}</span>
                </span>
                <span className="shrink-0 flex items-center gap-3 text-[12px] text-muted-foreground">
                  <span>pri {m.priority ?? 1}</span>
                  {m.price_mode === 'fixed' && m.fixed_price != null && <span className="font-mono">${m.fixed_price}</span>}
                  <StatusBadge active={active} label={active ? 'on' : 'off'} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <RouteMemberEditor open={editorOpen} onOpenChange={setEditorOpen} group={editorGroup} member={editorMember} />
    </div>
  );
}

// Read-only commercial summary. Editing lives in Operations (single source of truth).
function SummaryTab({ buyer }) {
  const { data: wallets = [] } = useQuery({ queryKey: ['buyerwallets'], queryFn: () => api.entities.BuyerWallet.list('-created_date', 2000) });
  const { data: stateCpl = [] } = useQuery({ queryKey: ['buyerstatecpl'], queryFn: () => api.entities.BuyerStateCpl.list('-created_date', 5000).catch(() => []) });

  const wallet = wallets.find((w) => w.buyer_id === buyer.id) || null;
  const coverageCount = stateCpl.filter((r) => r.buyer_id === buyer.id).length;

  const rows = [
    ['Lifecycle', buyer.status ? `${buyer.status}${buyer.active === true ? ' (active)' : ''}` : (buyer.active === true ? 'active' : 'inactive')],
    ['Billing type', buyer.billing_type || buyer.billing_mode || 'unknown'],
    ['Wallet balance', wallet ? String(wallet.balance ?? 0) : 'no wallet record'],
    ['State coverage rules', String(coverageCount)],
  ];

  return (
    <div className="space-y-3 max-w-xl">
      <div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-3 text-[13px]">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium text-foreground">{v}</span>
          </div>
        ))}
      </div>
      <div className="text-[12px] text-muted-foreground">
        Pricing, lifecycle, and state coverage are edited in Operations, not here.
      </div>
      <Button asChild size="sm" variant="outline">
        <Link to="/operations/buyers"><ExternalLink className="w-4 h-4 mr-1.5" />Manage in Operations</Link>
      </Button>
    </div>
  );
}
