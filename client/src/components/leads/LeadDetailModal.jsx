import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import StatusPill from '@/components/shared/StatusPill';
import JsonViewer from '@/components/shared/JsonViewer';
import CapiLogView from '@/components/leads/CapiLogView';
import DeliveryStatusList from '@/components/leads/DeliveryStatusList';
import LeadEditForm from '@/components/leads/LeadEditForm';
import { api } from '@/api/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, RotateCcw, Trash2, Archive, Pencil } from 'lucide-react';
import { format } from 'date-fns';
import { processLead } from '@/functions/processLead';

export default function LeadDetailModal({ lead, open, onClose, initialTab = 'summary' }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [resending, setResending] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [activeTab, setActiveTab] = useState(initialTab);

  // Sync active tab when a new lead or initial tab is requested
  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  if (!lead) return null;

  let lbResp = {};
  try { lbResp = JSON.parse(lead.leadbyte_response || '{}'); } catch {}

  const handleCopyPayload = () => {
    navigator.clipboard.writeText(lead.raw_payload || '{}');
    toast.success('Payload copied');
  };

  const handleCopyResponse = () => {
    navigator.clipboard.writeText(lead.leadbyte_response || '{}');
    toast.success('Response copied');
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const payload = JSON.parse(lead.raw_payload || '{}');
      // Find the API key for this lead
      const keys = await api.entities.ApiKey.filter({ id: lead.supplier_key_id });
      const key = keys[0]?.key;
      if (!key) { toast.error('Supplier key not found'); return; }
      const resp = await processLead({ ...payload, _supplier_key: key });
      toast.success(`Resend result: ${resp.data?.Response || 'Unknown'}`);
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      toast.error('Resend failed');
    } finally {
      setResending(false);
    }
  };

  const handleArchive = async () => {
    await api.entities.Lead.update(lead.id, { archived: true });
    toast.success('Lead archived');
    qc.invalidateQueries({ queryKey: ['leads'] });
    onClose();
  };

  const handleHardDelete = async () => {
    if (deleteConfirm !== 'DELETE') return;
    await api.entities.Lead.delete(lead.id);
    toast.success('Lead permanently deleted');
    qc.invalidateQueries({ queryKey: ['leads'] });
    onClose();
  };

  const startEdit = () => setEditing(true);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[700px] w-[calc(100vw-2rem)] bg-popover border-border max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle className="font-mono text-[14px] text-foreground">{lead.id}</DialogTitle>
            <StatusPill status={lead.final_status} size="lg" />
            <span className="ml-auto text-[13px]">
              <span className="text-muted-foreground">Revenue: </span>
              <span className="font-mono font-semibold status-sold">${Number(lead.revenue || 0).toFixed(2)}</span>
            </span>
          </div>
          <div className="text-[12px] text-muted-foreground mt-1">
            {lead.supplier_name} - {lead.created_date ? format(new Date(lead.created_date), 'PPpp') : ''}
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="bg-muted">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="raw">Raw Data</TabsTrigger>
            <TabsTrigger value="hlr">HLR Trace</TabsTrigger>
            <TabsTrigger value="leadbyte">LeadByte Trace</TabsTrigger>
            <TabsTrigger value="capi">CAPI Log</TabsTrigger>
            <TabsTrigger value="delivery">Delivery Log</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="space-y-4 mt-4">
            {editing ? (
              <LeadEditForm
                lead={lead}
                onSaved={() => { setEditing(false); onClose(); }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Name', `${lead.first_name || ''} ${lead.last_name || ''}`],
                  ['Mobile', lead.mobile],
                  ['Email', lead.email],
                  ['HLR Status', lead.hlr_status],
                  ['HLR Score', lead.hlr_summary_score],
                  ['LeadByte Status', lead.leadbyte_record_status],
                  ['LeadByte Lead ID', lead.leadbyte_lead_id],
                  ['Queue ID', lead.leadbyte_queue_id],
                  ['Response Code', lbResp.code !== undefined ? lbResp.code : '-'],
                  ['Response Message', lbResp.message || '-'],
                  ['Response Errors', Array.isArray(lbResp.errors) && lbResp.errors.length ? lbResp.errors.join('; ') : (lbResp.errors || '-')],
                  ['Process Time', lead.process_time_ms ? `${lead.process_time_ms}ms` : '-'],
                  ['TrustedForm Valid', lead.trustedform_valid === true ? 'Yes' : lead.trustedform_valid === false ? 'No' : '-'],
                  ['Queue Reason', lead.queue_reason || '-'],
                  ['Buyer Feedback', lead.buyer_feedback || '-'],
                ].map(([label, val]) => (
                  <div key={label}>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
                    <div className="text-[13px] text-foreground font-medium mt-0.5 font-mono">{val || '-'}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-border">
              <DeliveryStatusList lead={lead} />
            </div>
          </TabsContent>

          <TabsContent value="raw" className="mt-4">
            <JsonViewer data={lead.raw_payload} title="Inbound Payload" />
          </TabsContent>

          <TabsContent value="hlr" className="mt-4 space-y-4">
            <JsonViewer data={lead.hlr_request} title="HLR Request" />
            <JsonViewer data={lead.hlr_response} title="HLR Response" />
            {lead.hlr_error && (
              <div className="bg-status-error rounded-lg p-3 text-[12px] status-error">{lead.hlr_error}</div>
            )}
          </TabsContent>

          <TabsContent value="leadbyte" className="mt-4 space-y-4">
            <JsonViewer data={lead.leadbyte_request} title="LeadByte Request" />
            <JsonViewer data={lead.leadbyte_response} title="LeadByte Response" />
          </TabsContent>

          <TabsContent value="capi" className="mt-4">
            <CapiLogView capiLog={lead.capi_log} />
          </TabsContent>

          <TabsContent value="delivery" className="mt-4">
            <JsonViewer data={lead.delivery_log} title="Delivery Log" />
          </TabsContent>
        </Tabs>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border flex-wrap">
          <Button variant="ghost" size="sm" onClick={startEdit} className="gap-1.5 text-primary">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={handleResend} disabled={resending} className="gap-1.5 text-primary">
            <RotateCcw className="w-3.5 h-3.5" /> {resending ? 'Resending...' : 'Resend'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopyPayload} className="gap-1.5">
            <Copy className="w-3.5 h-3.5" /> Copy Payload
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopyResponse} className="gap-1.5">
            <Copy className="w-3.5 h-3.5" /> Copy Response
          </Button>
          <Button variant="ghost" size="sm" onClick={handleArchive} className="gap-1.5">
            <Archive className="w-3.5 h-3.5" /> Archive
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-destructive ml-auto">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-popover border-border">
              <AlertDialogHeader>
                <AlertDialogTitle>Permanently delete this lead?</AlertDialogTitle>
                <AlertDialogDescription>Type DELETE to confirm. This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="Type DELETE" className="bg-background" />
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleHardDelete} disabled={deleteConfirm !== 'DELETE'} className="bg-destructive text-destructive-foreground">
                  Delete Forever
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </DialogContent>
    </Dialog>
  );
}