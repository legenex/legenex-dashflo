import React, { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import ToolsShell from '@/components/tools/ToolsShell';
import ToolTile from '@/components/tools/ToolTile';
import { Button } from '@/components/ui/button';
import { Brain, Bell, Calculator, ShieldCheck, FlaskConical, Upload, FileText, Image, Archive, FileSpreadsheet } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  FILE_KIND,
  fileKind,
  filesFromClipboard,
  filesFromDrop,
  filterAcceptedFiles,
} from '@/lib/fileUpload';

export default function ToolsDashboard() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['tools-dashboard'],
    queryFn: async () => {
      const [leads, calcFields, rules, hlr, emailVal, tests] = await Promise.all([
        api.entities.Lead.list('-created_date', 500),
        api.entities.CustomField.filter({ field_type: 'Calculated' }),
        api.entities.NotificationRule.list('-created_date', 200),
        api.entities.HlrSettings.list('-created_date', 1),
        api.entities.EmailValidationSettings.list('-created_date', 1),
        api.entities.PayloadTest.list('-updated_date', 1),
      ]);
      const hasCampaignField = calcFields.some(f => f.field_name === 'campaign');
      return {
        leadCount: leads.length,
        calcTotal: calcFields.length,
        hasCampaignField,
        rulesEnabled: rules.filter(r => r.enabled).length,
        hlrEnabled: hlr[0]?.enabled ?? false,
        emailEnabled: emailVal[0]?.enabled ?? false,
        lastTest: tests[0]?.updated_date || tests[0]?.created_date || null,
      };
    },
  });

  const d = data || {};
  const verificationActive = (d.hlrEnabled ? 1 : 0) + (d.emailEnabled ? 1 : 0);
  const lastRun = d.lastTest ? formatDistanceToNowStrict(new Date(d.lastTest), { addSuffix: true }) : null;

  // Factual audit line built from real state.
  const buildAudit = () => {
    if (isLoading) return 'Reading current tooling state...';
    const gaps = [];
    if ((d.rulesEnabled ?? 0) === 0) gaps.push('no notification rules');
    if ((d.calcTotal ?? 0) === 0) gaps.push('no calculated fields');
    if (verificationActive === 0) gaps.push('phone and email verification are off');
    else if (verificationActive === 1) gaps.push('only one of two quality gates is active');

    if (gaps.length === 0) {
      return `The pipeline is live and guarded: ${d.rulesEnabled} alert rule(s), ${d.calcTotal} calculated field(s) and ${verificationActive} of 2 quality gates active. ${(d.leadCount ?? 0).toLocaleString()} leads have passed through.`;
    }
    const list = gaps.length === 1 ? gaps[0] : gaps.slice(0, -1).join(', ') + ' and ' + gaps[gaps.length - 1];
    return `The pipeline is live but partly unguarded: ${list}. ${(d.leadCount ?? 0).toLocaleString()} leads have passed through with limited quality gating.`;
  };

  const statusFor = {
    rules: (d.rulesEnabled ?? 0) > 0 ? 'ok' : 'warn',
    calc: (d.calcTotal ?? 0) > 0 ? 'ok' : 'warn',
    verify: verificationActive === 2 ? 'ok' : verificationActive === 1 ? 'warn' : 'error',
    payload: 'ok',
  };

  const [files, setFiles] = useState([]);
  const fileInputRef = useRef(null);

  // Handle file selection
  const handleFileChange = (event) => {
    const selectedFiles = Array.from(event.target.files);
    processFiles(selectedFiles);
  };

  // The real input is visually hidden, so the drop zone is what opens it. The
  // guard matters: calling click() on the input dispatches a click that bubbles
  // back to this same handler, which would reopen the picker without end.
  const openFilePicker = (event) => {
    if (event?.target === fileInputRef.current) return;
    fileInputRef.current?.click();
  };

  // Handle paste event
  const handlePaste = (event) => {
    const pastedFiles = filesFromClipboard(event.clipboardData);
    if (pastedFiles.length > 0) {
      processFiles(pastedFiles);
    }
  };

  // Process files - validate and add to list
  const processFiles = (selectedFiles) => {
    const { accepted } = filterAcceptedFiles(selectedFiles);
    setFiles(prev => [...prev, ...accepted]);
  };

  // Remove a file
  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Clear all files
  const clearFiles = () => {
    setFiles([]);
  };

  // Upload files to the server (simulated)
  const uploadFiles = async () => {
    if (files.length === 0) return;
    
    try {
      // Simulate file upload process
      console.log('Uploading files:', files);
      
      // In a real implementation, you would:
      // 1. Create a FormData object
      // 2. Append each file to it
      // 3. Send an API request to your backend
      
      alert(`About to upload ${files.length} file(s). In a real implementation this would send files to the server.`);
      clearFiles(); // Clear after simulated upload
    } catch (error) {
      console.error('File upload error:', error);
      alert('Error uploading files');
    }
  };

  return (
    <ToolsShell
      title="Tools"
      subtitle="Operational tooling: automation, quality gates and pipeline diagnostics."
    >
      {/* File Upload Section */}
      <div className="rounded-lg border border-border bg-card p-4 mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">File Upload & Paste</h2>
        <p className="text-sm text-muted-foreground mb-4">Upload or paste multiple files (images, .zip, .md, .txt, .csv)</p>
        
        {/* File Input and Paste Area */}
        <div 
          className="border-2 border-dashed border-border rounded-lg p-6 text-center mb-4 cursor-pointer hover:bg-muted/50 transition-colors"
          onPaste={handlePaste}
          onClick={openFilePicker}
          onDrop={(e) => {
            e.preventDefault();
            processFiles(filesFromDrop(e.dataTransfer));
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center justify-center gap-2">
            <Upload className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm font-medium">Drag & drop files here or click to browse</p>
            <p className="text-xs text-muted-foreground">Supports: images (.jpg, .png, .gif), .zip, .md, .txt, .csv</p>
            <Button variant="outline" size="sm" className="mt-2">
              Choose Files
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.gif,.zip,.md,.txt,.csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Selected Files List */}
        {files.length > 0 && (
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-sm font-medium text-foreground">Selected Files</h3>
              <Button variant="ghost" size="sm" onClick={clearFiles} className="text-xs">
                Clear All
              </Button>
            </div>
            
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {files.map((file, index) => {
                const kind = fileKind(file);
                const icon = kind === FILE_KIND.IMAGE ? (
                  <Image className="w-4 h-4" />
                ) : kind === FILE_KIND.ARCHIVE ? (
                  <Archive className="w-4 h-4" />
                ) : kind === FILE_KIND.SPREADSHEET ? (
                  <FileSpreadsheet className="w-4 h-4" />
                ) : (
                  <FileText className="w-4 h-4" />
                );
                
                return (
                  <div key={index} className="flex items-center justify-between gap-3 p-2 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-2 truncate">
                      {icon}
                      <span className="text-sm text-foreground truncate" title={file.name}>
                        {file.name}
                      </span>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => removeFile(index)}
                      className="text-xs"
                    >
                      Remove
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Upload Button */}
        {files.length > 0 && (
          <div className="flex justify-end">
            <Button onClick={uploadFiles} disabled={files.length === 0}>
              <Upload className="w-4 h-4 mr-2" />
              Upload Files
            </Button>
          </div>
        )}
      </div>

      {/* AI Tooling Audit banner */}
      <div className="rounded-[10px] border border-primary/25 bg-primary/5 p-5 mb-6">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Brain className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary/80">AI Tooling Audit</div>
            <p className="text-[13px] text-foreground mt-1 leading-relaxed">{buildAudit()}</p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Button size="sm" onClick={() => navigate('/payload-tester')} className="gap-1.5">
                <FlaskConical className="w-4 h-4" /> Run pipeline test
              </Button>
              <Button size="sm" variant="outline" onClick={() => navigate('/notifications')} className="gap-1.5">
                <Bell className="w-4 h-4" /> Add first rule
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Tool cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToolTile
          to="/notifications"
          icon={Bell}
          title="Notifications"
          description="Alert rules for failures, spikes and silence across the pipeline."
          status={statusFor.rules}
          stats={[
            { label: 'Active rules', value: isLoading ? '-' : (d.rulesEnabled ?? 0) },
            { label: 'Hint', value: (d.rulesEnabled ?? 0) > 0 ? 'Monitored' : 'Failures unnoticed' },
          ]}
        />
        <ToolTile
          to="/calculated-fields"
          icon={Calculator}
          title="Calculated Fields"
          description="Derived fields computed on ingest, used in routing and reports."
          status={statusFor.calc}
          stats={[
            { label: 'Fields', value: isLoading ? '-' : (d.calcTotal ?? 0) },
            { label: 'Hint', value: d.hasCampaignField ? 'Mapped' : 'campaign unmapped' },
          ]}
        />
        <ToolTile
          to="/verification"
          icon={ShieldCheck}
          title="Verification"
          description="Phone and email quality gates protecting buyer acceptance."
          status={statusFor.verify}
          stats={[
            { label: 'Active', value: isLoading ? '-' : `${verificationActive} of 2` },
            { label: 'Hint', value: d.hlrEnabled ? 'HLR live' : 'HLR not configured' },
          ]}
        />
        <ToolTile
          to="/payload-tester"
          icon={FlaskConical}
          title="Payload Tester"
          description="Fire a synthetic lead through the full pipeline and inspect every hop."
          status={statusFor.payload}
          stats={[
            { label: 'Last run', value: isLoading ? '-' : (lastRun || 'never') },
            { label: 'Hint', value: lastRun ? 'Ready' : 'Recommended first action' },
          ]}
        />
      </div>
    </ToolsShell>
  );
}