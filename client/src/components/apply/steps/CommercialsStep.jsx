import React from 'react';
import { ApplyField } from '../ApplyField';
import { CLIENT_TYPES, BILLING_TYPES } from '../applyConstants';

// Step 4: commercial terms. Client type drives the default billing arrangement:
// law firms pay upfront (prepay), aggregators are invoiced (invoiced_daily).
export default function CommercialsStep({ form, set, errors }) {
  const pickClientType = (ct) => {
    set('client_type', ct);
    // Apply the sensible default billing arrangement for the chosen client type.
    if (ct === 'Law Firm') set('billing_type', 'prepay');
    else if (ct === 'Aggregator') set('billing_type', 'invoiced_daily');
  };

  return (
    <div className="space-y-5">
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
                onClick={() => pickClientType(ct)}
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
          label="Lead count for the first deposit"
          type="number"
          value={form.initial_batch_size}
          onChange={(v) => set('initial_batch_size', v)}
          error={errors.initial_batch_size}
          placeholder="100"
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
        <div className="mt-2 text-[12px] text-muted-foreground">
          Law firms pay upfront and aggregators are invoiced.
        </div>
        {errors.billing_type && <div className="mt-1 text-[12px] text-primary">{errors.billing_type}</div>}
      </div>
    </div>
  );
}