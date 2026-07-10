import React from 'react';
import { ApplyField } from '../ApplyField';
import StateMultiSelect from '../StateMultiSelect';
import { CLIENT_TYPES, BILLING_TYPES } from '../applyConstants';

// Step 2: coverage footprint plus the commercial terms — client type, CPL and
// billing arrangement.
export default function CommercialStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <StateMultiSelect
        selected={form.target_states}
        onChange={(v) => set('target_states', v)}
        error={errors.target_states}
      />

      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          Client type<span className="text-primary ml-0.5">*</span>
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {CLIENT_TYPES.map((ct) => {
            const on = form.client_type === ct;
            return (
              <button
                key={ct}
                type="button"
                onClick={() => set('client_type', ct)}
                className={`h-11 rounded-lg border text-[13px] font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
              >
                {ct}
              </button>
            );
          })}
        </div>
        {errors.client_type && <div className="mt-1 text-[12px] text-primary">{errors.client_type}</div>}
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <ApplyField
          label="Target CPL (USD)"
          type="number"
          value={form.cpl}
          onChange={(v) => set('cpl', v)}
          error={errors.cpl}
          placeholder="45"
          required
        />
        <ApplyField
          label="Primary vertical"
          value={form.vertical}
          onChange={(v) => set('vertical', v)}
          error={errors.vertical}
          placeholder="MVA, Mass Tort, etc."
        />
      </div>

      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          Billing arrangement<span className="text-primary ml-0.5">*</span>
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BILLING_TYPES.map((bt) => {
            const on = form.billing_type === bt.value;
            return (
              <button
                key={bt.value}
                type="button"
                onClick={() => set('billing_type', bt.value)}
                className={`h-11 rounded-lg border text-[12.5px] font-medium transition-colors px-2 ${
                  on
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
              >
                {bt.label}
              </button>
            );
          })}
        </div>
        {errors.billing_type && <div className="mt-1 text-[12px] text-primary">{errors.billing_type}</div>}
      </div>
    </div>
  );
}