// The operator route table, extracted from App.jsx so there is exactly one of it.
//
// Two things render this: the live application, and the Progress Control Center's
// offscreen screenshot capturer. The capturer needs the FULL shell (sidebar,
// section sub-nav, layout chrome) because those are things Nick reviews and
// comments on, and a bare page component is not what anyone actually looks at.
//
// Duplicating the table would guarantee drift, and a screenshot of a route table
// that no longer matches the app is worse than no screenshot.

import { lazy } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate, useParams, useSearchParams } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ProtectedRoute from '@/components/ProtectedRoute';
import PermissionRoute from '@/components/PermissionRoute';
import ScrollToTop from './components/ScrollToTop';
import { hostScope, isAllowedOnProgressHost } from '@/lib/hostScope';
import { DOCS_ROUTES } from '@/components/docs/docsConfig';

// The authentication entry points stay eagerly imported. They are the first
// thing an unauthenticated visitor renders, including everyone arriving from the
// marketing site's Login and Start Free Trial buttons, so putting a second
// network round trip in front of the login form would give the win back at
// exactly the wrong moment.
import Login from '@/pages/Login';
import Register from '@/pages/Register';

/* Everything below is fetched the first time its route is visited.
 *
 * These were all static imports, which put every page, portal, layout and chart
 * into one chunk: 3.6 MB raw, 932 KB gzipped, all of it required before the
 * login form could paint. Nobody visits more than a handful of these in a
 * session, and an unauthenticated visitor visits none of them.
 *
 * React.lazy needs a default export, which every one of these modules has. The
 * Suspense boundary that covers them lives in App.jsx, above the route tree, so
 * a single fallback serves every branch. The screenshot capturer in
 * components/progress/OffscreenCapture.jsx carries its own boundary because it
 * renders this table into a detached root.
 */
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));
const ApiStatus = lazy(() => import('@/pages/ApiStatus'));
const Apply = lazy(() => import('@/pages/Apply'));
const DocsLayout = lazy(() => import('@/components/docs/DocsLayout'));
const AppLayout = lazy(() => import('@/components/layout/AppLayout'));
const DistributionLayout = lazy(() => import('@/components/distribution/DistributionLayout'));
const LeadsLayout = lazy(() => import('@/components/leads/LeadsLayout'));
const CallsLayout = lazy(() => import('@/components/calls/CallsLayout'));
const CallsView = lazy(() => import('@/pages/CallsView'));
const FinancesLayout = lazy(() => import('@/components/finances/FinancesLayout'));
const OperationsLayout = lazy(() => import('@/components/operations/OperationsLayout'));
const AdManagerLayout = lazy(() => import('@/components/admanager/AdManagerLayout'));
const ToolsLayout = lazy(() => import('@/components/tools/ToolsLayout'));
const Overview = lazy(() => import('@/pages/Overview'));
const DistributionDashboard = lazy(() => import('@/pages/DistributionDashboard'));
const LeadsView = lazy(() => import('@/pages/LeadsView'));
const QueueRecovery = lazy(() => import('@/pages/QueueRecovery'));
const Campaigns = lazy(() => import('@/pages/Campaigns'));
const SupplierDetail = lazy(() => import('@/pages/SupplierDetail'));
const BuyerDetail = lazy(() => import('@/pages/BuyerDetail'));
const Reports = lazy(() => import('@/pages/Reports'));
const Finances = lazy(() => import('@/pages/Finances'));
const Deliveries = lazy(() => import('@/pages/Deliveries'));
const ConversionEvents = lazy(() => import('@/pages/ConversionEvents'));
const RouteSimulator = lazy(() => import('@/pages/RouteSimulator'));
const RouteGroups = lazy(() => import('@/pages/RouteGroups'));
const Notifications = lazy(() => import('@/pages/Notifications'));
const Verification = lazy(() => import('@/pages/Verification'));
const Settings = lazy(() => import('@/pages/Settings'));
const CustomCalculations = lazy(() => import('@/pages/CustomCalculations'));
const OperationsBuyers = lazy(() => import('@/pages/operations/OperationsBuyers'));
const OperationsSuppliers = lazy(() => import('@/pages/operations/OperationsSuppliers'));
const OperationsActiveStates = lazy(() => import('@/pages/operations/OperationsActiveStates'));
const OperationsVerticals = lazy(() => import('@/pages/operations/OperationsVerticals'));
const OperationsBillingReports = lazy(() => import('@/pages/operations/OperationsBillingReports'));
const OperationsBuyerOnboarding = lazy(() => import('@/pages/operations/OperationsBuyerOnboarding'));
const OperationsDashboard = lazy(() => import('@/pages/operations/OperationsDashboard'));
const AdPerformanceDashboard = lazy(() => import('@/pages/admanager/AdPerformanceDashboard'));
const AdReports = lazy(() => import('@/pages/admanager/AdReports'));
const CreativeAnalyzer = lazy(() => import('@/pages/admanager/CreativeAnalyzer'));
const AdBuilder = lazy(() => import('@/pages/admanager/AdBuilder'));
const PayloadTester = lazy(() => import('@/pages/PayloadTester'));
const ToolsDashboard = lazy(() => import('@/pages/ToolsDashboard'));
const ProgressLayout = lazy(() => import('@/components/progress/ProgressLayout'));
const CommandCenter = lazy(() => import('@/pages/progress/CommandCenter'));
const ApplicationReview = lazy(() => import('@/pages/progress/ApplicationReview'));
const Migration = lazy(() => import('@/pages/progress/Migration'));
const Gates = lazy(() => import('@/pages/progress/Gates'));
const Findings = lazy(() => import('@/pages/progress/Findings'));
const ChangeRequests = lazy(() => import('@/pages/progress/ChangeRequests'));
const PromptStudio = lazy(() => import('@/pages/progress/PromptStudio'));
const BuildActivity = lazy(() => import('@/pages/progress/BuildActivity'));
const ProgressSettings = lazy(() => import('@/pages/progress/ProgressSettings'));
const PortalLayout = lazy(() => import('@/components/portal/PortalLayout'));
const PortalDashboard = lazy(() => import('@/pages/portal/PortalDashboard'));
const PortalLeads = lazy(() => import('@/pages/portal/PortalLeads'));
const PortalReports = lazy(() => import('@/pages/portal/PortalReports'));
const PortalReturns = lazy(() => import('@/pages/portal/PortalReturns'));
const PortalSettings = lazy(() => import('@/pages/portal/PortalSettings'));
const SupplierPortalLayout = lazy(() => import('@/components/supplierportal/SupplierPortalLayout'));
const SupplierPortalDashboard = lazy(() => import('@/pages/supplierportal/SupplierPortalDashboard'));
const SupplierPortalLeads = lazy(() => import('@/pages/supplierportal/SupplierPortalLeads'));
const SupplierPortalReports = lazy(() => import('@/pages/supplierportal/SupplierPortalReports'));
const SupplierPortalReturns = lazy(() => import('@/pages/supplierportal/SupplierPortalReturns'));
const SupplierPortalApi = lazy(() => import('@/pages/supplierportal/SupplierPortalApi'));
const SupplierPortalSettings = lazy(() => import('@/pages/supplierportal/SupplierPortalSettings'));

function LegacySupplierRedirect() {
  const { id } = useParams();
  const [params] = useSearchParams();
  if (params.get('legacy') === '1') return <SupplierDetail />;
  const tab = params.get('tab');
  const qs = new URLSearchParams({ supplier: id || '' });
  if (tab) qs.set('tab', tab);
  return <Navigate to={`/operations/suppliers?${qs.toString()}`} replace />;
}

// Same handoff for buyers. The old /buyers/:id page duplicated the Operations
// buyer detail; Operations is the surface that is maintained, so old links go
// there with their tab preserved.
function LegacyBuyerRedirect() {
  const { id } = useParams();
  const [params] = useSearchParams();
  if (params.get('legacy') === '1') return <BuyerDetail />;
  const tab = params.get('tab');
  const qs = new URLSearchParams({ buyer: id || '' });
  if (tab) qs.set('tab', tab);
  return <Navigate to={`/operations/buyers?${qs.toString()}`} replace />;
}

// Public documentation routes, rendered with no auth. Reused both on the
// docs subdomain (as the entire app) and under /docs on the main app.

export const DocsRoutes = () => (
  <Route path="/docs" element={<DocsLayout />}>
    {DOCS_ROUTES.map((r) => (
      <Route
        key={r.slug || 'index'}
        {...(r.slug ? { path: r.slug } : { index: true })}
        element={<r.Component />}
      />
    ))}
  </Route>
);

export const ProgressRoutes = () => (
  <Route element={<ProgressLayout />}>
    <Route path="/progress" element={<CommandCenter />} />
    <Route path="/progress/review" element={<ApplicationReview />} />
    <Route path="/progress/migration" element={<Migration />} />
    <Route path="/progress/gates" element={<Gates />} />
    <Route path="/progress/findings" element={<Findings />} />
    <Route path="/progress/changes" element={<ChangeRequests />} />
    <Route path="/progress/prompts" element={<PromptStudio />} />
    <Route path="/progress/activity" element={<BuildActivity />} />
    <Route path="/progress/settings" element={<ProgressSettings />} />
  </Route>
);

export function OperatorRoutes() {
  return (
    <>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Public documentation, no auth, outside ProtectedRoute and AppLayout */}
      {DocsRoutes()}

      {/* Public buyer onboarding, no auth, outside ProtectedRoute and AppLayout */}
      <Route path="/apply" element={<Apply />} />

      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        {/* Buyer portal: separate shell, its own sidebar, buyer-scoped. Not wrapped by the operator AppLayout. */}
        <Route element={<PortalLayout />}>
          <Route path="/portal" element={<PortalDashboard />} />
          <Route path="/portal/leads" element={<PortalLeads />} />
          <Route path="/portal/reports" element={<PortalReports />} />
          <Route path="/portal/returns" element={<PortalReturns />} />
          <Route path="/portal/settings" element={<PortalSettings />} />
        </Route>
        {/* Supplier (Source) portal: separate shell, supplier-scoped. Not wrapped by the operator AppLayout. */}
        <Route element={<SupplierPortalLayout />}>
          <Route path="/supplier-portal" element={<SupplierPortalDashboard />} />
          <Route path="/supplier-portal/leads" element={<SupplierPortalLeads />} />
          <Route path="/supplier-portal/reports" element={<SupplierPortalReports />} />
          <Route path="/supplier-portal/returns" element={<SupplierPortalReturns />} />
          <Route path="/supplier-portal/api" element={<SupplierPortalApi />} />
          <Route path="/supplier-portal/settings" element={<SupplierPortalSettings />} />
        </Route>
        <Route element={<AppLayout />}>
          <Route element={<PermissionRoute />}>
          <Route path="/" element={<Overview />} />
          <Route element={<LeadsLayout />}>
            <Route path="/leads" element={<LeadsView view="all" />} />
            <Route path="/leads/sold" element={<LeadsView view="sold" />} />
            <Route path="/leads/unsold" element={<LeadsView view="unsold" />} />
            <Route path="/leads/disqualified" element={<LeadsView view="disqualified" />} />
            <Route path="/leads/rejected" element={<LeadsView view="rejected" />} />
            <Route path="/leads/queued" element={<LeadsView view="queued" />} />
            <Route path="/leads/converted" element={<LeadsView view="converted" />} />
          </Route>
          <Route path="/leads/rejections" element={<Navigate to="/leads/rejected" replace />} />
          {/* Calls moved out of the Leads section into their own top-level
              section. The old path stays as a redirect so bookmarks survive. */}
          <Route path="/leads/calls" element={<Navigate to="/calls" replace />} />
          <Route element={<CallsLayout />}>
            <Route path="/calls" element={<CallsView view="all" />} />
            <Route path="/calls/converted" element={<CallsView view="converted" />} />
            <Route path="/calls/rejected" element={<CallsView view="rejected" />} />
          </Route>
          <Route path="/queue-recovery" element={<QueueRecovery />} />
          <Route path="/errors" element={<Navigate to="/settings?tab=errors" replace />} />
          <Route element={<DistributionLayout />}>
            <Route path="/distribution" element={<DistributionDashboard />} />
            <Route path="/campaigns" element={<Campaigns />} />
            {/* Buyers live in Operations only. These paths are kept as redirects so
                existing bookmarks and cross-links do not 404. */}
            <Route path="/distribution/buyers" element={<Navigate to="/operations/buyers" replace />} />
            <Route path="/distribution/buyers/:id" element={<Navigate to="/operations/buyers" replace />} />
            <Route path="/campaigns/deliveries" element={<Navigate to="/campaigns" replace />} />
            {/* Nick's live rename: /deliveries stays and renders the Webhooks page. */}
            <Route path="/deliveries" element={<Deliveries />} />
            <Route path="/conversion-events" element={<ConversionEvents />} />
            {/* Route Groups (Advanced) + Simulator stay routable, out of nav. */}
            <Route path="/distribution/routes" element={<RouteGroups />} />
            <Route path="/distribution/simulator" element={<RouteSimulator />} />
          </Route>
          {/* Suppliers and buyers are managed inside Operations. The old
              standalone detail pages are kept mounted only behind ?legacy=1 so
              nothing breaks if a bookmark or an old link is still in use; the
              default is to hand off to the Operations surface, which now holds
              the full tab set (Overview, Sources, Ad Spend, Posting Specs,
              Portal, Leads). */}
          <Route path="/suppliers/:id" element={<LegacySupplierRedirect />} />
          <Route path="/buyers/:id" element={<LegacyBuyerRedirect />} />
          <Route path="/buyers" element={<Navigate to="/campaigns?tab=buyers" replace />} />
          <Route path="/suppliers" element={<Navigate to="/campaigns?tab=suppliers" replace />} />
          <Route path="/reports" element={<Reports />} />
          <Route element={<FinancesLayout />}>
            <Route path="/finances" element={<Finances />} />
          </Route>
          <Route element={<OperationsLayout />}>
            <Route path="/operations" element={<OperationsDashboard />} />
            <Route path="/operations/buyers" element={<OperationsBuyers />} />
            <Route path="/operations/suppliers" element={<OperationsSuppliers />} />
            <Route path="/operations/verticals" element={<OperationsVerticals />} />
            <Route path="/operations/active-states" element={<OperationsActiveStates />} />
            <Route path="/operations/billing-reports" element={<OperationsBillingReports />} />
            <Route path="/operations/buyer-onboarding" element={<OperationsBuyerOnboarding />} />
          </Route>
          <Route element={<AdManagerLayout />}>
            <Route path="/ad-manager" element={<AdPerformanceDashboard />} />
            <Route path="/ad-manager/reports" element={<AdReports />} />
            <Route path="/ad-manager/creative-analyzer" element={<CreativeAnalyzer />} />
            <Route path="/ad-manager/builder" element={<AdBuilder />} />
          </Route>
          <Route path="/lead-distribution" element={<Navigate to="/campaigns" replace />} />
          <Route element={<ToolsLayout />}>
            <Route path="/tools" element={<ToolsDashboard />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/verification" element={<Verification />} />
            <Route path="/calculated-fields" element={<CustomCalculations />} />
            <Route path="/payload-tester" element={<PayloadTester />} />
          </Route>
          <Route path="/settings" element={<Settings />} />
          {/* Progress Control Center on the main dashboard host. Gated by the
              progress permission keys through PermissionRoute like every other
              operator route. */}
          {ProgressRoutes()}
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </>
  );
}
