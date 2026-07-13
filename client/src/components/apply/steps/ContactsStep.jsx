import React from 'react';
import { ApplyField, PhoneField, ApplyToggle } from '../ApplyField';

// Step 2: the primary point of contact plus an optional secondary contact.
export default function ContactsStep({ form, set, errors }) {
  const showSecondary = !!form.provide_secondary_contact;
  return (
    <div className="space-y-5">
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
        <PhoneField
          label="Primary contact phone"
          value={form.primary_contact_phone}
          onChange={(v) => set('primary_contact_phone', v)}
          error={errors.primary_contact_phone}
          required
        />
      </div>

      <ApplyToggle
        label="Provide secondary contact"
        checked={showSecondary}
        onChange={(v) => set('provide_secondary_contact', v)}
      />

      {showSecondary && (
        <div className="space-y-5 rounded-xl border border-border bg-background/50 p-4">
          <div className="grid sm:grid-cols-2 gap-5">
            <ApplyField
              label="Secondary contact name"
              value={form.secondary_contact_name}
              onChange={(v) => set('secondary_contact_name', v)}
              error={errors.secondary_contact_name}
              placeholder="John Smith"
            />
            <ApplyField
              label="Secondary contact role"
              value={form.secondary_contact_role}
              onChange={(v) => set('secondary_contact_role', v)}
              error={errors.secondary_contact_role}
              placeholder="Operations Manager"
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
            <ApplyField
              label="Secondary contact email"
              type="email"
              value={form.secondary_contact_email}
              onChange={(v) => set('secondary_contact_email', v)}
              error={errors.secondary_contact_email}
              placeholder="john@acmelegal.com"
            />
            <PhoneField
              label="Secondary contact phone"
              value={form.secondary_contact_phone}
              onChange={(v) => set('secondary_contact_phone', v)}
              error={errors.secondary_contact_phone}
            />
          </div>
        </div>
      )}
    </div>
  );
}