import React from 'react';
import { ApplyField } from '../ApplyField';

// Step 1: company identity.
export default function CompanyStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <ApplyField
        label="Company name"
        value={form.company_name}
        onChange={(v) => set('company_name', v)}
        error={errors.company_name}
        placeholder="Acme Legal Group"
        required
      />
      <ApplyField
        label="Company website"
        value={form.company_website}
        onChange={(v) => set('company_website', v)}
        error={errors.company_website}
        placeholder="https://acmelegal.com"
      />
      <ApplyField
        label="EIN or Tax ID"
        value={form.ein}
        onChange={(v) => set('ein', v)}
        error={errors.ein}
        placeholder="Optional"
      />
    </div>
  );
}