import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePermissions } from '@/lib/AuthContext';
import { useTheme } from '@/lib/theme';
import {
  LayoutDashboard, FileText, Share2, Wrench, Settings as SettingsIcon,
  BarChart3, Wallet, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  SlidersHorizontal,
} from 'lucide-react';
import ViewAsSwitcher from './ViewAsSwitcher';
import SidebarProfile from './SidebarProfile';
import { useSidebarWidth } from '@/hooks/useSidebarWidth';
import ResizeHandle from './ResizeHandle';

const navGroups = [
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
function filterNav(groups, can) {
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

function isChildActive(location, child) {
  if (child.tab) {
    const params = new URLSearchParams(location.search);
    return location.pathname === child.path && params.get('tab') === child.tab;
  }
  if (child.path === '/') return location.pathname === '/';
  return location.pathname === child.path;
}

function shouldExpand(group, location) {
  if (group.type !== 'dropdown') return false;
  return group.children.some(c => isChildActive(location, c));
}

const SIDEBAR_GROUPS_KEY = 'legenex_sidebar_open_groups';

// Persisted open groups - survives navigation and page refresh.
function loadOpenGroups(location) {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_KEY));
    if (Array.isArray(stored)) return stored;
  } catch {}
  return navGroups.filter(g => shouldExpand(g, location)).map(g => g.label);
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { theme } = useTheme();
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const logoSrc = isDark
    ? '/brand/f9cc21785_LogoWideLightClear.png'
    : '/brand/9eecce577_Logo-Wide-Dark-Clear.png';
  const groups = filterNav(navGroups, can);
  const { width, startResize } = useSidebarWidth();
  const [openGroups, setOpenGroups] = useState(() => loadOpenGroups(location));

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(openGroups)); } catch {}
  }, [openGroups]);

  const toggleGroup = (label) => {
    setOpenGroups(prev => prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]);
  };

  return (
    <aside data-resize-origin className="fixed left-0 top-0 bottom-0 bg-sidebar flex flex-col border-r border-sidebar-border z-50"
      style={{ width: `${width}px`, borderTopRightRadius: '16px', borderBottomRightRadius: '16px' }}>

      <Link to="/" className="flex items-center px-5 py-6">
        <img src={logoSrc} alt="Legenex DashFlo" className="h-10 w-auto max-w-full object-contain" />
      </Link>

      <nav className="flex-1 px-3 space-y-0.5 mt-2 overflow-y-auto">
        {groups.map(group => {
          const Icon = group.icon;

          if (group.type === 'single') {
            const isActive = group.path === '/' ? location.pathname === '/' : location.pathname === group.path;
            return (
              <Link
                key={group.label}
                to={group.path}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 relative
                  ${isActive ? 'bg-primary/10 text-foreground' : 'text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent'}`}
              >
                {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />}
                <Icon className={`w-[18px] h-[18px] ${isActive ? 'text-primary' : ''}`} />
                {group.label}
              </Link>
            );
          }

          const isOpen = openGroups.includes(group.label);
          const hasActiveChild = group.children.some(c => isChildActive(location, c));
          const groupActive = group.path ? location.pathname === group.path : false;
          const highlight = hasActiveChild || groupActive;

          return (
            <div key={group.label}>
              <div className="flex items-center">
                <button
                  onClick={() => group.path ? navigate(group.path) : toggleGroup(group.label)}
                  className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 relative
                    ${highlight ? 'text-foreground' : 'text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent'}`}
                >
                  {highlight && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />}
                  <Icon className={`w-[18px] h-[18px] ${highlight ? 'text-primary' : ''}`} />
                  <span className="flex-1 text-left">{group.label}</span>
                </button>
                <button
                  onClick={() => toggleGroup(group.label)}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                  className={`shrink-0 mr-1.5 p-1 rounded-md border transition-all duration-150
                    ${isOpen ? 'bg-primary/15 text-primary border-primary/30' : 'bg-muted/60 border-sidebar-border text-sidebar-foreground hover:text-foreground hover:bg-accent'}`}
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              </div>
              {isOpen && (
                <div className="ml-4 pl-3 border-l border-sidebar-border space-y-0.5 mt-0.5 mb-1">
                  {group.children.map(child => {
                    const active = isChildActive(location, child);
                    const to = child.tab ? `${child.path}?tab=${child.tab}` : child.path;
                    return (
                      <Link
                        key={child.label}
                        to={to}
                        className={`flex items-center px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150
                          ${active ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent'}`}
                      >
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-sidebar-border space-y-2">
        <button
          onClick={() => {
            const labels = groups.filter(g => g.type === 'dropdown').map(g => g.label);
            const allOpen = labels.length > 0 && labels.every(l => openGroups.includes(l));
            setOpenGroups(allOpen ? [] : labels);
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[12px] font-medium text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent transition-all duration-150 border border-sidebar-border"
        >
          {(() => {
            const labels = groups.filter(g => g.type === 'dropdown').map(g => g.label);
            const allOpen = labels.length > 0 && labels.every(l => openGroups.includes(l));
            return allOpen ? (
              <><ChevronsDownUp className="w-3.5 h-3.5" /> Collapse All</>
            ) : (
              <><ChevronsUpDown className="w-3.5 h-3.5" /> Expand All</>
            );
          })()}
        </button>
        <ViewAsSwitcher />
        <SidebarProfile />
        <div className="text-[11px] text-muted-foreground text-center">v1.0.1</div>
      </div>

      {/* Resize handle — grip fixed at the bottom of the sidebar edge */}
      <ResizeHandle onMouseDown={startResize} title="Drag to resize sidebar" />
    </aside>
  );
}