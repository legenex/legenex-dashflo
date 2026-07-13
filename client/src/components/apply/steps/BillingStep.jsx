import React from 'react';
import { Download } from 'lucide-react';
import { ApplyField, ApplyTextarea, ApplySelect } from '../ApplyField';

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

// Step 7: billing details, the signed taxpayer form, qualification criteria,
// prior experience and the required agreement acknowledgement.
export default function BillingStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <ApplyField
        label="Billing address"
        value={form.billing_address}
        onChange={(v) => set('billing_address', v)}
        error={errors.billing_address}
        placeholder="123 Main St, Austin, TX 78701"
      />

      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="Accounts contact name"
          value={form.accounts_contact_name}
          onChange={(v) => set('accounts_contact_name', v)}
          error={errors.accounts_contact_name}
          placeholder="Optional"
        />
        <ApplyField
          label="Accounts email"
          type="email"
          value={form.accounts_email}
          onChange={(v) => set('accounts_email', v)}
          error={errors.accounts_email}
          placeholder="accounts@acmelegal.com"
        />
      </div>

      <div className="rounded-xl border border-border bg-background/50 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-foreground">Taxpayer identification form</div>
            <div className="text-[12px] text-muted-foreground">Download the form, sign it, then paste the link to your signed copy.</div>
          </div>
          <a
            href="https://www.irs.gov/pub/irs-pdf/fw9.pdf"
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 h-9 px-3 rounded-lg border border-border text-[12.5px] font-medium text-foreground hover:border-primary/40 transition-colors"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </div>
        {/* File uploads require an authenticated storage context not available
            on this public route, so we accept a link to the signed copy. */}
        <ApplyField
          label="Signed taxpayer form URL"
          value={form.taxpayer_form_url}
          onChange={(v) => set('taxpayer_form_url', v)}
          error={errors.taxpayer_form_url}
          placeholder="Link to your signed copy (optional)"
        />
      </div>

      <ApplyTextarea
        label="Qualification criteria"
        value={form.qualification_criteria}
        onChange={(v) => set('qualification_criteria', v)}
        placeholder="e.g. treatment within 14 days"
        rows={3}
      />

      <div className="grid sm:grid-cols-2 gap-5">
        <ApplySelect
          label="Prior lead generation experience"
          value={form.prior_experience}
          onChange={(v) => set('prior_experience', v)}
          options={YES_NO}
          placeholder="Select..."
        />
      </div>

      <ApplyTextarea
        label="Experience detail"
        value={form.experience_detail}
        onChange={(v) => set('experience_detail', v)}
        placeholder="Volume, verticals, what has worked and what has not."
        rows={3}
      />

      <ApplyTextarea
        label="Additional requirements"
        value={form.additional_requirements}
        onChange={(v) => set('additional_requirements', v)}
        placeholder="Suppression needs, delivery preferences, anything else."
        rows={3}
      />

      <button
        type="button"
        onClick={() => set('agreement_accepted', !form.agreement_accepted)}
        className={`flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
          errors.agreement_accepted ? 'border-primary' : 'border-border'
        } bg-background hover:border-primary/40`}
      >
        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          form.agreement_accepted ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
        }`}>
          {form.agreement_accepted && <span className="text-[10px] leading-none">&#10003;</span>}
        </span>
        <span className="text-[13px] text-foreground">
          I confirm the information above is accurate and I agree to the Legenex buyer terms.
        </span>
      </button>
      {errors.agreement_accepted && <div className="text-[12px] text-primary">{errors.agreement_accepted}</div>}
    </div>
  );
}