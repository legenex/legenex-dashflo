import React from 'react';
import { ApplyField } from '../ApplyField';
import StateMultiSelect from '../StateMultiSelect';

// Step 3: primary vertical and the geographic coverage footprint.
export default function CoverageStep({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <ApplyField
        label="Primary vertical"
        value={form.vertical}
        onChange={(v) => set('vertical', v)}
        error={errors.vertical}
        placeholder="MVA, Mass Tort, etc."
      />
      <StateMultiSelect
        selected={form.target_states}
        onChange={(v) => set('target_states', v)}
        error={errors.target_states}
      />
    </div>
  );
}