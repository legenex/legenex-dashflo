import { format } from 'date-fns';

// Read a value from a lead's mapped_fields JSON by trying a list of key
// aliases (case-insensitive). Returns the first non-empty match or null.
function getFromMapped(lead, keys) {
  let mf = {};
  try { mf = JSON.parse(lead.mapped_fields || '{}'); } catch {}
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(mf)) {
      if (k.toLowerCase() === lowerKey && v != null && v !== '') return v;
    }
  }
  return null;
}

// Built-in system columns. Order here is only the "available" order; the
// table's actual column order is driven by the persisted per-view config.
export const SYSTEM_COLUMNS = [
  { key: 'created', header: 'Timestamp', accessor: (l) => l.created_date ? format(new Date(l.created_date), 'MMM dd HH:mm') : '-', className: 'font-mono text-[11px] text-muted-foreground whitespace-nowrap' },
  { key: 'fullName', header: 'Full Name', accessor: (l) => `${l.first_name || ''} ${l.last_name || ''}`.trim() || '-' },
  { key: 'vertical', header: 'Vertical', accessor: (l) => getFromMapped(l, ['vertical']) || '-' },
  { key: 'leadType', header: 'Lead Type', accessor: (l) => getFromMapped(l, ['lead_type']) || '-', special: 'leadType' },
  { key: 'finalStatus', header: 'Status', accessor: (l) => l.final_status || '-', special: 'status' },
  { key: 'leadStatus', header: 'Lead Status', accessor: (l) => getFromMapped(l, ['lead_status']) || '-', special: 'leadStatus' },
  { key: 'revenue', header: 'Revenue', accessor: (l) => `$${Number(l.revenue || 0).toFixed(2)}`, className: 'font-mono text-[12px] status-sold' },
  { key: 'state', header: 'State', accessor: (l) => getFromMapped(l, ['accident_state', 'state', 'st', 'region', 'state_code']) || '-' },
  { key: 'supplier', header: 'Supplier', accessor: (l) => l.supplier_name || '-' },
  { key: 'buyer', header: 'Buyer', accessor: (l) => getFromMapped(l, ['buyer', 'buyer_id', 'buyer_name']) || '' },
  { key: 'email', header: 'Email', accessor: (l) => l.email || '-' },
  { key: 'verification', header: 'Verification', accessor: (l) => {
    const pv = getFromMapped(l, ['phone_verified']);
    if (pv) return String(pv);
    if (l.hlr_status) return String(l.hlr_status);
    return 'None';
  }, className: 'font-mono text-[11px]' },
  { key: 'mobile', header: 'Mobile', accessor: (l) => l.mobile || '-', className: 'font-mono text-[12px]' },
  { key: 'source', header: 'Source', accessor: (l) => getFromMapped(l, ['utm_source', 'source', 'lead_source', 'source_id', 'src']) || '-' },
  { key: 'processTime', header: 'Time', accessor: (l) => l.process_time_ms ? `${l.process_time_ms}ms` : '-', className: 'font-mono text-[11px] text-muted-foreground' },
  { key: 'leadId', header: 'Lead ID', accessor: (l) => l.lead_id != null ? String(l.lead_id) : '-', className: 'font-mono text-[11px]' },
  { key: 'hlrStatus', header: 'HLR Status', accessor: (l) => l.hlr_status || '-' },
  { key: 'lbStatus', header: 'LB Status', accessor: (l) => l.leadbyte_record_status || '-' },
  { key: 'emailValid', header: 'Email Valid', accessor: (l) => l.email_valid || '-' },
];

// Default column order applied to every view until the user customises it.
export const DEFAULT_COLUMN_KEYS = [
  'created', 'fullName', 'vertical', 'leadType', 'finalStatus', 'revenue',
  'state', 'supplier', 'buyer', 'email', 'verification',
];

// Bumped to v2 so the new default order (Lead Type in, Lead Status/Source out)
// takes effect for users who already had a persisted layout.
const STORAGE_KEY = 'legenex_column_config_v2';

// Load the persisted column config for a view, falling back to the defaults.
export function loadColumnConfig(view) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (all[view] && Array.isArray(all[view].columns)) return all[view];
  } catch {}
  return { columns: DEFAULT_COLUMN_KEYS.map((k) => ({ key: k, width: null })) };
}

export function saveColumnConfig(view, config) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    all[view] = config;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {}
}

// Resolve a column def by key, including dynamic custom-field columns
// (prefixed `cf_<field_name>`).
export function getColumnDef(key, customFields) {
  const sys = SYSTEM_COLUMNS.find((c) => c.key === key);
  if (sys) return sys;
  if (key && key.startsWith('cf_')) {
    const fieldName = key.slice(3);
    const cf = (customFields || []).find((f) => f.field_name === fieldName);
    const header = cf ? (cf.label || cf.field_name) : fieldName;
    return {
      key, header,
      accessor: (l) => {
        let mf = {};
        try { mf = JSON.parse(l.mapped_fields || '{}'); } catch {}
        const v = mf[fieldName];
        return v != null && v !== '' ? String(v) : '-';
      },
      className: 'text-[12px]',
    };
  }
  return null;
}

// Full list of columns the user can add: system columns + one per custom field.
export function buildAvailableColumns(customFields) {
  const custom = (customFields || [])
    .map((f) => ({ key: `cf_${f.field_name}`, header: f.label || f.field_name, isCustom: true }));
  return [...SYSTEM_COLUMNS.map((c) => ({ key: c.key, header: c.header })), ...custom];
}