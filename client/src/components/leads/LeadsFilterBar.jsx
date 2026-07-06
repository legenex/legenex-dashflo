import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Panel } from '@/components/settings/settingsUi';
import { Search, Filter, Plus, X, Save, Trash2 } from 'lucide-react';

const DATE_RANGES = [
  { value: 'all', label: 'All Time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom' },
];

const OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Not Contains' },
  { value: 'starts_with', label: 'Starts With' },
  { value: 'ends_with', label: 'Ends With' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
  { value: 'gt', label: 'Greater Than' },
  { value: 'lt', label: 'Less Than' },
];

const NO_VALUE_OPERATORS = ['is_empty', 'is_not_empty'];

export default function LeadsFilterBar({
  search, setSearch,
  dateRange, setDateRange,
  customDate, setCustomDate,
  customFilters, setCustomFilters,
  savedSets, onSaveSet, onDeleteSet, onApplySet,
  filterFields,
  resultCount,
  statusFilter, setStatusFilter, statusOptions,
  supplierFilter, setSupplierFilter, supplierOptions,
  sourceFilter, setSourceFilter, sourceOptions,
}) {
  const [showFilters, setShowFilters] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [setName, setSetName] = useState('');
  const [activeSetId, setActiveSetId] = useState('');

  const addFilter = () => {
    setCustomFilters([...customFilters, { field: '', operator: 'equals', value: '' }]);
  };

  const updateFilter = (i, patch) => {
    setCustomFilters(customFilters.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  };

  const removeFilter = (i) => {
    setCustomFilters(customFilters.filter((_, idx) => idx !== i));
  };

  const clearAll = () => {
    setSearch('');
    setDateRange('all');
    setCustomDate({ start: '', end: '' });
    setCustomFilters([]);
    setActiveSetId('');
    if (setStatusFilter) setStatusFilter('');
    if (setSupplierFilter) setSupplierFilter('');
    if (setSourceFilter) setSourceFilter('');
  };

  const handleApplySet = (id) => {
    const set = savedSets.find(s => s.id === id);
    if (set) {
      onApplySet(set);
      setActiveSetId(id);
    } else {
      setActiveSetId('');
    }
  };

  const handleSave = () => {
    if (setName.trim()) {
      onSaveSet(setName.trim());
      setSetName('');
      setShowSaveDialog(false);
    }
  };

  const handleDeleteSet = (id) => {
    onDeleteSet(id);
    if (activeSetId === id) setActiveSetId('');
  };

  const hasActiveFilters = search || dateRange !== 'all' || customFilters.length > 0 || statusFilter || supplierFilter || sourceFilter;

  return (
    <div className="mb-4 space-y-3">
      <Panel className="p-3 flex items-center gap-3 flex-wrap" i={0}>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, mobile, email, supplier..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-card border-border"
          />
        </div>

        <SearchableSelect
          value={statusFilter || ''}
          onValueChange={setStatusFilter}
          className="w-[140px] bg-card border-border"
          options={statusOptions}
        />
        <SearchableSelect
          value={supplierFilter || ''}
          onValueChange={setSupplierFilter}
          className="w-[160px] bg-card border-border"
          options={supplierOptions}
        />
        <SearchableSelect
          value={sourceFilter || ''}
          onValueChange={setSourceFilter}
          className="w-[150px] bg-card border-border"
          options={sourceOptions}
        />

        <SearchableSelect
          value={dateRange}
          onValueChange={setDateRange}
          className="w-[140px] bg-card border-border"
          options={DATE_RANGES}
        />

        {dateRange === 'custom' && (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={customDate.start}
              onChange={e => setCustomDate(p => ({ ...p, start: e.target.value }))}
              className="bg-card border-border w-[140px]"
            />
            <span className="text-muted-foreground text-xs">→</span>
            <Input
              type="date"
              value={customDate.end}
              onChange={e => setCustomDate(p => ({ ...p, end: e.target.value }))}
              className="bg-card border-border w-[140px]"
            />
          </div>
        )}

        {savedSets.length > 0 && (
          <div className="flex items-center gap-1">
            <SearchableSelect
              value={activeSetId}
              onValueChange={handleApplySet}
              className="w-[160px] bg-card border-border"
              options={[{ value: '', label: 'Saved Filters' }, ...savedSets.map(s => ({ value: s.id, label: s.name }))]}
            />
            {activeSetId && (
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleDeleteSet(activeSetId)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}

        <Button
          variant={showFilters || customFilters.length > 0 ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className="gap-1.5"
        >
          <Filter className="w-3.5 h-3.5" /> Filters
          {customFilters.length > 0 && <Badge variant="secondary" className="ml-1">{customFilters.length}</Badge>}
        </Button>

        <Button variant="outline" size="sm" onClick={() => setShowSaveDialog(true)} className="gap-1.5">
          <Save className="w-3.5 h-3.5" /> Save
        </Button>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearAll} className="gap-1 text-muted-foreground">
            <X className="w-3.5 h-3.5" /> Clear
          </Button>
        )}

        <div className="text-[12px] text-muted-foreground ml-auto">{resultCount} leads</div>
      </Panel>

      {showFilters && (
        <div className="bg-card border border-border rounded-[10px] p-4 space-y-2">
          {customFilters.length === 0 && (
            <div className="text-[13px] text-muted-foreground py-2">No custom filters. Click "Add Filter" to create one.</div>
          )}
          {customFilters.map((filter, i) => (
            <div key={i} className="flex items-center gap-2">
              <SearchableSelect
                value={filter.field}
                onValueChange={v => updateFilter(i, { field: v })}
                className="w-[160px] bg-background"
                options={filterFields}
                placeholder="Field"
              />
              <SearchableSelect
                value={filter.operator}
                onValueChange={v => updateFilter(i, { operator: v })}
                className="w-[130px] bg-background"
                options={OPERATORS}
              />
              {!NO_VALUE_OPERATORS.includes(filter.operator) && (
                <Input
                  value={filter.value}
                  onChange={e => updateFilter(i, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1 bg-background"
                />
              )}
              <Button size="icon" variant="ghost" className="text-destructive shrink-0" onClick={() => removeFilter(i)}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addFilter} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Filter
          </Button>
        </div>
      )}

      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="max-w-[400px] bg-popover border-border">
          <DialogHeader>
            <DialogTitle>Save Filter Set</DialogTitle>
          </DialogHeader>
          <Input
            value={setName}
            onChange={e => setSetName(e.target.value)}
            placeholder="Enter a name for this filter set..."
            className="bg-background"
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSaveDialog(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!setName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}