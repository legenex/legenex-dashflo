import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

// Lightweight rename-only dialog. Renaming a Delivery never requires opening
// the full editor: it changes Delivery.name only, on the exact same record
// every other surface (Buyers, Webhooks, the full-page editor) reads, so a
// rename here is visible everywhere immediately.
export default function RenameDeliveryDialog({ open, onOpenChange, delivery, onRenamed }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(delivery?.name || '');
  }, [open, delivery]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Give the delivery a name'); return; }
    setSaving(true);
    try {
      await api.entities.Delivery.update(delivery.id, { name: trimmed });
      toast.success('Delivery renamed');
      onOpenChange(false);
      onRenamed?.(trimmed);
    } catch (e) {
      toast.error('Could not rename: ' + (e?.message || 'error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Rename delivery</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          <Label className="text-[12px] font-medium">Delivery name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            autoFocus
            className="h-9 bg-background"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
