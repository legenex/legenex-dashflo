import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Check, ChevronDown } from "lucide-react";

/**
 * Searchable combobox built on top of shadcn Popover + Command.
 * Props:
 *  - value: currently selected value
 *  - onValueChange: (value) => void
 *  - options: [{ value, label }]  (label defaults to value)
 *  - placeholder: string
 *  - className: applied to trigger
 *  - popoverClassName: applied to popover content
 *  - disabled: boolean
 *  - emptyText: text when no options match
 */
export const SearchableSelect = React.forwardRef(function SearchableSelect(
  { value, onValueChange, options = [], placeholder = "Select…", className, popoverClassName, disabled, emptyText = "No results found.", renderLabel },
  ref
) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const selected = options.find((o) => o.value === value);

  const display = selected
    ? (typeof renderLabel === "function" ? renderLabel(selected) : selected.label || selected.value)
    : placeholder;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50 text-left",
            className
          )}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>{display}</span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("p-0", popoverClassName)}
        align="start"
        style={{ width: "var(--radix-popover-trigger-width)", minWidth: "12rem" }}
      >
        <Command shouldFilter={true}>
          <CommandInput
            placeholder="Search…"
            value={search}
            onValueChange={setSearch}
            className="h-9"
          />
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => {
                const label = typeof renderLabel === "function" ? renderLabel(opt) : (opt.label || opt.value);
                return (
                  <CommandItem
                    key={opt.value}
                    value={opt.label || opt.value}
                    onSelect={() => { onValueChange(opt.value); setOpen(false); setSearch(""); }}
                    className="gap-2"
                  >
                    <Check className={cn("h-4 w-4", value === opt.value ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});

export default SearchableSelect;