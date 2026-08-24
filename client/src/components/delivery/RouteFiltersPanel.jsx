import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import RouteConditionsEditor from '@/components/delivery/RouteConditionsEditor';
import { US_STATES } from '@/components/operations/buyers/usStates';
import { parseFilters } from '@/lib/routeFilters';

// Flat filters editor bound to RouteMember.filters, the ONLY shape
// engine.js's evaluateMember actually reads: states, lead_types, zips,
// counties, verticals, brands, suppliers, sources, required_fields,
// accident_within_months. An empty/absent key means "no restriction" for
// that dimension (engine.js's passesListFilter).
//
// There is deliberately no "Routes" filter here: by the time a lead reaches
// the native routing engine at all, lead_route has already been narrowed to
// standard/gateway in processLead.js, so a per-member route filter has no
// native runtime meaning. The legacy LeadByteConnector's filter_routes exists
// for a different reason (it fires at the top of the pipeline, before that
// narrowing) and does not carry over.
//
// value: the RouteMember.filters JSON string. onChange(nextJsonString).
// conditionsValue/onConditionsChange: RouteMember.conditions, a separate field
// for qualification rules beyond simple attribute filters (see
// RouteConditionsEditor / lib/routeConditionGroups.js).
export default function RouteFiltersPanel({
  value, onChange, conditionsValue, onConditionsChange, fieldOptions = [],
}) {
  const filters = useMemo(() => parseFilters(value), [value]);

  const { data: brands = [] } = useQuery({ queryKey: ['op-brands'], queryFn: () => api.entities.Brand.list() });
  const { data: suppliers = [] } = useQuery({ queryKey: ['op-suppliers'], queryFn: () => api.entities.Supplier.list() });
  const { data: verticals = [] } = useQuery({ queryKey: ['op-verticals'], queryFn: () => api.entities.Vertical.list() });

  const brandOptions = brands.map((b) => b.brand_name).filter(Boolean);
  const supplierOptions = suppliers.map((s) => s.name).filter(Boolean);
  const verticalOptions = verticals.map((v) => v.code).filter(Boolean);

  const set = (key, list) => {
    const next = { ...filters, [key]: list };
    onChange(JSON.stringify(next));
  };

  const setText = (key, csv) => {
    const list = csv.split(',').map((s) => s.trim()).filter(Boolean);
    set(key, list);
  };

  const togglePill = (key, value) => {
    const arr = Array.isArray(filters[key]) ? filters[key] : [];
    set(key, arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  };

  const renderPills = (key, options) => {
    if (!options || options.length === 0) return <span className="text-[11px] text-muted-foreground">None configured</span>;
    const active = Array.isArray(filters[key]) ? filters[key] : [];
    return options.map((opt) => (
      <button
        key={opt}
        type="button"
        onClick={() => togglePill(key, opt)}
        className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${active.includes(opt) ? 'bg-primary/20 text-primary border-primary/40' : 'bg-background text-muted-foreground border-border hover:text-foreground'}`}
      >
        {opt}
      </button>
    ));
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-4">
        <div>
          <div className="text-[13px] font-semibold text-foreground">Filters</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Empty = match all. Pills within a group are OR (lead matches ANY selected pill). All non-empty groups must match.
          </p>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <FilterGroup label="States">{renderPills('states', US_STATES)}</FilterGroup>
          <FilterGroup label="Verticals">{renderPills('verticals', verticalOptions)}</FilterGroup>
          <FilterGroup label="Brands">{renderPills('brands', brandOptions)}</FilterGroup>
          <FilterGroup label="Suppliers">{renderPills('suppliers', supplierOptions)}</FilterGroup>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
          <TextListField
            label="Lead types" hint="Comma-separated. Empty = no restriction."
            value={(filters.lead_types || []).join(', ')}
            onChange={(v) => setText('lead_types', v)}
          />
          <TextListField
            label="Sources" hint="Comma-separated supplier source codes."
            value={(filters.sources || []).join(', ')}
            onChange={(v) => setText('sources', v)}
          />
          <TextListField
            label="Zips" hint="Comma-separated ZIP codes."
            value={(filters.zips || []).join(', ')}
            onChange={(v) => setText('zips', v)}
          />
          <TextListField
            label="Counties" hint="Comma-separated county names."
            value={(filters.counties || []).join(', ')}
            onChange={(v) => setText('counties', v)}
          />
          <TextListField
            label="Required fields" hint="Lead must have a non-empty value for each of these."
            value={(filters.required_fields || []).join(', ')}
            onChange={(v) => setText('required_fields', v)}
          />
          <div className="space-y-1">
            <Label className="text-[12px] font-medium">Accident within (months)</Label>
            <Input
              type="number" min="0"
              value={filters.accident_within_months ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                const next = { ...filters };
                if (v === '') delete next.accident_within_months; else next.accident_within_months = Number(v);
                onChange(JSON.stringify(next));
              }}
              placeholder="No restriction"
              className="h-9 bg-background font-mono tabular-nums"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-border">
          <Label className="text-[12px]">Qualification conditions</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Match against the enriched lead data. Combine conditions with AND or OR, and nest groups for more complex logic. Empty = no conditions.
          </p>
          <div className="mt-2">
            <RouteConditionsEditor
              value={conditionsValue || ''}
              onChange={onConditionsChange}
              fieldOptions={fieldOptions}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Re-exported for callers that imported the old co-located helper.
export { parseFilters };

function FilterGroup({ label, children }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[11px] font-medium text-muted-foreground mt-1.5 whitespace-nowrap">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function TextListField({ label, hint, value, onChange }) {
  return (
    <div className="space-y-1">
      <Label className="text-[12px] font-medium">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-9 bg-background font-mono text-[12px]" />
      {hint && <p className="text-[10.5px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
