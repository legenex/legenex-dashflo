import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ProtectedRoute from '@/components/ProtectedRoute';
import PermissionRoute from '@/components/PermissionRoute';
import ScrollToTop from './components/ScrollToTop';

import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

import ApiStatus from '@/pages/ApiStatus';
import Apply from '@/pages/Apply';
import DocsLayout from '@/components/docs/DocsLayout';
import { DOCS_ROUTES } from '@/components/docs/docsConfig';
import AppLayout from '@/components/layout/AppLayout';
import DistributionLayout from '@/components/distribution/DistributionLayout';
import LeadsLayout from '@/components/leads/LeadsLayout';
import FinancesLayout from '@/components/finances/FinancesLayout';
import OperationsLayout from '@/components/operations/OperationsLayout';
import AdManagerLayout from '@/components/admanager/AdManagerLayout';
import ToolsLayout from '@/components/tools/ToolsLayout';
import Overview from '@/pages/Overview';
import DistributionDashboard from '@/pages/DistributionDashboard';
import LeadsView from '@/pages/LeadsView';
import QueueRecovery from '@/pages/QueueRecovery';
import Campaigns from '@/pages/Campaigns';
import SupplierDetail from '@/pages/SupplierDetail';
import BuyerDetail from '@/pages/BuyerDetail';
import Reports from '@/pages/Reports';
import Finances from '@/pages/Finances';

import Deliveries from '@/pages/Deliveries';
import ConversionEvents from '@/pages/ConversionEvents';
import Notifications from '@/pages/Notifications';
import Verification from '@/pages/Verification';
import Settings from '@/pages/Settings';
import CustomCalculations from '@/pages/CustomCalculations';
import OperationsBuyers from '@/pages/operations/OperationsBuyers';
import OperationsSuppliers from '@/pages/operations/OperationsSuppliers';
import OperationsActiveStates from '@/pages/operations/OperationsActiveStates';
import OperationsBillingReports from '@/pages/operations/OperationsBillingReports';
import OperationsBuyerOnboarding from '@/pages/operations/OperationsBuyerOnboarding';
import OperationsDashboard from '@/pages/operations/OperationsDashboard';
import AdPerformanceDashboard from '@/pages/admanager/AdPerformanceDashboard';
import AdReports from '@/pages/admanager/AdReports';
import CreativeAnalyzer from '@/pages/admanager/CreativeAnalyzer';
import AdBuilder from '@/pages/admanager/AdBuilder';
import PayloadTester from '@/pages/PayloadTester';
import ToolsDashboard from '@/pages/ToolsDashboard';

import PortalLayout from '@/components/portal/PortalLayout';
import PortalDashboard from '@/pages/portal/PortalDashboard';
import PortalLeads from '@/pages/portal/PortalLeads';
import PortalReturns from '@/pages/portal/PortalReturns';
import PortalSettings from '@/pages/portal/PortalSettings';

import SupplierPortalLayout from '@/components/supplierportal/SupplierPortalLayout';
import SupplierPortalDashboard from '@/pages/supplierportal/SupplierPortalDashboard';
import SupplierPortalLeads from '@/pages/supplierportal/SupplierPortalLeads';
import SupplierPortalReturns from '@/pages/supplierportal/SupplierPortalReturns';
import SupplierPortalApi from '@/pages/supplierportal/SupplierPortalApi';
import SupplierPortalSettings from '@/pages/supplierportal/SupplierPortalSettings';

// Public documentation routes — rendered with no auth. Reused both on the
// docs subdomain (as the entire app) and under /docs on the main app.
const DocsRoutes = () => (
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

// True when the app is being served on the public docs subdomain.
const isDocsHost = () =>
  typeof window !== 'undefined' && /(^|\.)docs\./i.test(window.location.hostname);

// True when served on the API host (api.legenex.com). This domain exists only
// to serve backend functions, so the frontend just shows a status page and
// never gates on auth or redirects to the login page.
const isApiHost = () =>
  typeof window !== 'undefined' && /(^|\.)api\./i.test(window.location.hostname);

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // API host: never gate on auth. Every path renders the API status page.
  if (isApiHost()) {
    return (
      <Routes>
        <Route path="*" element={<ApiStatus />} />
      </Routes>
    );
  }

  // Docs subdomain: never gate on auth, never redirect to login. Route the
  // root and every path into the docs so anonymous visitors can read them.
  if (isDocsHost()) {
    return (
      <Routes>
        <Route path="/" element={<Navigate to="/docs" replace />} />
        {DocsRoutes()}
        <Route path="*" element={<Navigate to="/docs" replace />} />
      </Routes>
    );
  }

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary/20 border-t-primary rounded-full animate-spin"></div>
      </div>
    );
  }

  // /docs and /apply are public on the main host too — render them without redirecting to login.
  const onDocsPath = typeof window !== 'undefined' &&
    (window.location.pathname.startsWith('/docs') || window.location.pathname.startsWith('/apply'));
  // The app's own auth pages must render normally — never bounce them to the
  // hosted login, or an unauthenticated visitor on /login loops forever.
  const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];
  const onAuthPath = typeof window !== 'undefined' && AUTH_PATHS.some((p) => window.location.pathname.startsWith(p));

  if (authError && !onDocsPath && !onAuthPath) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Public documentation — no auth, outside ProtectedRoute and AppLayout */}
      {DocsRoutes()}

      {/* Public buyer onboarding — no auth, outside ProtectedRoute and AppLayout */}
      <Route path="/apply" element={<Apply />} />

      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        {/* Buyer portal: separate shell, its own sidebar, buyer-scoped. Not wrapped by the operator AppLayout. */}
        <Route element={<PortalLayout />}>
          <Route path="/portal" element={<PortalDashboard />} />
          <Route path="/portal/leads" element={<PortalLeads />} />
          <Route path="/portal/returns" element={<PortalReturns />} />
          <Route path="/portal/settings" element={<PortalSettings />} />
        </Route>
        {/* Supplier (Source) portal: separate shell, supplier-scoped. Not wrapped by the operator AppLayout. */}
        <Route element={<SupplierPortalLayout />}>
          <Route path="/supplier-portal" element={<SupplierPortalDashboard />} />
          <Route path="/supplier-portal/leads" element={<SupplierPortalLeads />} />
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
          </Route>
          <Route path="/leads/rejections" element={<Navigate to="/leads/rejected" replace />} />
          <Route path="/queue-recovery" element={<QueueRecovery />} />
          <Route path="/errors" element={<Navigate to="/settings?tab=errors" replace />} />
          <Route element={<DistributionLayout />}>
            <Route path="/distribution" element={<DistributionDashboard />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/deliveries" element={<Deliveries />} />
            <Route path="/conversion-events" element={<ConversionEvents />} />
          </Route>
          <Route path="/suppliers/:id" element={<SupplierDetail />} />
          <Route path="/buyers/:id" element={<BuyerDetail />} />
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
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App