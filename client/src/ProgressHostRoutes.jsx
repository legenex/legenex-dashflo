// The Progress Control Center route table.
//
// Mounted only on progress.dashflo.io, where the Control Center is the entire
// application, so its paths are the roots of that host rather than a namespace
// inside it. The Command Center is the host itself: progress.dashflo.io/ and
// nothing longer.
//
// /progress is not here. That was the namespace back when the Control Center was
// a section of the operator app. On this host it now redirects onto the
// canonical path, and on the application host it hands off to this host. See
// lib/hostScope.js for the one list these paths come from,
// components/progress/ProgressNamespaceRedirect.jsx for the redirect on this
// host, and components/progress/ProgressRelocated.jsx for the handoff from the
// application host.
//
// This table lives apart from the operator table in AppRoutes.jsx deliberately.
// The two are mounted on different hosts and share nothing, and keeping them in
// one module meant loading the operator shell, its toaster and its query client
// in order to read the nine routes this host serves.

import { lazy } from 'react';
import { Route } from 'react-router-dom';

// Code split like every other route. The Suspense boundary that covers them
// lives in App.jsx, above the route tree.
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

export const ProgressRoutes = () => (
  <Route element={<ProgressLayout />}>
    <Route path="/" element={<CommandCenter />} />
    <Route path="/review" element={<ApplicationReview />} />
    <Route path="/migration" element={<Migration />} />
    <Route path="/gates" element={<Gates />} />
    <Route path="/findings" element={<Findings />} />
    <Route path="/changes" element={<ChangeRequests />} />
    <Route path="/prompts" element={<PromptStudio />} />
    <Route path="/activity" element={<BuildActivity />} />
    <Route path="/settings" element={<ProgressSettings />} />
  </Route>
);

export default ProgressRoutes;
