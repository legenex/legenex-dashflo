import {
  LayoutDashboard, FileText, Share2, Wrench, Settings as SettingsIcon,
  BarChart3, Wallet, SlidersHorizontal, Megaphone,
} from 'lucide-react';

export const navGroups = [
  { label: 'Overview', icon: LayoutDashboard, path: '/', type: 'single', permKey: 'overview' },
  {
    label: 'Leads', icon: FileText, type: 'dropdown', path: '/leads', permKey: 'leads_all',
    children: [
      { label: 'Sold Leads', path: '/leads/sold', permKey: 'leads_sold' },
      { label: 'Unsold Leads', path: '/leads/unsold', permKey: 'leads_unsold' },
      { label: 'Disqualified Leads', path: '/leads/disqualified', permKey: 'leads_disqualified' },
      { label: 'Rejected Leads', path: '/leads/rejected', permKey: 'leads_rejected' },
      { label: 'Queued Leads', path: '/leads/queued', permKey: 'leads_queued' },
    ],
  },
  {
    label: 'Lead Distribution', icon: Share2, type: 'dropdown', path: '/distribution', permKey: 'dist_dashboard',
    children: [
      { label: 'Campaigns', path: '/campaigns', permKey: 'dist_campaigns' },
      { label: 'Deliveries', path: '/deliveries', permKey: 'dist_deliveries' },
      { label: 'Conversion Events', path: '/conversion-events', permKey: 'dist_conversion_events' },
    ],
  },
  {
    label: 'Reports', icon: BarChart3, type: 'dropdown', path: '/reports', permKey: 'reports',
    children: [
      { label: 'Performance Overview', path: '/reports', tab: 'performance_overview', permKey: 'reports' },
      { label: 'Daily Performance', path: '/reports', tab: 'daily', permKey: 'reports' },
      { label: 'Campaign Performance', path: '/reports', tab: 'campaign', permKey: 'reports' },
      { label: 'P&L', path: '/reports', tab: 'pnl', permKey: 'reports' },
      { label: 'Ad Performance', path: '/reports', tab: 'ad', permKey: 'reports' },
      { label: 'Buyer Performance', path: '/reports', tab: 'buyer', permKey: 'reports' },
      { label: 'Supplier Performance', path: '/reports', tab: 'supplier', permKey: 'reports' },
    ],
  },
  {
    label: 'Finances', icon: Wallet, type: 'dropdown', path: '/finances', permKey: 'finances',
    children: [
      { label: 'Overview', path: '/finances', tab: 'overview', permKey: 'finances' },
      { label: 'Profitability', path: '/finances', tab: 'profit', permKey: 'bank_feed' },
      { label: 'Bank Feed', path: '/finances', tab: 'bank', permKey: 'bank_feed' },
      { label: 'Invoices', path: '/finances', tab: 'invoices', permKey: 'finances' },
      { label: 'Buyer Payments', path: '/finances', tab: 'payments', permKey: 'finances' },
      { label: 'Supplier Payouts', path: '/finances', tab: 'payouts', permKey: 'finances' },
      { label: 'Ad Spend', path: '/finances', tab: 'adspend', permKey: 'finances' },
      { label: 'Settings', path: '/finances', tab: 'settings', permKey: 'finances' },
    ],
  },
  {
    label: 'Operations', icon: SlidersHorizontal, type: 'dropdown', path: '/operations', permKey: 'operations',
    children: [
      { label: 'Dashboard', path: '/operations', permKey: 'operations' },
      { label: 'Buyers', path: '/operations/buyers', permKey: 'operations' },
      { label: 'Suppliers', path: '/operations/suppliers', permKey: 'operations' },
      { label: 'Active States', path: '/operations/active-states', permKey: 'operations' },
      { label: 'Billing Reports', path: '/operations/billing-reports', permKey: 'operations' },
      { label: 'Buyer Onboarding', path: '/operations/buyer-onboarding', permKey: 'operations' },
    ],
  },
  {
    label: 'Ad Manager', icon: Megaphone, type: 'dropdown', path: '/ad-manager', permKey: 'ad_manager',
    children: [
      { label: 'Performance Dashboard', path: '/ad-manager', permKey: 'ad_manager' },
      { label: 'Ad Reports', path: '/ad-manager/reports', permKey: 'ad_manager' },
      { label: 'Creative Analyzer', path: '/ad-manager/creative-analyzer', permKey: 'ad_manager' },
      { label: 'Ad Builder', path: '/ad-manager/builder', permKey: 'ad_manager' },
    ],
  },
  {
    label: 'Tools', icon: Wrench, type: 'dropdown', path: '/tools', permKey: 'tools',
    children: [
      { label: 'Dashboard', path: '/tools', permKey: 'tools' },
      { label: 'Notifications', path: '/notifications', permKey: 'tools' },
      { label: 'Calculated Fields', path: '/calculated-fields', permKey: 'tools' },
      { label: 'Verification', path: '/verification', permKey: 'tools' },
      { label: 'Payload Tester', path: '/payload-tester', permKey: 'tools' },
    ],
  },
  {
    label: 'Settings', icon: SettingsIcon, type: 'dropdown', path: '/settings',
    children: [
      { label: 'General', path: '/settings', tab: 'general', permKey: 'set_integrations' },
      { label: 'Users and Roles', path: '/settings', tab: 'users', permKey: 'set_users' },
      { label: 'Integrations', path: '/settings', tab: 'integrations', permKey: 'set_integrations' },
      { label: 'Data Sources', path: '/settings', tab: 'data-sources', permKey: 'set_data_sources' },
      { label: 'Custom Fields', path: '/settings', tab: 'fields', permKey: 'set_custom_fields' },
      { label: 'Field Mapping', path: '/settings', tab: 'field-mapping', permKey: 'set_field_mapping' },
      { label: 'API Keys', path: '/settings', tab: 'apikeys', permKey: 'set_api_keys' },
      { label: 'Error Logs', path: '/settings', tab: 'errors', permKey: 'set_error_logs' },
      { label: 'Knowledge Base', path: '/settings', tab: 'knowledge', permKey: 'set_knowledge_base' },
      { label: 'Financial', path: '/settings', tab: 'billing', permKey: 'set_billing' },
    ],
  },
];

// Filter groups + children down to what the current user can access.
// A dropdown whose Settings parent link (General) is hidden still opens on its first visible child.
export function filterNav(groups, can) {
  return groups
    .map(group => {
      if (group.type === 'single') {
        return group.permKey && !can(group.permKey) ? null : group;
      }
      const children = (group.children || []).filter(c => !c.permKey || can(c.permKey));
      if (children.length === 0) return null;
      const next = { ...group, children };
      // If the parent has a direct path (Leads -> /leads, Settings -> /settings)
      // but the user can't access that exact target, route the parent to the first visible child.
      if (next.path) {
        if (next.permKey && !can(next.permKey)) {
          next.path = children[0].tab ? `${children[0].path}?tab=${children[0].tab}` : children[0].path;
        } else if (next.label === 'Settings') {
          next.path = children[0].tab ? `${children[0].path}?tab=${children[0].tab}` : children[0].path;
        }
      }
      return next;
    })
    .filter(Boolean);
}