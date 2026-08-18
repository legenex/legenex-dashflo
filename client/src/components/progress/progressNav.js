import {
  Gauge, ListTree, AlertTriangle, GitPullRequest, Sparkles,
  Activity, ArrowRightLeft, ShieldCheck, Cog,
} from 'lucide-react';

// The Progress Control Center has its own navigation. It deliberately does NOT
// live inside the operator sidebar: this is an internal build-management surface,
// not part of the product Nick's team runs the business on.
// `built` gates the sidebar. A surface that does not exist yet is not linked,
// because a dead nav link is a defect, not a placeholder.
//
// Every `to` is a path on progress.dashflo.io, where the Control Center is the
// whole application and its Command Center is the root of the host. These must
// stay in step with PROGRESS_SURFACE_PATHS in lib/hostScope.js, which the route
// table and the host allowlist read; progressSeparation.test.js holds them
// together, so a link here cannot point at a path this host refuses to serve.
export const PROGRESS_NAV = [
  {
    key: 'command',
    label: 'Command Center',
    to: '/',
    icon: Gauge,
    permKey: 'progress_access',
    built: true,
    description: 'Readiness, blockers and the current go or no-go call',
  },
  {
    key: 'review',
    label: 'Application Review',
    to: '/review',
    icon: ListTree,
    permKey: 'progress_access',
    tree: true,
    built: true,
    description: 'Every section and page, with a review workspace each',
  },
  {
    key: 'findings',
    label: 'Findings',
    to: '/findings',
    icon: AlertTriangle,
    permKey: 'progress_access',
    built: true,
    description: 'Machine, AI and human findings in one list',
  },
  {
    key: 'changes',
    label: 'Change Requests',
    to: '/changes',
    icon: GitPullRequest,
    permKey: 'progress_access',
    built: true,
    description: 'Approved and proposed work, draft through released',
  },
  {
    key: 'prompts',
    label: 'Prompt Studio',
    to: '/prompts',
    icon: Sparkles,
    permKey: 'progress_prompts',
    built: true,
    description: 'Implementation prompts for agents and developers',
  },
  {
    key: 'activity',
    label: 'Build Activity',
    to: '/activity',
    icon: Activity,
    permKey: 'progress_access',
    built: true,
    description: 'What changed, who changed it and what it affected',
  },
  {
    key: 'migration',
    label: 'LeadByte Migration',
    to: '/migration',
    icon: ArrowRightLeft,
    permKey: 'progress_access',
    built: true,
    description: 'Capability parity across the ten migration groups',
  },
  {
    key: 'gates',
    label: 'Release Gates',
    to: '/gates',
    icon: ShieldCheck,
    permKey: 'progress_access',
    built: true,
    description: 'Objective conditions that must hold before cutover',
  },
  {
    key: 'settings',
    label: 'Progress Settings',
    to: '/settings',
    icon: Cog,
    permKey: 'progress_admin',
    built: true,
    description: 'Weights, gates, verification requirements, sync',
  },
];

// Sections are ordered so the ones that carry the most migration risk sit at the
// top of the Application Review tree rather than in alphabetical order.
export const SECTION_ORDER = [
  'lead-distribution',
  'leads',
  'operations',
  'overview',
  'reports',
  'finances',
  'ad-manager',
  'tools',
  'settings',
  'buyer-portal',
  'supplier-portal',
  'documentation',
  'buyer-onboarding',
  'authentication',
  'error-states',
  'other',
];

export function sortSections(keys) {
  return [...keys].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
  });
}
