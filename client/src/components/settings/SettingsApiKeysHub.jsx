import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { systemKeys } from '@/functions/systemKeys';
import SettingsSystemKeys from '@/components/settings/SettingsSystemKeys';
import SettingsApiKeys from '@/components/settings/SettingsApiKeys';
import SettingsBuyerKeys from '@/components/settings/SettingsBuyerKeys';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, KeyRound, Lock, Server, Users, Building2, AlertTriangle } from 'lucide-react';

// The API Keys surface.
//
// The page opens on a dashboard of category cards rather than on a list of
// credentials. Two reasons, and the second is the one that matters:
//
//   1. Counts and status are what an operator wants on arrival. "Are the
//      platform credentials configured, how many supplier keys are live, how
//      many buyers have one" is answerable at a glance.
//   2. A credential surface should not put credentials on screen because
//      somebody navigated to Settings. Each category is opened deliberately,
//      and the Meta application credentials in particular are one item among
//      several rather than a permanently expanded form at the top of the page.
//
// Nothing on this landing view is a credential, a masked credential or even a
// prefix. The overview call returns counts and status only.

const CATEGORIES = [
  {
    key: 'system',
    label: 'System Keys',
    icon: Server,
    blurb: 'Platform credentials DashFlo uses to reach other services: Google sign-in, the Meta app, model providers, Stripe.',
    ownerOnly: true,
  },
  {
    key: 'supplier',
    label: 'Supplier Keys',
    icon: Users,
    blurb: 'Ingest credentials suppliers post leads with. Hash only at rest; the value is shown once when issued.',
  },
  {
    key: 'buyer',
    label: 'Buyer Keys',
    icon: Building2,
    blurb: 'Credentials issued to buyers for feedback, returns and dispositions.',
  },
];

function Stat({ label, value, tone = 'default' }) {
  const toneClass = tone === 'warn'
    ? 'text-status-unsold'
    : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div>
      <div className={`text-[20px] font-semibold leading-none tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function CategoryCard({ category, summary, onOpen }) {
  const Icon = category.icon;
  const locked = summary?.locked;

  return (
    <button
      type="button"
      onClick={() => !locked && onOpen(category.key)}
      disabled={locked}
      aria-label={`Open ${category.label}`}
      className={`group w-full rounded-lg border border-border bg-card p-4 text-left transition-colors ${
        locked ? 'cursor-not-allowed opacity-70' : 'hover:border-primary/50 hover:bg-accent/40'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {locked ? <Lock className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground">{category.label}</span>
            {!locked && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {locked ? (summary?.reason || 'Not available for your role') : category.blurb}
          </p>
        </div>
      </div>

      {!locked && (
        <div className="mt-4 flex flex-wrap gap-6 border-t border-border pt-3">
          {category.key === 'system' && (
            <>
              <Stat label="Stored" value={summary?.stored ?? 0} />
              <Stat label="Active" value={summary?.active ?? 0} />
              <Stat label="Configured" value={summary?.configured ?? 0} tone={summary?.configured ? 'default' : 'muted'} />
            </>
          )}
          {category.key === 'supplier' && (
            <>
              <Stat label="Issued" value={summary?.issued ?? 0} />
              <Stat label="Active" value={summary?.active ?? 0} />
              <Stat label="Requests" value={summary?.requests ?? 0} tone="muted" />
            </>
          )}
          {category.key === 'buyer' && (
            <>
              <Stat label="Issued" value={summary?.issued ?? 0} />
              <Stat label="Active" value={summary?.active ?? 0} />
              <Stat
                label="Buyers covered"
                value={`${summary?.buyers_covered ?? 0}/${summary?.buyers_total ?? 0}`}
                tone="muted"
              />
            </>
          )}
        </div>
      )}

      {!locked && category.key === 'system' && (summary?.providers?.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {summary.providers.map((provider) => (
            <span key={provider} className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {provider}
            </span>
          ))}
        </div>
      )}

      {/* A key still on the retired Legenex prefix cannot be converted in
          place, because only its hash is stored. Saying so here is the only
          way an operator learns it needs rotating. */}
      {!locked && category.key === 'supplier' && summary?.legacy_namespace > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-status-unsold/40 bg-status-unsold/10 px-2.5 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-unsold" />
          <span className="text-[11px] leading-relaxed text-foreground">
            {summary.legacy_namespace} key{summary.legacy_namespace === 1 ? '' : 's'} still on the retired prefix. Rotate to move to the DashFlo namespace.
          </span>
        </div>
      )}
    </button>
  );
}

export default function SettingsApiKeysHub() {
  const [category, setCategory] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-key-overview'],
    queryFn: async () => (await systemKeys({ op: 'overview' })).data?.categories || {},
  });

  if (category) {
    const active = CATEGORIES.find((item) => item.key === category);
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" onClick={() => setCategory(null)}>
            <ChevronLeft className="h-4 w-4" /> API Keys
          </Button>
          <span className="text-muted-foreground">/</span>
          <span className="text-[13px] font-semibold">{active?.label}</span>
        </div>
        {category === 'system' && <SettingsSystemKeys />}
        {category === 'supplier' && <SettingsApiKeys />}
        {category === 'buyer' && <SettingsBuyerKeys />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          Credentials are grouped by what they are for. Open a category to manage it. Values are
          never shown after they are created: DashFlo stores a hash, so a lost key is rotated
          rather than recovered.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {CATEGORIES.map((item) => (
          <CategoryCard
            key={item.key}
            category={item}
            summary={isLoading ? null : data?.[item.key]}
            onOpen={setCategory}
          />
        ))}
      </div>
    </div>
  );
}
