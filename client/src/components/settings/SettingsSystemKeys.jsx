import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/lib/AuthContext';
import { systemKeys } from '@/functions/systemKeys';
import Base44SyncStatus from '@/components/settings/Base44SyncStatus';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { CheckCircle2, Circle, KeyRound, Lock, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

// System Keys: the credentials DashFlo itself holds in order to reach other
// services.
//
// The shape is list and detail, matching Integrations, rather than one table
// plus a permanently expanded Meta form. Each platform credential is a
// discrete item that has to be opened before anything about it is shown, and
// a secret is never rendered after it is saved. What comes back from the
// server is metadata: whether a secret is set, its last four characters, when
// it was created and rotated, and whether it is active.
//
// The distinction from Integrations is deliberate and is worth stating in the
// UI, because the two would otherwise look like duplicates:
//
//   Integrations  operational connection. Connected or not, which account,
//                 sync status, provider-specific operational settings.
//   System Keys   credential ownership. Client IDs, secrets, rotation,
//                 revocation, audit.
//
// Meta appears in both: as a connection in Integrations, and as the underlying
// application credential here.

// The platform credentials DashFlo actually uses. A provider listed here gets a
// card whether or not a record exists yet, so "Google sign-in is not configured"
// is visible rather than being an absence.
const CATALOG = [
  {
    provider: 'google',
    name: 'Google Authentication',
    purpose: 'Google sign-in for the operator application',
    envVar: 'GOOGLE_CLIENT_ID',
    fields: { clientId: true, secret: false },
    clientIdLabel: 'Client ID',
    note: 'Only the Client ID is needed. DashFlo verifies Google ID tokens against Google\'s public signing keys, so login uses no Client Secret. Scopes are openid, email and profile.',
  },
  {
    provider: 'meta',
    name: 'Meta App',
    purpose: 'Meta Ads OAuth application credentials',
    envVar: 'META_APP_SECRET',
    fields: { clientId: true, secret: true },
    clientIdLabel: 'App ID',
    secretLabel: 'App Secret',
    note: 'Used by the Meta connection in Integrations. Connecting an ad account is an operational action; the application credential lives here.',
  },
  { provider: 'anthropic', name: 'Anthropic', purpose: 'Model provider for assistants and extraction', envVar: 'ANTHROPIC_API_KEY', fields: { clientId: false, secret: true } },
  { provider: 'openai', name: 'OpenAI', purpose: 'Alternative model provider', envVar: 'OPENAI_API_KEY', fields: { clientId: false, secret: true } },
  { provider: 'stripe', name: 'Stripe', purpose: 'Billing and payment reconciliation', envVar: 'STRIPE_API_KEY', fields: { clientId: false, secret: true } },
];

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'meta', 'google', 'stripe', 'mcp_server', 'other'];

const BLANK = { name: '', provider: 'other', purpose: '', env_var: '', client_id: '', secret: '', active: true };

function when(value) {
  if (!value) return null;
  try { return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return null; }
}

function CredentialCard({ entry, record, onOpen }) {
  const configured = Boolean(record?.secret_set) || (entry.fields.secret === false && Boolean(record?.client_id));
  const inactive = record && record.active === false;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry, record)}
      className="group w-full rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">{record?.name || entry.name}</div>
          <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{entry.provider}</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium ${
          inactive ? 'text-muted-foreground' : configured ? 'status-sold' : 'text-muted-foreground'
        }`}>
          {configured && !inactive
            ? <><CheckCircle2 className="h-3.5 w-3.5" /> Configured</>
            : inactive
              ? <><Circle className="h-3.5 w-3.5" /> Inactive</>
              : <><Circle className="h-3.5 w-3.5" /> Not set</>}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
        {record?.purpose || entry.purpose}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        {record?.last4
          ? <span className="font-mono">Ends {record.last4}</span>
          : <span>No credential stored</span>}
        {when(record?.updated_date) && <span>Updated {when(record.updated_date)}</span>}
        {when(record?.rotated_at) && <span>Rotated {when(record.rotated_at)}</span>}
      </div>
    </button>
  );
}

export default function SettingsSystemKeys() {
  const { realRole } = usePermissions();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);

  const { data = [] } = useQuery({
    queryKey: ['system-keys'],
    queryFn: async () => ((await systemKeys({ op: 'system_list' })).data?.keys || []),
    enabled: realRole === 'owner',
  });

  const byProvider = useMemo(() => {
    const map = new Map();
    for (const row of data) {
      const key = row.provider || 'other';
      // Prefer a record that actually holds a credential when a provider has
      // more than one row, so the card reflects the one in use.
      const current = map.get(key);
      if (!current || (!current.secret_set && row.secret_set)) map.set(key, row);
    }
    return map;
  }, [data]);

  const custom = useMemo(
    () => data.filter((row) => !CATALOG.some((entry) => entry.provider === row.provider)),
    [data],
  );

  if (realRole !== 'owner') {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <Lock className="mx-auto h-5 w-5 text-muted-foreground" />
        <div className="mt-2 text-[14px] font-semibold">System Keys are owner only</div>
        <p className="mt-1 text-[12px] text-muted-foreground">Supplier and buyer API keys remain available in their own categories.</p>
      </div>
    );
  }

  const openEditor = (catalogEntry, record) => {
    setEntry(catalogEntry);
    setForm(record ? {
      id: record.id,
      name: record.name || catalogEntry?.name || '',
      provider: record.provider || catalogEntry?.provider || 'other',
      purpose: record.purpose || catalogEntry?.purpose || '',
      env_var: record.env_var || catalogEntry?.envVar || '',
      client_id: record.client_id || '',
      // Always blank. The stored secret is not sent to the browser and is not
      // reconstructable here; leaving the field empty keeps the stored value.
      secret: '',
      active: record.active !== false,
      last4: record.last4 || '',
      secret_set: Boolean(record.secret_set),
    } : {
      ...BLANK,
      name: catalogEntry?.name || '',
      provider: catalogEntry?.provider || 'other',
      purpose: catalogEntry?.purpose || '',
      env_var: catalogEntry?.envVar || '',
    });
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const { last4, secret_set: _secretSet, ...payload } = form;
      const out = (await systemKeys({ op: 'system_save', ...payload })).data;
      if (out?.success === false) throw new Error(out.error);
      toast.success(form.id ? 'Credential updated' : 'Credential saved');
      setOpen(false); setForm(BLANK); setEntry(null);
      qc.invalidateQueries({ queryKey: ['system-keys'] });
      qc.invalidateQueries({ queryKey: ['api-key-overview'] });
      qc.invalidateQueries({ queryKey: ['meta-connection-status'] });
      qc.invalidateQueries({ queryKey: ['google-auth-config'] });
    } catch (error) {
      toast.error(error?.message || 'Could not save the credential');
    }
    setSaving(false);
  };

  const showClientId = entry ? entry.fields.clientId : true;
  const showSecret = entry ? entry.fields.secret !== false : true;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          These are the credentials DashFlo uses to reach other services. Integrations is where a
          connection is turned on and an account is chosen; this is where the underlying credential
          is stored and rotated. A secret is never shown again after it is saved.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Platform credentials</div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {CATALOG.map((item) => (
            <CredentialCard key={item.provider} entry={item} record={byProvider.get(item.provider)} onOpen={openEditor} />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Other credentials</span>
          <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => openEditor(null, null)}>
            <Plus className="h-3.5 w-3.5" /> Add credential
          </Button>
        </div>
        {custom.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground">
            No additional credentials configured
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {custom.map((row) => (
              <CredentialCard
                key={row.id}
                entry={{ provider: row.provider || 'other', name: row.name, purpose: row.purpose || '', fields: { clientId: true, secret: true } }}
                record={row}
                onOpen={openEditor}
              />
            ))}
          </div>
        )}
      </div>

      <Base44SyncStatus />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[540px] border-border bg-popover">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              {form.id ? (form.name || 'Credential') : (entry?.name || 'Add credential')}
            </DialogTitle>
            {entry?.note && <DialogDescription className="text-[12px] leading-relaxed">{entry.note}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-3">
            {!entry && (
              <div>
                <Label>Name</Label>
                <Input className="mt-1 bg-background" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
              </div>
            )}
            {!entry && (
              <div>
                <Label>Provider</Label>
                <SearchableSelect
                  className="mt-1 bg-background"
                  value={form.provider}
                  onValueChange={(provider) => setForm((p) => ({ ...p, provider }))}
                  options={PROVIDERS.map((p) => ({ value: p, label: p }))}
                />
              </div>
            )}
            <div>
              <Label>Purpose</Label>
              <Input className="mt-1 bg-background" value={form.purpose} onChange={(e) => setForm((p) => ({ ...p, purpose: e.target.value }))} />
            </div>

            {showClientId && (
              <div>
                <Label>{entry?.clientIdLabel || 'Client ID'}</Label>
                <Input
                  className="mt-1 bg-background font-mono"
                  value={form.client_id}
                  onChange={(e) => setForm((p) => ({ ...p, client_id: e.target.value }))}
                  placeholder={entry?.provider === 'google' ? '000000000000-xxxxxxxx.apps.googleusercontent.com' : ''}
                />
                {entry?.provider === 'google' && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Public by design. The browser receives it so Google can render its button.
                  </p>
                )}
              </div>
            )}

            {showSecret && (
              <div>
                <Label>{entry?.secretLabel || 'Secret'}</Label>
                <Input
                  type="password"
                  autoComplete="new-password"
                  className="mt-1 bg-background font-mono"
                  value={form.secret}
                  onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))}
                  placeholder={form.secret_set ? `Stored, ends ${form.last4 || '****'}. Leave blank to keep it.` : 'Credential value'}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Held server-side and never returned to the browser. Entering a value rotates it.
                </p>
              </div>
            )}

            <div>
              <Label>Environment name</Label>
              <Input
                className="mt-1 bg-background font-mono"
                value={form.env_var}
                onChange={(e) => setForm((p) => ({ ...p, env_var: e.target.value }))}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={form.active} onCheckedChange={(active) => setForm((p) => ({ ...p, active }))} />
              <Label>Active</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !form.name}>{saving ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
