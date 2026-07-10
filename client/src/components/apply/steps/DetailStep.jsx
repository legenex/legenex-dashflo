import React from 'react';
import { ApplyField, ApplyTextarea } from '../ApplyField';

// Step 3: optional free text detail and secondary/accounts contacts. Nothing
// here is required — it enriches the submission for the operator to review.
export default function DetailStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="Billing email"
          type="email"
          value={form.billing_email}
          onChange={(v) => set('billing_email', v)}
          error={errors.billing_email}
          placeholder="accounts@acmelegal.com"
        />
        <ApplyField
          label="Accounts contact name"
          value={form.accounts_contact_name}
          onChange={(v) => set('accounts_contact_name', v)}
          error={errors.accounts_contact_name}
          placeholder="Optional"
        />
      </div>

      <ApplyField
        label="Prior lead generation experience"
        value={form.prior_experience}
        onChange={(v) => set('prior_experience', v)}
        placeholder="e.g. Currently buying MVA leads from 2 vendors"
      />

      <ApplyTextarea
        label="Describe that experience"
        value={form.experience_detail}
        onChange={(v) => set('experience_detail', v)}
        placeholder="Volume, verticals, what has worked and what hasn't."
        rows={4}
      />

      <ApplyTextarea
        label="Additional requirements"
        value={form.additional_requirements}
        onChange={(v) => set('additional_requirements', v)}
        placeholder="Qualification criteria, delivery method, suppression needs, anything else."
        rows={4}
      />
    </div>
  );
}