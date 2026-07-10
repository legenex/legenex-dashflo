import React from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import SupplierStatusPill from './SupplierStatusPill';
import SupplierRowActions from './SupplierRowActions';
import SupplierSourcesCell from './SupplierSourcesCell';
import SupplierChannelsCell from './SupplierChannelsCell';
import { getSupplierColumnDef } from './supplierColumns';

// Renders the supplier list as a sortable table driven by the persisted column
// config. The Actions column is always appended and is not part of the config.
export default function SupplierTable({
  suppliers, sources, config, ctx, sortKey, sortDir, onSort,
  onTransition, onPause, onTerminate, onDelete, onRowClick, onFixChannel,
}) {
  const cols = config.columns
    .map((c) => getSupplierColumnDef(c.key))
    .filter(Boolean);

  const renderCell = (col, s) => {
    if (col.special === 'status') return <SupplierStatusPill status={s.status} />;
    if (col.special === 'sources') return <SupplierSourcesCell supplier={s} sources={sources} />;
    if (col.special === 'channels') return <SupplierChannelsCell supplier={s} onFix={onFixChannel} />;
    return col.accessor(s, ctx);
  };

  return (
    <div className="bg-card border border-border rounded-[10px] overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {cols.map((col) => {
              const isSorted = sortKey === col.key;
              return (
                <th key={col.key} className="text-left px-4 py-3">
                  <button
                    type="button"
                    onClick={() => col.sortable && onSort(col.key)}
                    className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider ${
                      col.sortable ? 'hover:text-foreground cursor-pointer' : 'cursor-default'
                    } ${isSorted ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    {col.header}
                    {isSorted && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                  </button>
                </th>
              );
            })}
            <th className="text-right px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {suppliers.map((s) => (
            <tr
              key={s.id}
              onClick={() => onRowClick && onRowClick(s)}
              className="hover:bg-accent/40 transition-colors cursor-pointer"
            >
              {cols.map((col) => (
                <td key={col.key} className={`px-4 py-3 ${col.className || ''}`}>
                  {renderCell(col, s)}
                </td>
              ))}
              <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                <SupplierRowActions
                  supplier={s}
                  onTransition={onTransition}
                  onPause={onPause}
                  onTerminate={onTerminate}
                  onDelete={onDelete}
                />
              </td>
            </tr>
          ))}
          {suppliers.length === 0 && (
            <tr>
              <td colSpan={cols.length + 1} className="px-4 py-8 text-center text-muted-foreground">
                No suppliers match this filter
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}