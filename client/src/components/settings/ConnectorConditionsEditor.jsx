import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Plus, Trash2 } from 'lucide-react';

const OPERATOR_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is blank' },
  { value: 'is_not_empty', label: 'is not blank' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
];

const VALUE_LESS_OPS = ['is_empty', 'is_not_empty'];

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

export default function ConnectorConditionsEditor({ value, onChange, fieldOptions = [], fieldValueOptions = {} }) {
  const conditions = parseJsonArray(value);

  const update = (i, field, val) => {
    const next = conditions.map((c, idx) => idx === i ? { ...c, [field]: val } : c);
    onChange(JSON.stringify(next));
  };
  const add = () => onChange(JSON.stringify([...conditions, { field: '', operator: 'equals', value: '' }]));
  const remove = (i) => onChange(JSON.stringify(conditions.filter((_, idx) => idx !== i)));

  const fieldSelectOptions = (() => {
    const opts = fieldOptions.map(f => ({ value: f, label: f }));
    // Ensure any stored field that isn't in the option list still displays.
    for (const c of conditions) {
      if (c.field && !opts.some(o => o.value === c.field)) opts.push({ value: c.field, label: c.field });
    }
    return opts;
  })();

  // For a given field, return the dropdown options for its value (calculated-field buckets etc.)
  const valueOptionsFor = (field) => {
    const opts = fieldValueOptions[field];
    if (!opts || opts.length === 0) return null;
    return opts;
  };

  return (
    <div className="space-y-2">
      {conditions.map((cond, i) => {
        const valueOpts = valueOptionsFor(cond.field);
        const valueDisabled = VALUE_LESS_OPS.includes(cond.operator);
        // Preserve an existing value even if it isn't in the predefined options list.
        const effectiveValueOptions = valueOpts && cond.value && !valueOpts.some(o => o.value === cond.value)
          ? [{ value: cond.value, label: cond.value }, ...valueOpts]
          : valueOpts;

        return (
          <div key={i} className="grid grid-cols-[1fr_130px_1fr_36px] gap-2 items-center">
            <SearchableSelect
              value={cond.field || ''}
              onValueChange={v => update(i, 'field', v)}
              options={fieldSelectOptions}
              placeholder="field e.g. accident_date_2"
              className="font-mono text-[12px] h-9"
            />
            <SearchableSelect
              value={cond.operator || 'equals'}
              onValueChange={v => update(i, 'operator', v)}
              options={OPERATOR_OPTIONS}
              className="text-[12px] h-9"
            />
            {effectiveValueOptions ? (
              <SearchableSelect
                value={cond.value || ''}
                onValueChange={v => update(i, 'value', v)}
                options={effectiveValueOptions}
                placeholder="value…"
                disabled={valueDisabled}
                className="font-mono text-[12px] h-9"
              />
            ) : (
              <Input
                value={cond.value || ''}
                onChange={e => update(i, 'value', e.target.value)}
                placeholder="value e.g. 2_years"
                className="bg-background font-mono text-[12px] h-9"
                disabled={valueDisabled}
              />
            )}
            <Button variant="ghost" size="sm" onClick={() => remove(i)} className="h-9 w-9 p-0 text-destructive">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={add} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" /> Add Condition
      </Button>
    </div>
  );
}