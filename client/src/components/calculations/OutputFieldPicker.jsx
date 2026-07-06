import React, { useState } from 'react';
import { api } from '@/api/client';
import { useQueryClient } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * OutputFieldPicker
 *  - value: selected field_name (token)
 *  - onValueChange(field) => passes the FULL field object {field_name, label} so caller can sync label
 *  - fields: current custom fields list
 *  - placeholder, className
 *
 * Includes an inline "Create new field" action that creates a Calculated field and selects it
 * without leaving the parent modal.
 */
export function OutputFieldPicker({ value, onValueChange, fields = [], placeholder = 'Select field…', className }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldLabel, setNewFieldLabel] = useState('');

  const selected = fields.find(f => f.field_name === value);

  const display = selected ? (selected.label || selected.field_name) : (value || placeholder);

  const resetCreate = () => { setNewFieldName(''); setNewFieldLabel(''); setCreating(false); };

  const close = () => { setOpen(false); setSearch(''); resetCreate(); };

  const handleCreate = async () => {
    const name = newFieldName.trim().replace(/\s/g, '_');
    if (!name) { toast.error('Field name required'); setCreating(false); return; }
    const existing = fields.find(f => f.field_name === name);
    if (existing) {
      onValueChange({ field_name: existing.field_name, label: existing.label || existing.field_name });
      toast.success('Field already exists - selected');
      close();
      return;
    }
    try {
      setCreating(true);
      const label = newFieldLabel.trim() || name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const created = await api.entities.CustomField.create({
        field_name: name,
        label,
        field_type: 'Calculated',
        source: 'inbound',
        include_in_leadbyte: true,
        leadbyte_field_name: name,
        auto_created: true,
        sort_order: fields.length,
      });
      qc.invalidateQueries({ queryKey: ['custom-fields'] });
      onValueChange({ field_name: created.field_name, label: created.label });
      toast.success('Calculated field created');
      close();
    } catch (e) {
      toast.error('Failed to create field: ' + (e?.message || 'Unknown error'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetCreate(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
            'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring text-left',
            className
          )}
        >
          <span className={cn('truncate', !selected && !value && 'text-muted-foreground')}>{display}</span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 opacity-50 transition-transform', open && 'rotate-180')} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '16rem' }}
        onOpenAutoFocus={(e) => { /* keep focus on input via Command */ }}
      >
        <Command shouldFilter={true}>
          <CommandInput placeholder="Search fields…" value={search} onValueChange={setSearch} className="h-9" />
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>No fields found.</CommandEmpty>
            <CommandGroup>
              {fields.map((f) => (
                <CommandItem
                  key={f.id || f.field_name}
                  value={f.label || f.field_name}
                  onSelect={() => { onValueChange({ field_name: f.field_name, label: f.label || f.field_name }); close(); }}
                  className="gap-2"
                >
                  <Check className={cn('h-4 w-4', value === f.field_name ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{f.label || f.field_name}</span>
                  {f.field_type === 'Calculated' && (
                    <span className="ml-auto text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">calc</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => { setCreating(true); }}
                className="gap-2 text-primary"
                value={`__create_${search}`}
              >
                <Plus className="h-4 w-4" />
                <span>Create new field{search ? ` "${search.replace(/\s/g, '_')}"` : ''}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>

        {creating && (
          <div className="border-t border-border p-3 space-y-2 bg-muted/30">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">New Calculated Field</div>
            <div>
              <Label className="text-[11px]">Field name (token)</Label>
              <Input
                autoFocus
                value={newFieldName}
                onChange={e => setNewFieldName(e.target.value.replace(/\s/g, '_'))}
                placeholder="calculated_field"
                className="mt-1 bg-background font-mono text-[12px] h-8"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
              />
            </div>
            <div>
              <Label className="text-[11px]">Label</Label>
              <Input
                value={newFieldLabel}
                onChange={e => setNewFieldLabel(e.target.value)}
                placeholder="Calculated Field Label"
                className="mt-1 bg-background h-8"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={resetCreate}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={creating} className="gap-1.5">
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Create & Select
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default OutputFieldPicker;