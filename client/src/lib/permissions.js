// Granular access-control catalog + base-role presets for Users & Roles.
// Every user stores a `permissions` JSON object: { [key]: true } of ticked sections.

export const PERMISSION_GROUPS = [
  {
    group: 'Dashboard',
    items: [
      { key: 'overview', label: 'Overview' },
    ],
  },
  {
    group: 'Leads',
    items: [
      { key: 'leads_all', label: 'All Leads' },
      { key: 'leads_sold', label: 'Sold' },
      { key: 'leads_unsold', label: 'Unsold' },
      { key: 'leads_disqualified', label: 'Disqualified' },
      { key: 'leads_rejected', label: 'Rejected' },
      { key: 'leads_queued', label: 'Queued' },
    ],
  },
  {
    group: 'Lead Distribution',
    items: [
      { key: 'dist_dashboard', label: 'Dashboard' },
      { key: 'dist_campaigns', label: 'Campaigns' },
      { key: 'dist_verticals', label: 'Verticals' },
      { key: 'dist_buyers', label: 'Buyers' },
      { key: 'dist_suppliers', label: 'Suppliers' },
      { key: 'dist_brands', label: 'Brands' },
      { key: 'dist_deliveries', label: 'Deliveries' },
      { key: 'dist_webhooks', label: 'Webhooks' },
      { key: 'dist_conversion_events', label: 'Conversion Events' },
      { key: 'dist_routes', label: 'Route Groups' },
      { key: 'dist_simulator', label: 'Simulator' },
    ],
  },
  {
    group: 'Analytics',
    items: [
      { key: 'reports', label: 'Reports' },
      { key: 'finances', label: 'Finances' },
      { key: 'bank_feed', label: 'Bank Feed' },
      { key: 'operations', label: 'Operations' },
      { key: 'ad_manager', label: 'Ad Manager' },
      { key: 'tools', label: 'Tools' },
    ],
  },
  {
    group: 'Settings',
    items: [
      { key: 'set_integrations', label: 'Integrations' },
      { key: 'set_data_sources', label: 'Data Sources' },
      { key: 'set_custom_fields', label: 'Custom Fields' },
      { key: 'set_field_mapping', label: 'Field Mapping' },
      { key: 'set_api_keys', label: 'API Keys' },
      { key: 'set_inbound_webhooks', label: 'Inbound Webhooks' },
      { key: 'set_error_logs', label: 'Error Logs' },
      { key: 'set_knowledge_base', label: 'Knowledge Base' },
      { key: 'set_users', label: 'Users and Roles' },
      { key: 'set_billing', label: 'Billing' },
    ],
  },
  {
    group: 'Portal',
    items: [
      { key: 'portal_access', label: 'Portal access' },
    ],
  },
];

export const ALL_KEYS = PERMISSION_GROUPS.flatMap(g => g.items.map(i => i.key));

// Keys that Supplier/Buyer roles must NEVER have (enforced hard).
const DIST_KEYS = PERMISSION_GROUPS.find(g => g.group === 'Lead Distribution').items.map(i => i.key);
const FINANCE_KEYS = ['finances', 'bank_feed'];
const OPERATIONS_KEYS = ['operations', 'ad_manager'];
export const RESTRICTED_FOR_PARTNERS = [...DIST_KEYS, ...FINANCE_KEYS, ...OPERATIONS_KEYS];

const all = () => Object.fromEntries(ALL_KEYS.map(k => [k, true]));
const only = (keys) => Object.fromEntries(keys.map(k => [k, true]));
const allExcept = (excluded) => Object.fromEntries(ALL_KEYS.filter(k => !excluded.includes(k)).map(k => [k, true]));

export const ROLE_PRESETS = {
  owner: { label: 'Owner', description: 'Everything. Can delete users, including the Owner.', canDeleteOwner: true, permissions: all() },
  admin: { label: 'Admin', description: 'Everything except deleting the Owner. Finances & Bank Feed off by default.', canDeleteOwner: false, permissions: allExcept(['finances', 'bank_feed']) },
  manager: { label: 'Manager', description: 'Most things except Finances & Bank Feed.', canDeleteOwner: false, permissions: allExcept(FINANCE_KEYS) },
  supplier: { label: 'Supplier', description: 'Own data only. No Lead Distribution, no Finances.', canDeleteOwner: false, permissions: only(['overview', 'leads_all', 'leads_sold', 'leads_unsold', 'reports', 'portal_access']) },
  buyer: { label: 'Buyer', description: 'Own data only. No Lead Distribution, no Finances.', canDeleteOwner: false, permissions: only(['overview', 'leads_all', 'leads_sold', 'reports', 'portal_access']) },
};

// Maps a route path to the permission key that gates it.
// Settings tabs are gated by their ?tab= value (see PATH_TAB_KEYS below).
export const PATH_KEYS = {
  '/': 'overview',
  '/leads': 'leads_all',
  '/leads/sold': 'leads_sold',
  '/leads/unsold': 'leads_unsold',
  '/leads/disqualified': 'leads_disqualified',
  '/leads/rejected': 'leads_rejected',
  '/leads/queued': 'leads_queued',
  '/distribution': 'dist_dashboard',
  '/campaigns': 'dist_campaigns',
  '/campaigns/deliveries': 'dist_deliveries',
  '/distribution/buyers': 'dist_buyers',
  '/deliveries': 'dist_webhooks',
  '/conversion-events': 'dist_conversion_events',
  '/distribution/routes': 'dist_routes',
  '/distribution/simulator': 'dist_simulator',
  '/reports': 'reports',
  '/finances': 'finances',
  '/operations/buyers': 'operations',
  '/operations/suppliers': 'operations',
  '/operations/active-states': 'operations',
  '/operations/billing-reports': 'operations',
  '/operations/buyer-onboarding': 'operations',
  '/ad-manager': 'ad_manager',
  '/ad-manager/reports': 'ad_manager',
  '/ad-manager/creative-analyzer': 'ad_manager',
  '/ad-manager/builder': 'ad_manager',
  '/tools': 'tools',
  '/notifications': 'tools',
  '/calculated-fields': 'tools',
  '/verification': 'tools',
  '/payload-tester': 'tools',
  '/queue-recovery': 'leads_queued',
  '/suppliers': 'dist_suppliers',
  '/buyers': 'dist_buyers',
};

// Settings ?tab= value -> permission key. Profile is always accessible (null key).
export const SETTINGS_TAB_KEYS = {
  profile: null,
  general: 'set_integrations',
  users: 'set_users',
  integrations: 'set_integrations',
  'data-sources': 'set_data_sources',
  fields: 'set_custom_fields',
  'field-mapping': 'set_field_mapping',
  apikeys: 'set_api_keys',
  'inbound-webhooks': 'set_inbound_webhooks',
  errors: 'set_error_logs',
  knowledge: 'set_knowledge_base',
  billing: 'set_billing',
};

// Resolve the permission key required for a given pathname + search string.
export function keyForLocation(pathname, search) {
  if (pathname === '/settings') {
    const tab = new URLSearchParams(search || '').get('tab') || 'general';
    if (tab === 'profile') return null; // Profile is always accessible.
    return SETTINGS_TAB_KEYS[tab] || 'set_integrations';
  }
  // Detail routes fall under their list permission.
  if (pathname.startsWith('/suppliers/')) return 'dist_suppliers';
  if (pathname.startsWith('/buyers/')) return 'dist_buyers';
  if (pathname.startsWith('/distribution/buyers/')) return 'dist_buyers';
  return PATH_KEYS[pathname] || null;
}

// First path a user with the given can(key) checker is allowed to land on.
export function firstAllowedPath(can) {
  const order = ['/', '/leads', '/leads/sold', '/leads/unsold', '/leads/disqualified',
    '/leads/rejected', '/leads/queued', '/reports', '/distribution', '/campaigns', '/deliveries',
    '/conversion-events', '/finances', '/notifications'];
  for (const p of order) {
    const key = PATH_KEYS[p];
    if (key && can(key)) return p;
  }
  // Settings tabs as a last resort.
  for (const [tab, key] of Object.entries(SETTINGS_TAB_KEYS)) {
    if (can(key)) return `/settings?tab=${tab}`;
  }
  return null;
}

// Enforce partner restrictions regardless of ticked boxes.
export function sanitizePermissions(baseRole, perms) {
  const out = { ...perms };
  if (baseRole === 'supplier' || baseRole === 'buyer') {
    RESTRICTED_FOR_PARTNERS.forEach(k => { delete out[k]; });
  }
  return out;
}