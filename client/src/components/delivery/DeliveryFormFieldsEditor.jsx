import React from 'react';
import KeyValueRowsEditor from '@/components/delivery/KeyValueRowsEditor';
import TokenReferencePanel from '@/components/settings/TokenReferencePanel';

// Form-format payload editor: SAME storage field as the JSON payload editor
// (SubDelivery.payload_template - a flat JSON object of field -> value, where
// value may contain {{token}}/{{token|transform}} placeholders), presented as
// Field/Value rows instead of raw JSON text. directPost.js already resolves
// payload_template through buildPayloadFromTemplate and then, for
// encoding:'form', form-urlencodes the resulting object - there is no second
// storage shape to keep in sync, only a different editor for the SAME shape.
// Switching Format between json/form therefore never loses data: the
// underlying payload_template string is untouched, only its presentation
// changes.
export default function DeliveryFormFieldsEditor({ value, onChange, customFields = [] }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
      <div className="space-y-2">
        <KeyValueRowsEditor
          value={value}
          onChange={onChange}
          keyPlaceholder="Field"
          valuePlaceholder="Value"
          addLabel="+ Add field"
          emptyHint="No form fields yet. Add one below, or insert a token from the panel on the right into a value."
        />
        <p className="text-[10.5px] text-muted-foreground">
          Sent as application/x-www-form-urlencoded. Leave empty to send the mapped lead payload as is (field_map).
        </p>
      </div>
      <TokenReferencePanel customFields={customFields} />
    </div>
  );
}
