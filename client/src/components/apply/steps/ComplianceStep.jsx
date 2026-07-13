import React from 'react';
import { ApplyField, TextListField } from '../ApplyField';

// Step 6: TCPA compliance contact details. These let consumers identify and
// reach the buyer, and outbound numbers are recorded for compliance.
export default function ComplianceStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-background/50 px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
        These details let consumers identify and reach the buyer, and outbound numbers are recorded for compliance.
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="TCPA inbound phone"
          value={form.tcpa_inbound_phone}
          onChange={(v) => set('tcpa_inbound_phone', v)}
          error={errors.tcpa_inbound_phone}
          placeholder="+1 512 555 0123"
        />
        <ApplyField
          label="TCPA inbound email"
          type="email"
          value={form.tcpa_inbound_email}
          onChange={(v) => set('tcpa_inbound_email', v)}
          error={errors.tcpa_inbound_email}
          placeholder="contact@acmelegal.com"
        />
      </div>

      <TextListField
        label="TCPA outbound phone numbers"
        values={form.tcpa_outbound_phones}
        onChange={(v) => set('tcpa_outbound_phones', v)}
        placeholder="+1 512 555 0199"
      />

      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="TCPA outbound email"
          type="email"
          value={form.tcpa_outbound_email}
          onChange={(v) => set('tcpa_outbound_email', v)}
          error={errors.tcpa_outbound_email}
          placeholder="outbound@acmelegal.com"
        />
        <ApplyField
          label="TCPA reply to email"
          type="email"
          value={form.tcpa_reply_to_email}
          onChange={(v) => set('tcpa_reply_to_email', v)}
          error={errors.tcpa_reply_to_email}
          placeholder="replies@acmelegal.com"
        />
      </div>
    </div>
  );
}