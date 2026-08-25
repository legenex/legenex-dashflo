import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectSeparator,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { KeyRound, Plus, Loader2 } from 'lucide-react';
import { listCredentialReferences } from '@/functions/listCredentialReferences';
import { saveIntegrationConfig } from '@/functions/saveIntegrationConfig';
import { usePermissions } from '@/lib/AuthContext';

const NEW_VALUE = '__new__';
const NONE_VALUE = '__none__';

// Credential reference picker for SubDelivery.credential_ref. Never shows or
// accepts a secret value directly in this control - it lists NAMES only
// (listCredentialReferences.js), and the real secret is only ever typed once,
// into the "New credential" dialog below, which sends it straight to
// saveIntegrationConfig (owner/admin only) and is never echoed back. Selecting
// an existing name just stores that opaque string on the SubDelivery; the
// server resolves it at send time (subDeliveryCredential.js).
export default function CredentialReferencePicker({ value, onChange }) {
  const qc = useQueryClient();
  const { role } = usePermissions();
  const canCreate = role === 'owner' || role === 'admin';
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['credential-references'],
    queryFn: () => listCredentialReferences(),
  });
  const credentials = data?.data?.credentials || [];

  function handleSelect(v) {
    if (v === NEW_VALUE) { setNewName(''); setNewSecret(''); setCreating(true); return; }
    onChange(v === NONE_VALUE ? '' : v);
  }

  async function createCredential() {
    const name = newName.trim();
    if (!name) { toast.error('Give the credential a name'); return; }
    if (!newSecret) { toast.error('Enter the value to send as Authorization'); return; }
    setSaving(true);
    try {
      await saveIntegrationConfig({ name, values: { token: newSecret } });
      await qc.invalidateQueries({ queryKey: ['credential-references'] });
      onChange(name);
      setCreating(false);
      toast.success(`Credential "${name}" saved`);
    } catch (e) {
      toast.error('Could not save credential: ' + (e?.message || 'error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Select value={value || NONE_VALUE} onValueChange={handleSelect} disabled={isLoading}>
        <SelectTrigger className="h-9 bg-background">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {credentials.map((c) => (
            <SelectItem key={c.name} value={c.name}>
              <span className="inline-flex items-center gap-1.5"><KeyRound className="w-3 h-3" /> {c.name}</span>
            </SelectItem>
          ))}
          {value && !credentials.some((c) => c.name === value) && (
            <SelectItem value={value}>{value} (not found - was it renamed or removed?)</SelectItem>
          )}
          {canCreate && (
            <>
              <SelectSeparator />
              <SelectItem value={NEW_VALUE}><span className="inline-flex items-center gap-1.5 text-primary"><Plus className="w-3 h-3" /> New credential...</span></SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {!canCreate && (
        <p className="text-[10.5px] text-muted-foreground">
          Only Owner/Admin can add a new credential. Ask one to add it in Settings, or select an existing one above.
        </p>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="bg-popover border-border max-w-[420px]">
          <DialogHeader>
            <DialogTitle>New credential</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-[12px] font-medium">Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. walker_advertising_auth" className="h-9 bg-background font-mono text-[12px]" />
              <p className="text-[10.5px] text-muted-foreground">Referenced by this name only. This is what appears in the picker, not a secret.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-[12px] font-medium">Authorization header value</Label>
              <Input type="password" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder="e.g. Bearer ..." className="h-9 bg-background font-mono text-[12px]" />
              <p className="text-[10.5px] text-muted-foreground">Stored server-side only. It is never shown again after saving, in this dialog or anywhere else.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={createCredential} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
