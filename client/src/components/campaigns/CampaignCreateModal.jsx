import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ArrowRight, ArrowLeft, Zap, Send } from 'lucide-react';
import { toast } from 'sonner';

const BLANK = { send_mode: 'direct_post', name: '', vertical: '' };

export default function CampaignCreateModal({ open, onOpenChange }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(BLANK);

  const { data: verticals = [] } = useQuery({
    queryKey: ['verticals'],
    queryFn: () => api.entities.Vertical.list(),
    enabled: open,
  });

  const reset = () => { setStep(1); setForm(BLANK); };

  const handleClose = (v) => { if (!v) reset(); onOpenChange(v); };

  const create = async () => {
    await api.entities.Campaign.create({
      name: form.name,
      vertical: form.vertical,
      send_mode: form.send_mode,
      active: true,
    });
    qc.invalidateQueries({ queryKey: ['campaigns'] });
    toast.success('Campaign created');
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-popover border-border max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New Campaign <span className="text-muted-foreground text-[12px] font-normal ml-1">Step {step} of 2</span></DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">Get started by naming your campaign.</p>
            <div><Label className="text-[12px]">Campaign Name *</Label><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. MVA - Q3 Ping Post" className="mt-1 bg-background" autoFocus /></div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="text-[12px] mb-2 block">How do sources send leads?</Label>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { value: 'ping_post', label: 'Ping Post', icon: Zap, desc: 'Sources ping first, then post accepted leads.' },
                  { value: 'direct_post', label: 'Direct Post', icon: Send, desc: 'Sources post the full lead in one request.' },
                ].map(opt => {
                  const Icon = opt.icon;
                  const active = form.send_mode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(p => ({ ...p, send_mode: opt.value }))}
                      className={`text-left p-3 rounded-lg border transition-all ${active ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-accent/40'}`}
                    >
                      <Icon className={`w-4 h-4 mb-1.5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                      <div className={`text-[13px] font-medium ${active ? 'text-foreground' : 'text-foreground'}`}>{opt.label}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label className="text-[12px]">Vertical</Label>
              <SearchableSelect
                value={form.vertical}
                onValueChange={v => setForm(p => ({ ...p, vertical: v }))}
                className="mt-1 bg-background"
                placeholder="Select vertical…"
                options={verticals.map(v => ({ value: v.code, label: v.name }))}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)}>Cancel</Button>
              <Button onClick={() => setStep(2)} disabled={!form.name} className="gap-1.5">Next <ArrowRight className="w-4 h-4" /></Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep(1)} className="gap-1.5"><ArrowLeft className="w-4 h-4" /> Back</Button>
              <Button onClick={create}>Create Campaign</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}