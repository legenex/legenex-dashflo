import { Suspense } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ProtectedRoute from '@/components/ProtectedRoute';
import OwnerRoute from '@/components/OwnerRoute';
import ScrollToTop from './components/ScrollToTop';
import { hostScope, isProgressAuthPath } from '@/lib/hostScope';
import ProgressNamespaceRedirect from '@/components/progress/ProgressNamespaceRedirect';
import { OperatorRoutes, DocsRoutes } from './AppRoutes';
import { ProgressRoutes } from './ProgressHostRoutes';

import Login from '@/pages/Login';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

import ApiStatus from '@/pages/ApiStatus';





// The standalone /suppliers/:id page predates Operations owning suppliers, so
// its tabs duplicated (and drifted from) the Operations ones. Operations now
// deep-links via ?supplier=<id>&tab=<tab>, so old links land on the maintained
// surface with the tab they asked for. ?legacy=1 still reaches the old page if
// something turns out to depend on it.

// Host predicates live in src/lib/hostScope.js so they can be unit tested. Host
// scoping is a security boundary, not a convenience.
const currentHost = () => (typeof window !== 'undefined' ? window.location.hostname : '');
const currentPath = () => (typeof window !== 'undefined' ? window.location.pathname : '/');
const isDocsHost = () => hostScope(currentHost()) === 'docs';

// api.legenex.com exists only to serve backend functions, so the frontend just
// shows a status page and never gates on auth or redirects to login.
const isApiHost = () => hostScope(currentHost()) === 'api';

// progress.dashflo.io serves ONLY the authenticated Progress Control Center, at
// the root of the host. The operator dashboard, the portals, the docs and the
// public application form are all unreachable there, because the route table
// that contains them is never mounted on this host rather than because a link
// to them happens not to exist.
const isProgressHost = () => hostScope(currentHost()) === 'progress';


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

  // Progress subdomain: authenticated, and the ONLY thing it serves. The
  // operator dashboard is never reachable here, so an unauthenticated visitor
  // goes to login and every other path lands back on the Command Center rather
  // than falling through to the operator app.
  //
  // The Control Center is this host, so its address is the root of the host.
  // progress.dashflo.io/ is the Command Center; there is no /progress segment,
  // and the operator route table is not mounted here at all, which is what makes
  // / mean the Command Center and not Overview.
  if (isProgressHost()) {
    // Keep the Control Center out of search results. The nginx host sends
    // X-Robots-Tag, which is what a crawler actually obeys for this bundle;
    // this tag is the second copy, so the page is still marked if it is ever
    // served by something other than that server block.
    if (typeof document !== 'undefined' && !document.querySelector('meta[name="robots"]')) {
      const meta = document.createElement('meta');
      meta.name = 'robots';
      meta.content = 'noindex, nofollow, noarchive';
      document.head.appendChild(meta);
    }

    // A stale credential that no longer authenticates sends the visitor to the
    // login form, exactly as it does on the application host. The auth paths are
    // excluded for the same reason they are excluded there: bouncing the login
    // page to the login page is a reload loop, not a redirect.
    if (authError && !isProgressAuthPath(currentPath())) {
      if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
      if (authError.type === 'auth_required') { navigateToLogin(); return null; }
    }
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        {/* The retired namespace, mapped onto the canonical path. This is a
            route, not a guard in front of the table: a redirect returned in
            place of <Routes> updates the address bar and then never re-renders,
            which is exactly how this host came to answer its own root with an
            empty page. */}
        <Route path="/progress/*" element={<ProgressNamespaceRedirect />} />
        <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
          {/* Owner only. Being signed in is not enough and admin is not enough.
              An account that authenticates here and is not the owner gets a bare
              refusal, never a partly rendered Control Center: OwnerRoute renders
              instead of the shell rather than around it, so no readiness figure,
              finding, screenshot or internal note is fetched or painted first.

              This is the second of two gates, not the only one. The server
              refuses Progress entities and Progress functions to non-owners,
              so removing this component from the bundle would change what is
              drawn and nothing about what can be read. */}
          <Route element={<OwnerRoute />}>
            {ProgressRoutes()}
          </Route>
        </Route>
        {/* Anything this host does not serve goes to the Command Center. This is
            what locks the subdomain: typing an operator route into the address
            bar on this host cannot render it. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // /docs and /apply are public on the main host too, render them without redirecting to login.
  const onDocsPath = typeof window !== 'undefined' &&
    (window.location.pathname.startsWith('/docs') || window.location.pathname.startsWith('/apply'));
  // The app's own auth pages must render normally, never bounce them to the
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
      {/* Single source of truth, shared with the screenshot capturer. */}
      {OperatorRoutes()}
    </Routes>
  );
};

// Route components are code split, so the tree suspends while a page chunk is
// fetched. One boundary above every branch of AuthenticatedApp covers all of
// them, rather than a boundary per Routes block that would each need their own
// fallback and each drift.
//
// The fallback is deliberately blank. A spinner that appears for the 40ms a
// local chunk takes is a flash, not feedback, and every route below already
// renders its own loading state once mounted.
const RouteFallback = () => <div className="min-h-screen bg-background" aria-busy="true" />;

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <Suspense fallback={<RouteFallback />}>
            <AuthenticatedApp />
          </Suspense>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App