import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import integrationConfigStatus from '@/functions/integrationConfigStatus';
import saveIntegrationConfig from '@/functions/saveIntegrationConfig';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { CheckCircle2, Plug, Save, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

// Reusable "connect via API key" dialog. Stores credentials in IntegrationConfig(name)
// and calls an optional verify function ({ ...fields, verify_only:true }) on connect.
// fields: [{ key, label, placeholder, secret, optional, help }]
export default function ApiKeyConnectDialog({ open, onOpenChange, name, title, description, fields, verifyFn, syncFn, syncLabel = 'Sync Now' }) {
  const qc = useQueryClient();
  const [values, setValues] = useState({});
  const [cfg, setCfg] = useState(null);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Task S4. The stored blob is no longer readable through the entity route,
  // and it never should have been. integrationConfigStatus returns the
  // non-secret settings by value and each secret as a presence flag, which is
  // everything this dialog needs: prefill the settings, show "Connected", and
  // tell the operator which secrets are already stored.
  const [secrets, setSecrets] = useState({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const res = await integrationConfigStatus({ name });
        const info = (res?.data?.integrations || {})[name] || {};
        setCfg(info.exists ? { id: info.id } : null);
        setMeta(info.values || {});
        setSecrets(info.secrets || {});
        // Prefill the non-secret settings. Secrets are never sent back, so
        // their inputs start blank and blank means "keep what is stored".
        const init = {};
        fields.forEach(f => { init[f.key] = f.secret ? '' : ((info.values || {})[f.key] || ''); });
        setValues(init);
      } catch { setCfg(null); setMeta({}); setSecrets({}); }
      setLoading(false);
    })();
  }, [open, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = !!cfg;
  const storedSecret = (key) => secrets[key]?.set === true;

  const save = async () => {
    // A required field is satisfied either by what was typed now or, for a
    // secret, by what is already stored. That is what the "leave blank to keep
    // current" placeholder promises, and it is now true.
    const missing = fields.filter(f => {
      if (f.optional) return false;
      if (String(values[f.key] || '').trim()) return false;
      return !(f.secret && storedSecret(f.key));
    });
    if (missing.length) { toast.error(`${missing[0].label} is required`); return; }
    setSaving(true);
    try {
      // Verification needs the actual credential, which this dialog only holds
      // when the operator just typed it. On a settings-only update the secret
      // stays on the server, so there is nothing to verify from here and the
      // check is skipped rather than failed.
      const suppliedEverySecret = fields
        .filter(f => f.secret && !f.optional)
        .every(f => String(values[f.key] || '').trim());

      if (verifyFn && suppliedEverySecret) {
        const res = await verifyFn({ ...values, verify_only: true });
        const d = res?.data || {};
        if (!d.success) { toast.error(d.error || `Could not verify ${title}`); setSaving(false); return; }
      }

      // Send only what the operator actually entered. The server merges it over
      // the stored blob, so fields this dialog knows nothing about survive.
      const submitted = {};
      fields.forEach(f => {
        const v = String(values[f.key] || '').trim();
        if (v) submitted[f.key] = v;
      });

      const saved = await saveIntegrationConfig({ name, values: submitted });
      if (saved?.data?.success === false) {
        toast.error(saved.data.error || `Failed to connect ${title}`);
        setSaving(false);
        return;
      }
      toast.success(`${title} connected`);
      qc.invalidateQueries({ queryKey: ['integration-status'] });
      onOpenChange(false);
      if (syncFn) { setSyncing(true); try { await syncFn({}); qc.invalidateQueries({ queryKey: ['bank-txns'] }); } catch { /* non-blocking */ } setSyncing(false); }
    } catch (e) {
      toast.error(e?.response?.data?.error || `Failed to connect ${title}`);
    }
    setSaving(false);
  };

  const runSync = async () => {
    if (!syncFn) return;
    setSyncing(true);
    try {
      const res = await syncFn({});
      const d = res?.data || {};
      if (d.success) toast.success(`${title} synced${d.ingested != null ? ` (${d.ingested} new)` : ''}`);
      else toast.error(d.error || 'Sync failed');
      qc.invalidateQueries({ queryKey: ['bank-txns'] });
    } catch (e) { toast.error(e?.response?.data?.error || 'Sync failed'); }
    setSyncing(false);
  };

  const disconnect = async () => {
    if (!cfg?.id) return;
    setSaving(true);
    try {
      await api.entities.IntegrationConfig.delete(cfg.id);
      toast.success(`${title} disconnected`);
      qc.invalidateQueries({ queryKey: ['integration-status'] });
      onOpenChange(false);
    } catch { toast.error('Failed to disconnect'); }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{connected ? `Manage ${title}` : `Connect ${title}`}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="py-6 text-center text-muted-foreground text-[13px]">Loading...</div>
        ) : (
          <div className="space-y-3">
            {connected && (
              <div className="flex items-center gap-2 text-[12px]">
                <CheckCircle2 className="w-4 h-4 status-sold" /><span className="status-sold font-medium">Connected</span>
                {meta.last_synced_at && <span className="text-muted-foreground">· last synced {new Date(meta.last_synced_at).toLocaleString()}</span>}
              </div>
            )}
            {fields.map(f => (
              <div key={f.key}>
                <Label className="text-[12px]">{f.label}{f.optional ? ' (optional)' : ''}</Label>
                <Input
                  value={values[f.key] || ''}
                  onChange={e => setValues(p => ({ ...p, [f.key]: e.target.value }))}
                  type={f.secret ? 'password' : 'text'}
                  placeholder={f.secret && storedSecret(f.key) ? 'Stored. Leave blank to keep current' : f.placeholder}
                  className="mt-1 bg-background font-mono text-[12px]"
                />
                {f.help && <p className="text-[11px] text-muted-foreground mt-1.5">{f.help}</p>}
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {connected && (
            <>
              <Button variant="ghost" className="text-destructive gap-1.5 mr-auto" onClick={disconnect} disabled={saving}><Trash2 className="w-3.5 h-3.5" /> Disconnect</Button>
              {syncFn && <Button variant="outline" className="gap-1.5" onClick={runSync} disabled={syncing}><RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncLabel}</Button>}
            </>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {connected ? <><Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Update'}</> : <><Plug className="w-3.5 h-3.5" /> {saving ? 'Connecting...' : 'Connect'}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}