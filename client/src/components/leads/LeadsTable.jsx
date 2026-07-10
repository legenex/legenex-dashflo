import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ErrorStatusPill from '@/components/leads/ErrorStatusPill';
import StatusPill from '@/components/shared/StatusPill';
import LeadDetailModal from '@/components/leads/LeadDetailModal';
import LeadsFilterBar from '@/components/leads/LeadsFilterBar';
import LeadsShell from '@/components/leads/LeadsShell';
import BulkActionBar from '@/components/leads/BulkActionBar';
import LeadCard from '@/components/leads/LeadCard';
import { Panel, Tag, riseIn } from '@/components/settings/settingsUi';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { format, startOfDay, endOfDay, startOfWeek, startOfMonth, endOfMonth, subDays, subMonths, isAfter } from 'date-fns';
import { processLead } from '@/functions/processLead';
import { loadColumnConfig, saveColumnConfig, getColumnDef, buildAvailableColumns } from '@/lib/columnConfig';

function getFieldValue(lead, field) {
  if (lead[field] != null && lead[field] !== '') return String(lead[field]);
  let mf = {};
  try { mf = JSON.parse(lead.mapped_fields || '{}'); } catch {}
  if (mf[field] != null && mf[field] !== '') return String(mf[field]);
  return '';
}

function matchesView(lead, view) {
  switch (view) {
    case 'all': return true;
    case 'sold': return lead.final_status === 'Sold';
    case 'unsold': return lead.final_status === 'Unsold';
    case 'disqualified':
      return lead.final_status === 'Disqualified' || lead.final_status === 'Error' || /disqual|dq/i.test(lead.leadbyte_record_status || '');
    case 'rejected':
      return lead.final_status === 'Duplicate' || /reject/i.test(lead.leadbyte_record_status || '');
    case 'queued': return lead.final_status === 'Queued';
    default: return true;
  }
}

function getDateBounds(range, customDate) {
  const now = new Date();
  switch (range) {
    case 'today': return { start: startOfDay(now) };
    case 'yesterday': { const y = subDays(now, 1); return { start: startOfDay(y), end: endOfDay(y) }; }
    case 'this_week': return { start: startOfWeek(now, { weekStartsOn: 1 }) };
    case 'this_month': return { start: startOfMonth(now) };
    case 'last_month': { const lm = subMonths(now, 1); return { start: startOfMonth(lm), end: endOfMonth(lm) }; }
    case 'this_year': return { start: new Date(now.getFullYear(), 0, 1) };
    case 'custom': return {
      start: customDate.start ? startOfDay(new Date(customDate.start)) : null,
      end: customDate.end ? endOfDay(new Date(customDate.end)) : null,
    };
    default: return {};
  }
}

function matchesFilter(lead, filter) {
  if (!filter.field) return true;
  const value = getFieldValue(lead, filter.field);
  const target = (filter.value || '').toLowerCase();
  switch (filter.operator) {
    case 'equals': return value.toLowerCase() === target;
    case 'not_equals': return value.toLowerCase() !== target;
    case 'contains': return value.toLowerCase().includes(target);
    case 'not_contains': return !value.toLowerCase().includes(target);
    case 'starts_with': return value.toLowerCase().startsWith(target);
    case 'ends_with': return value.toLowerCase().endsWith(target);
    case 'is_empty': return !value;
    case 'is_not_empty': return !!value;
    case 'gt': return parseFloat(value) > parseFloat(target);
    case 'lt': return parseFloat(value) < parseFloat(target);
    default: return true;
  }
}

function matchesSearch(lead, q) {
  const query = q.toLowerCase();
  return (lead.first_name || '').toLowerCase().includes(query)
    || (lead.last_name || '').toLowerCase().includes(query)
    || (lead.mobile || '').includes(query)
    || (lead.email || '').toLowerCase().includes(query)
    || (lead.supplier_name || '').toLowerCase().includes(query);
}

// Permanent filter dropdown options shown above every leads table.
const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'Sold', label: 'Sold' },
  { value: 'Disqualified', label: 'Disqualified' },
  { value: 'Unsold', label: 'Unsold' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Queued', label: 'Queued' },
  { value: 'Error', label: 'Error' },
  { value: 'Duplicate', label: 'Duplicate' },
];

function getSource(lead) {
  let mf = {};
  try { mf = JSON.parse(lead.mapped_fields || '{}'); } catch {}
  for (const key of ['utm_source', 'source', 'lead_source', 'source_id', 'src']) {
    const lk = key.toLowerCase();
    for (const [k, v] of Object.entries(mf)) {
      if (k.toLowerCase() === lk && v != null && v !== '') return String(v);
    }
  }
  return null;
}

// Colored tag per Lead Type value. Falls back to neutral for unknown values.
const LEAD_TYPE_COLORS = {
  survey: 'bg-status-qualified status-qualified',
  form: 'bg-status-duplicate status-duplicate',
  experiment: 'bg-status-queued status-queued',
  lander: 'bg-status-unsold status-unsold',
  call: 'bg-status-disqualified status-disqualified',
  data: 'bg-status-sold status-sold',
  email: 'bg-status-rejected status-rejected',
};

function LeadTypeTag({ value }) {
  if (!value || value === '-') return <span className="text-muted-foreground">-</span>;
  const cls = LEAD_TYPE_COLORS[String(value).toLowerCase()] || 'tag-neutral';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {value}
    </span>
  );
}

const VIEW_CONFIGS = {
  all: { title: 'All Leads', subtitle: 'All processed leads with full trace data' },
  sold: { title: 'Sold Leads', subtitle: 'Sold leads with revenue and buyer data' },
  unsold: { title: 'Unsold Leads', subtitle: 'Leads that were not sold' },
  disqualified: { title: 'Disqualified Leads', subtitle: 'Leads that were disqualified' },
  rejected: { title: 'Rejected Leads', subtitle: 'Leads that were rejected' },
  queued: { title: 'Queued Leads', subtitle: 'Leads queued for manual handling' },
};

const SYSTEM_FILTER_FIELDS = [
  { value: 'supplier_name', label: 'Supplier' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'email', label: 'Email' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'final_status', label: 'Final Status' },
  { value: 'hlr_status', label: 'HLR Status' },
  { value: 'leadbyte_record_status', label: 'LB Record Status' },
  { value: 'lead_id', label: 'Lead ID' },
  { value: 'revenue', label: 'Revenue' },
];

const FILTERS_STORAGE_KEY = 'legenex_saved_filters';

function loadSavedSets(view) {
  try {
    const all = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || '{}');
    return all[view] || [];
  } catch { return []; }
}

function persistSavedSets(view, sets) {
  try {
    const all = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || '{}');
    all[view] = sets;
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(all));
  } catch {}
}

export default function LeadsTable({ view }) {
  const qc = useQueryClient();
  const config = VIEW_CONFIGS[view] || VIEW_CONFIGS.all;

  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState('all');
  const [customDate, setCustomDate] = useState({ start: '', end: '' });
  const [customFilters, setCustomFilters] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  const [initialTab, setInitialTab] = useState('summary');
  const [savedSets, setSavedSets] = useState(() => loadSavedSets(view));
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitProgress, setResubmitProgress] = useState(null);
  const [columnConfig, setColumnConfig] = useState(() => loadColumnConfig(view));
  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    setSearch('');
    setDateRange('all');
    setCustomDate({ start: '', end: '' });
    setCustomFilters([]);
    setSavedSets(loadSavedSets(view));
    setSelectedIds(new Set());
    setColumnConfig(loadColumnConfig(view));
    setStatusFilter('');
    setSupplierFilter('');
    setSourceFilter('');
  }, [view]);

  // Persist column layout whenever it changes.
  useEffect(() => {
    saveColumnConfig(view, columnConfig);
  }, [view, columnConfig]);

  // Keep the table (and Status column) in sync when leads change in the backend.
  useEffect(() => {
    const unsubscribe = api.entities.Lead.subscribe(() => {
      qc.invalidateQueries({ queryKey: ['leads-all-non-archived'] });
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [qc]);

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads-all-non-archived'],
    queryFn: async () => {
      // Page through all matching leads. A single call is capped at 500, so
      // loop until a page returns fewer than 500 rows.
      const all = [];
      let p = 0;
      const size = 500;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await api.entities.Lead.filter({ archived: false }, '-created_date', size, p * size);
        all.push(...batch);
        if (batch.length < size) break;
        p += 1;
      }
      return all;
    },
  });

  const { data: errorLogs = [] } = useQuery({
    queryKey: ['error-logs-recent'],
    queryFn: () => api.entities.ErrorLog.list('-created_date', 200),
  });

  const { data: customFields = [] } = useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api.entities.CustomField.list(),
  });

  const errorLogByLeadId = useMemo(() => {
    const map = {};
    for (const e of errorLogs) {
      if (e.lead_id && !map[e.lead_id]) map[e.lead_id] = e;
    }
    return map;
  }, [errorLogs]);

  const filterFields = useMemo(() => {
    const customOpts = customFields.map(f => ({ value: f.field_name, label: f.label || f.field_name }));
    return [...SYSTEM_FILTER_FIELDS, ...customOpts];
  }, [customFields]);

  const availableColumns = useMemo(() => buildAvailableColumns(customFields), [customFields]);

  const supplierOptions = useMemo(() => {
    const set = new Set();
    leads.forEach(l => { if (l.supplier_name) set.add(l.supplier_name); });
    return [{ value: '', label: 'All Suppliers' }, ...Array.from(set).sort().map(s => ({ value: s, label: s }))];
  }, [leads]);

  const sourceOptions = useMemo(() => {
    const set = new Set();
    leads.forEach(l => { const s = getSource(l); if (s) set.add(s); });
    return [{ value: '', label: 'All Sources' }, ...Array.from(set).sort().map(s => ({ value: s, label: s }))];
  }, [leads]);

  const columns = columnConfig.columns;

  // ── Column resize (drag the header right edge) ───────────────────────
  const resizeRef = useRef(null);

  const handleResizeMove = useCallback((e) => {
    const r = resizeRef.current;
    if (!r) return;
    const newWidth = Math.max(70, r.startWidth + (e.clientX - r.startX));
    setColumnConfig((prev) => ({
      ...prev,
      columns: prev.columns.map((c) => (c.key === r.colKey ? { ...c, width: newWidth } : c)),
    }));
  }, []);

  const handleResizeEnd = useCallback(() => {
    resizeRef.current = null;
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', handleResizeEnd);
  }, [handleResizeMove]);

  const handleResizeStart = useCallback((e, colKey) => {
    e.stopPropagation();
    e.preventDefault();
    const th = e.currentTarget.parentElement;
    resizeRef.current = { colKey, startX: e.clientX, startWidth: th.offsetWidth };
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
  }, [handleResizeMove, handleResizeEnd]);

  const filtered = useMemo(() => {
    const bounds = getDateBounds(dateRange, customDate);
    return leads.filter(lead => {
      if (!matchesView(lead, view)) return false;
      if (bounds.start && !isAfter(new Date(lead.created_date), bounds.start)) return false;
      if (bounds.end && isAfter(new Date(lead.created_date), bounds.end)) return false;
      if (!customFilters.every(f => matchesFilter(lead, f))) return false;
      if (search && !matchesSearch(lead, search)) return false;
      if (statusFilter && lead.final_status !== statusFilter) return false;
      if (supplierFilter && lead.supplier_name !== supplierFilter) return false;
      if (sourceFilter && getSource(lead) !== sourceFilter) return false;
      return true;
    });
  }, [leads, view, dateRange, customDate, customFilters, search, statusFilter, supplierFilter, sourceFilter]);

  // Client-side pagination over the filtered set. Selection and bulk actions
  // still span the whole filtered set; only the rendered rows are sliced.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize]
  );
  // Reset to page 1 whenever the view, search, or any filter changes.
  useEffect(() => { setPage(1); }, [view, search, dateRange, customDate, customFilters, statusFilter, supplierFilter, sourceFilter, pageSize]);

  // Real telemetry for the shell footer, computed across all loaded leads.
  const telemetry = useMemo(() => ({
    total: leads.length,
    sold: leads.filter(l => l.final_status === 'Sold').length,
    queued: leads.filter(l => l.final_status === 'Queued').length,
    errors: leads.filter(l => l.final_status === 'Error').length,
    lastLeadAt: leads[0]?.created_date || null,
  }), [leads]);

  const exportCSV = () => {
    const cols = columns;
    const headers = cols.map(c => getColumnDef(c.key, customFields)?.header || c.key);
    const rows = filtered.map(l => cols.map(c => {
      const def = getColumnDef(c.key, customFields);
      return def ? def.accessor(l) : '';
    }));
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${view}-leads.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const openLeadDetail = (lead, stage) => {
    setInitialTab(stage === 'hlr' ? 'hlr' : stage === 'leadbyte' ? 'leadbyte' : 'summary');
    setSelectedLead(lead);
  };

  const applySavedSet = (set) => {
    setDateRange(set.dateRange || 'all');
    setCustomDate(set.customDate || { start: '', end: '' });
    setCustomFilters(set.customFilters || []);
    setSearch(set.search || '');
  };

  const saveCurrentAsSet = (name) => {
    const newSet = { id: Date.now().toString(), name, dateRange, customDate, customFilters, search };
    const updated = [...savedSets, newSet];
    setSavedSets(updated);
    persistSavedSets(view, updated);
  };

  const deleteSavedSet = (id) => {
    const updated = savedSets.filter(s => s.id !== id);
    setSavedSets(updated);
    persistSavedSets(view, updated);
  };

  const filteredIds = useMemo(() => new Set(filtered.map(l => l.id)), [filtered]);
  const allFilteredSelected = filtered.length > 0 && filtered.every(l => selectedIds.has(l.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const l of filtered) next.add(l.id);
        return next;
      });
    }
  };

  const toggleSelectRow = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectedLeads = useMemo(
    () => filtered.filter(l => selectedIds.has(l.id)),
    [filtered, selectedIds]
  );

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      await api.entities.Lead.delete(id);
    }
    toast.success(`${ids.length} lead${ids.length !== 1 ? 's' : ''} deleted`);
    clearSelection();
    setBulkDeleteOpen(false);
    qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const handleBulkQueue = async () => {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      await api.entities.Lead.update(id, { final_status: 'Queued' });
    }
    toast.success(`${ids.length} lead${ids.length !== 1 ? 's' : ''} queued`);
    clearSelection();
    qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const handleBulkResubmit = async () => {
    const leadsToResubmit = selectedLeads;
    setResubmitting(true);
    setResubmitProgress({ done: 0, total: leadsToResubmit.length });
    let success = 0;
    let failed = 0;
    for (let i = 0; i < leadsToResubmit.length; i++) {
      const lead = leadsToResubmit[i];
      try {
        const payload = JSON.parse(lead.raw_payload || '{}');
        const keys = await api.entities.ApiKey.filter({ id: lead.supplier_key_id });
        const key = keys[0]?.key;
        if (!key) { failed++; continue; }
        await processLead({ ...payload, _supplier_key: key });
        success++;
      } catch {
        failed++;
      }
      setResubmitProgress({ done: i + 1, total: leadsToResubmit.length });
    }
    toast.success(`${success} re-submitted${failed > 0 ? `, ${failed} failed` : ''}`);
    setResubmitting(false);
    setResubmitProgress(null);
    clearSelection();
    qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const handleBulkEdit = () => {
    if (selectedLeads.length !== 1) return;
    setInitialTab('summary');
    setSelectedLead(selectedLeads[0]);
  };

  return (
    <LeadsShell
      title={config.title}
      subtitle={config.subtitle}
      count={filtered.length}
      onRefresh={() => qc.invalidateQueries()}
      onExport={exportCSV}
      columnConfig={columnConfig}
      availableColumns={availableColumns}
      onColumnChange={setColumnConfig}
      telemetry={telemetry}
    >
      <div className="shrink-0">

      <LeadsFilterBar
        search={search}
        setSearch={setSearch}
        dateRange={dateRange}
        setDateRange={setDateRange}
        customDate={customDate}
        setCustomDate={setCustomDate}
        customFilters={customFilters}
        setCustomFilters={setCustomFilters}
        savedSets={savedSets}
        onSaveSet={saveCurrentAsSet}
        onDeleteSet={deleteSavedSet}
        onApplySet={applySavedSet}
        filterFields={filterFields}
        resultCount={filtered.length}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        statusOptions={STATUS_FILTER_OPTIONS}
        supplierFilter={supplierFilter}
        setSupplierFilter={setSupplierFilter}
        supplierOptions={supplierOptions}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        sourceOptions={sourceOptions}
      />

      <BulkActionBar
        selectedCount={selectedIds.size}
        onResubmit={handleBulkResubmit}
        onDelete={() => setBulkDeleteOpen(true)}
        onQueue={handleBulkQueue}
        onEdit={handleBulkEdit}
        onClear={clearSelection}
        resubmitting={resubmitting}
        progress={resubmitProgress}
      />
      </div>

      {/* Mobile card list: below lg only */}
      <div className="lg:hidden flex-1 min-h-0 overflow-y-auto space-y-2">
        {isLoading && (
          <div className="px-4 py-8 text-center text-muted-foreground">Loading...</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-muted-foreground">No leads found</div>
        )}
        {paged.map((lead) => (
          <LeadCard key={lead.id} lead={lead} onOpen={openLeadDetail} />
        ))}
      </div>

      <Panel className="hidden lg:block flex-1 min-h-0 overflow-auto" i={1}>
          <table className="min-w-full w-max text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted sticky top-0 z-10">
                <th className="px-4 py-3 w-[40px]">
                  <Checkbox
                    checked={allFilteredSelected}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </th>
                {columns.map((col) => {
                  const def = getColumnDef(col.key, customFields);
                  const widthStyle = col.width ? { width: `${col.width}px`, minWidth: `${col.width}px` } : undefined;
                  return (
                    <th
                      key={col.key}
                      className="text-left px-4 py-3 pr-6 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider relative whitespace-nowrap"
                      style={widthStyle}
                    >
                      {def?.header || col.key}
                      <span
                        onMouseDown={(e) => handleResizeStart(e, col.key)}
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/50 flex items-center justify-center"
                      >
                        <span className="block w-px h-4 bg-border" />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr><td colSpan={columns.length + 1} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-4 py-8 text-center text-muted-foreground">No leads found</td></tr>
              )}
              {paged.map((lead, idx) => (
                <motion.tr
                  key={lead.id}
                  variants={riseIn}
                  initial="hidden"
                  animate="show"
                  custom={Math.min(idx, 20)}
                  className="hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => openLeadDetail(lead)}
                >
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(lead.id)}
                      onCheckedChange={() => toggleSelectRow(lead.id)}
                      aria-label={`Select lead ${lead.id}`}
                    />
                  </td>
                  {columns.map((col) => {
                    const def = getColumnDef(col.key, customFields);
                    const widthStyle = col.width ? { width: `${col.width}px`, minWidth: `${col.width}px` } : undefined;
                    if (!def) return <td key={col.key} className="px-4 py-3" style={widthStyle}>-</td>;
                    if (col.key === 'vertical') {
                      const v = def.accessor(lead);
                      return (
                        <td key={col.key} className="px-4 py-3" style={widthStyle}>
                          {v && v !== '-' ? <Tag tone="good">{v}</Tag> : <span className="text-muted-foreground">-</span>}
                        </td>
                      );
                    }
                    if (col.key === 'finalStatus') {
                      return (
                        <td key={col.key} className="px-4 py-3" style={widthStyle}>
                          <ErrorStatusPill
                            lead={lead}
                            errorLogEntry={errorLogByLeadId[lead.id]}
                            onOpenDetail={openLeadDetail}
                          />
                        </td>
                      );
                    }
                    if (col.key === 'leadType') {
                      return (
                        <td key={col.key} className="px-4 py-3" style={widthStyle}>
                          <LeadTypeTag value={def.accessor(lead)} />
                        </td>
                      );
                    }
                    if (col.key === 'leadStatus') {
                      const ls = def.accessor(lead);
                      const value = ls && ls !== '-' ? String(ls) : '';
                      return (
                        <td key={col.key} className="px-4 py-3" style={widthStyle}>
                          {value && value !== 'Qualified' ? <StatusPill status={value} /> : <span className="text-muted-foreground">-</span>}
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} className={`px-4 py-3 ${def.className || ''}`} style={widthStyle}>
                        {def.accessor(lead)}
                      </td>
                    );
                  })}
                </motion.tr>
              ))}
            </tbody>
          </table>
      </Panel>

      {filtered.length > 0 && (
        <div className="shrink-0 flex items-center justify-between gap-3 mt-3 flex-wrap">
          <div className="text-[12px] text-muted-foreground">
            Showing {(safePage - 1) * pageSize + 1} to {Math.min(safePage * pageSize, filtered.length)} of {filtered.length}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 rounded-md border border-border bg-card text-foreground text-[12px] px-2"
            >
              {[20, 50, 100, 200].map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="h-8 px-3 rounded-md border border-border bg-card text-foreground text-[12px] disabled:opacity-40 disabled:pointer-events-none hover:bg-accent transition-colors"
            >
              Prev
            </button>
            <span className="text-[12px] text-muted-foreground tabular-nums">Page {safePage} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="h-8 px-3 rounded-md border border-border bg-card text-foreground text-[12px] disabled:opacity-40 disabled:pointer-events-none hover:bg-accent transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent className="bg-popover border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground">
              Delete {selectedIds.size} Lead{selectedIds.size !== 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LeadDetailModal
        lead={selectedLead}
        open={!!selectedLead}
        onClose={() => setSelectedLead(null)}
        initialTab={initialTab}
      />
    </LeadsShell>
  );
}