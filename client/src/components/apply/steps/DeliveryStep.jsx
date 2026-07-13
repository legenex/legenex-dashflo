import React from 'react';
import { ApplyField, ChipSingleSelect, ChipMultiSelect, EmailListField } from '../ApplyField';
import { DELIVERY_METHODS, DISPOSITION_METHODS } from '../applyConstants';

// Step 5: how leads reach the buyer and how they report dispositions back.
// The API and email blocks are revealed based on the chosen delivery method.
export default function DeliveryStep({ form, set, errors }) {
  const method = form.delivery_method;
  const showApi = method === 'api_post' || method === 'both';
  const showEmail = method === 'email' || method === 'both';

  return (
    <div className="space-y-5">
      <ChipSingleSelect
        label="Delivery method"
        options={DELIVERY_METHODS}
        value={method}
        onChange={(v) => set('delivery_method', v)}
        error={errors.delivery_method}
      />

      {showApi && (
        <div className="space-y-5 rounded-xl border border-border bg-background/50 p-4">
          <ApplyField
            label="API documentation URL"
            value={form.api_docs_url}
            onChange={(v) => set('api_docs_url', v)}
            error={errors.api_docs_url}
            placeholder="https://acmelegal.com/api-docs"
          />
          {/* File uploads require an authenticated storage context that is not
              available on this public, unauthenticated route. Rather than block
              submission we accept a plain URL to the hosted API documentation. */}
          <ApplyField
            label="API documentation file URL"
            value={form.api_docs_file_url}
            onChange={(v) => set('api_docs_file_url', v)}
            error={errors.api_docs_file_url}
            placeholder="Link to a hosted PDF or doc (optional)"
          />
          <div className="grid sm:grid-cols-2 gap-5">
            <ApplyField
              label="Buyer API key"
              value={form.buyer_api_key}
              onChange={(v) => set('buyer_api_key', v)}
              error={errors.buyer_api_key}
              placeholder="Key our system uses to post to your CRM"
            />
            <ApplyField
              label="Unique identifier"
              value={form.unique_identifier}
              onChange={(v) => set('unique_identifier', v)}
              error={errors.unique_identifier}
              placeholder="Campaign or source id"
            />
          </div>
        </div>
      )}

      {showEmail && (
        <div className="rounded-xl border border-border bg-background/50 p-4">
          <EmailListField
            label="Lead notification emails"
            values={form.lead_notification_emails}
            onChange={(v) => set('lead_notification_emails', v)}
          />
        </div>
      )}

      <ChipMultiSelect
        label="Disposition method"
        options={DISPOSITION_METHODS}
        values={form.disposition_method}
        onChange={(v) => set('disposition_method', v)}
      />
    </div>
  );
}