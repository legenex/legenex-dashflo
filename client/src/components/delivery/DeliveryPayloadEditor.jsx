import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { HighlightedPayloadEditor } from '@/components/settings/HighlightedPayloadEditor';
import TokenReferencePanel from '@/components/settings/TokenReferencePanel';
import { beautifyJson } from '@/lib/jsonBeautify';

// Payload section of the canonical delivery editor: bound to
// SubDelivery.payload_template (a free-text {{token}}/{{token|transform}}
// JSON body, resolved server-side by lib/payloadTemplate.js - the same
// resolver the legacy LeadByteConnector "Send Test Lead" path uses).
//
// Beautify parses the current text and replaces it with
// JSON.stringify(parsed, null, 2) - tokens are ordinary string content inside
// valid JSON, so they round-trip untouched. It never runs automatically and
// never touches the editor when the JSON is invalid; the operator sees why.
export default function DeliveryPayloadEditor({ value, onChange, customFields = [] }) {
  const [error, setError] = useState(null);

  const text = value || '';
  let validState = null;
  if (text.trim() !== '') {
    try { JSON.parse(text); validState = true; } catch { validState = false; }
  }

  function beautify() {
    const result = beautifyJson(text);
    if (!result.ok) {
      setError(result.error);
      toast.error(result.error.line != null
        ? `Invalid JSON at line ${result.error.line}, column ${result.error.column}`
        : (result.error.message || 'Invalid JSON'));
      return;
    }
    setError(null);
    onChange(result.text);
    toast.success('Payload formatted');
  }

  function handleChange(next) {
    setError(null);
    onChange(next);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[12px] font-medium">Payload template (JSON)</Label>
          <div className="flex items-center gap-2">
            {validState === true && (
              <Badge variant="outline" className="gap-1 text-[10.5px]"><CheckCircle2 className="w-3 h-3" /> Valid JSON</Badge>
            )}
            {validState === false && (
              <Badge variant="destructive" className="gap-1 text-[10.5px]"><AlertCircle className="w-3 h-3" /> Invalid JSON</Badge>
            )}
            <Button size="sm" variant="outline" onClick={beautify} className="h-7 gap-1.5 text-[11px]">
              <Sparkles className="w-3.5 h-3.5" /> Beautify
            </Button>
          </div>
        </div>
        <HighlightedPayloadEditor value={text} onChange={handleChange} minHeight={280} />
        {error && (
          <p className="text-[11px] text-destructive">
            {error.line != null ? `Line ${error.line}, column ${error.column}: ` : ''}{error.message}
          </p>
        )}
        <p className="text-[10.5px] text-muted-foreground">
          Leave blank to send the mapped lead payload as is (field_map). A delivery with invalid JSON here cannot be
          enabled for native live delivery, though it can still be saved as Draft.
        </p>
      </div>
      <TokenReferencePanel customFields={customFields} />
    </div>
  );
}
