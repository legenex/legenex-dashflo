import React from 'react';
import { ApplyField } from '../ApplyField';

// Step 1: company identity and the primary point of contact.
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
      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="Primary contact name"
          value={form.primary_contact_name}
          onChange={(v) => set('primary_contact_name', v)}
          error={errors.primary_contact_name}
          placeholder="Jane Doe"
          required
        />
        <ApplyField
          label="Contact role"
          value={form.primary_contact_role}
          onChange={(v) => set('primary_contact_role', v)}
          error={errors.primary_contact_role}
          placeholder="Head of Acquisition"
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="Primary contact email"
          type="email"
          value={form.primary_contact_email}
          onChange={(v) => set('primary_contact_email', v)}
          error={errors.primary_contact_email}
          placeholder="jane@acmelegal.com"
          required
        />
        <ApplyField
          label="Primary contact phone"
          value={form.primary_contact_phone}
          onChange={(v) => set('primary_contact_phone', v)}
          error={errors.primary_contact_phone}
          placeholder="+1 512 555 0123"
          required
        />
      </div>
    </div>
  );
}