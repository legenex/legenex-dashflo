import React, { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Plus, X } from 'lucide-react';
import { parseKeyValueRows, serializeKeyValueRows } from '@/lib/keyValueRows';

// Generic key/value rows editor over a JSON-object-shaped string field.
// Used for SubDelivery.headers and SubDelivery.query_params so an operator
// never has to hand-write {"X-Env":"prod"} into a textarea. Rows are kept as
// local component state (not re-derived from `value` on every keystroke) so
// typing in one row never fights the parent's re-render; the parent is told
// about every change immediately via onChange, serialized back to the exact
// same JSON-string shape the runtime already expects (an object of
// key -> value, or key -> "{{token}}" template string for query_params).
// Parsing/serialization itself lives in lib/keyValueRows.js so the contract
// is testable without a DOM.
let nextId = 0;

export default function KeyValueRowsEditor({
  value, onChange, keyPlaceholder = 'Name', valuePlaceholder = 'Value', addLabel = 'Add row', emptyHint,
}) {
  const [rows, setRows] = useState(() => parseKeyValueRows(value).map((r) => ({ ...r, _id: `kv-${nextId++}` })));
  const [invalid, setInvalid] = useState(false);

  // Re-sync from an external value change (e.g. switching between records),
  // not from our own onChange echo - guarded by a stable initial mount value
  // per record via the key the parent should pass (delivery/sub id), same
  // pattern as the rest of this editor's form fields.
  useEffect(() => {
    if (value && value.trim() && parseKeyValueRows(value).length === 0) { setInvalid(true); return; }
    setInvalid(false);
    setRows(parseKeyValueRows(value).map((r) => ({ ...r, _id: `kv-${nextId++}` })));
  }, []);

  function commit(next) {
    setRows(next);
    onChange(serializeKeyValueRows(next));
  }

  function updateRow(id, patch) {
    commit(rows.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id) {
    commit(rows.filter((r) => r._id !== id));
  }
  function addRow() {
    commit([...rows, { _id: `kv-${nextId++}`, key: '', value: '' }]);
  }

  return (
    <div className="space-y-2">
      {invalid && (
        <p className="text-[11px] text-destructive">
          Stored value was not a flat JSON object - starting empty rather than showing something wrong. Saving will
          replace it.
        </p>
      )}
      {rows.length === 0 && emptyHint && (
        <p className="text-[10.5px] text-muted-foreground">{emptyHint}</p>
      )}
      {rows.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_28px] gap-2 px-0.5">
          <Label className="text-[10.5px] font-medium text-muted-foreground">{keyPlaceholder}</Label>
          <Label className="text-[10.5px] font-medium text-muted-foreground">{valuePlaceholder}</Label>
          <span />
        </div>
      )}
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row._id} className="grid grid-cols-[1fr_1fr_28px] gap-2 items-center">
            <Input
              value={row.key}
              onChange={(e) => updateRow(row._id, { key: e.target.value })}
              placeholder={keyPlaceholder}
              className="h-8 bg-background font-mono text-[12px]"
            />
            <Input
              value={row.value}
              onChange={(e) => updateRow(row._id, { value: e.target.value })}
              placeholder={valuePlaceholder}
              className="h-8 bg-background font-mono text-[12px]"
            />
            <Button
              type="button" size="icon" variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(row._id)}
              aria-label={`Remove ${row.key || 'row'}`}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" onClick={addRow}>
        <Plus className="w-3.5 h-3.5" /> {addLabel}
      </Button>
    </div>
  );
}
