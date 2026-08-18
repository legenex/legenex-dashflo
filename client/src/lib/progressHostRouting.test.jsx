import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Navigate, matchRoutes, createRoutesFromElements } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProgressRoutes } from '@/ProgressHostRoutes';
import { AuthContext } from '@/lib/AuthContext';
import OwnerRoute from '@/components/OwnerRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import ProgressRelocated from '@/components/progress/ProgressRelocated';
import ProgressNamespaceRedirect from '@/components/progress/ProgressNamespaceRedirect';
import PageNotFound from '@/lib/PageNotFound';
import { PROGRESS_NAV } from '@/components/progress/progressNav';
import { PROGRESS_SURFACE_PATHS, PROGRESS_ORIGIN } from '@/lib/hostScope';

/* The Progress host answers its own root, and /progress is a redirect.
 *
 * The Control Center shipped as a dedicated host whose canonical URL was still
 * /progress, and the root of the host answered with an empty page: the guard in
 * front of the route table returned a redirect INSTEAD of the table, so the
 * address bar changed to /progress and that subtree, which holds no location,
 * never re-rendered. The browser was left showing the page background and
 * nothing else. These tests hold both halves of the fix: the canonical path is
 * the root of the host, and every redirect on this host is a route inside the
 * table rather than a return value in front of it.
 *
 * Owner-only access is asserted here too. It is the same boundary as before and
 * moving the paths must not have loosened it.
 */

// Render a hook-using component and keep what it returned, without rendering
// the result. Redirects and refusals are decisions, and the decision is the
// thing worth asserting: <Navigate> draws nothing, and a not-found page pulls a
// query client in for no gain.
function inRouter(node, path) {
  return React.createElement(MemoryRouter, { initialEntries: [path] }, node);
}

function decisionAt(path, node) {
  let captured;
  function Probe() {
    captured = node.type(node.props);
    return null;
  }
  renderToStaticMarkup(inRouter(React.createElement(Probe), path));
  return captured;
}

function withUser(user, node) {
  return React.createElement(
    AuthContext.Provider,
    { value: { user, previewRole: null, isAuthenticated: Boolean(user), isLoadingAuth: false, authChecked: true, authError: null, checkUserAuth: () => {} } },
    node,
  );
}

// Walk the route table and collect the paths it declares.
function routePaths(element) {
  const found = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node.props) return;
    if (typeof node.props.path === 'string') found.push(node.props.path);
    visit(node.props.children);
  };
  visit(element);
  return found;
}

describe('the Progress host serves the Control Center from its own root', () => {
  const paths = routePaths(ProgressRoutes());

  it('routes the Command Center at /', () => {
    expect(paths).toContain('/');
  });

  it('declares no route under the retired /progress namespace', () => {
    // The canonical namespace is the host. If a route reappears under /progress
    // there are two addresses for one surface again, which is what produced a
    // canonical URL nobody could load.
    expect(paths.filter((p) => p === '/progress' || p.startsWith('/progress/'))).toEqual([]);
  });

  it('routes exactly the surfaces the host allowlist permits', () => {
    // One list, read by the route table, the navigation and the allowlist. A
    // surface cannot be routable without being allowed, or allowed without
    // being routable.
    expect([...paths].sort()).toEqual([...PROGRESS_SURFACE_PATHS].sort());
  });

  it('resolves / to the Command Center inside the Progress shell', () => {
    // Route resolution against the real table, not a reading of it. This is the
    // acceptance criterion: progress.dashflo.io/ renders the Command Center.
    const routes = createRoutesFromElements(ProgressRoutes());
    const matched = matchRoutes(routes, '/');
    expect(matched, 'no route matched /').toBeTruthy();
    // The shell wraps the surface: a layout route with no path, then the page.
    expect(matched.length).toBe(2);
    expect(matched[0].route.path).toBeUndefined();
    expect(matched[1].route.path).toBe('/');
  });

  it('resolves every other surface the navigation links to', () => {
    const routes = createRoutesFromElements(ProgressRoutes());
    for (const path of PROGRESS_SURFACE_PATHS) {
      const matched = matchRoutes(routes, path);
      expect(matched?.at(-1)?.route?.path, path).toBe(path);
    }
  });

  it('matches nothing under the retired namespace, which is why it redirects', () => {
    // /progress has no route in this table at all. It resolves only through the
    // redirect App.jsx mounts alongside it, which is what makes / canonical
    // rather than one of two addresses for the same surface.
    const routes = createRoutesFromElements(ProgressRoutes());
    for (const path of ['/progress', '/progress/findings']) {
      expect(matchRoutes(routes, path), path).toBeNull();
    }
  });

  it('navigates to the same paths it routes', () => {
    const navTargets = PROGRESS_NAV.map((item) => item.to);
    expect(navTargets).toContain('/');
    for (const to of navTargets) {
      expect(paths, to).toContain(to);
    }
  });
});

describe('the retired namespace redirects on the Progress host', () => {
  it('routes the bare /progress through the same splat the deep paths use', () => {
    // App.jsx mounts one route, /progress/*, for the whole retired namespace.
    // That depends on a splat matching the bare parent path as well as the deep
    // ones. If it ever stopped, /progress would fall to the catch-all instead,
    // which still reaches the Command Center but by a different route than the
    // one these tests exercise.
    const table = [{ path: '/progress/*' }, { path: '/' }, { path: '*' }];
    for (const path of ['/progress', '/progress/', '/progress/findings']) {
      const matched = matchRoutes(table, path);
      expect(matched?.[0]?.route?.path, path).toBe('/progress/*');
    }
  });

  it('sends /progress to the Command Center at /', () => {
    for (const path of ['/progress', '/progress/']) {
      const decision = decisionAt(path, React.createElement(ProgressNamespaceRedirect));
      expect(decision.type, path).toBe(Navigate);
      expect(decision.props.to, path).toBe('/');
      expect(decision.props.replace, path).toBe(true);
    }
  });

  it('maps a deep /progress path onto its root equivalent', () => {
    const decision = decisionAt('/progress/findings', React.createElement(ProgressNamespaceRedirect));
    expect(decision.props.to).toBe('/findings');
  });

  it('carries the query string across', () => {
    const decision = decisionAt('/progress/review?page=leads', React.createElement(ProgressNamespaceRedirect));
    expect(decision.props.to).toBe('/review?page=leads');
  });

  it('sends a path the Control Center does not serve to the Command Center', () => {
    // An operator route typed into the address bar on this host resolves to the
    // Command Center, never to the operator surface and never to a dead end.
    const decision = decisionAt('/progress/leads', React.createElement(ProgressNamespaceRedirect));
    expect(decision.props.to).toBe('/');
  });

  it('never redirects a path onto itself', () => {
    // A redirect that resolves to the path it was reached on is an infinite
    // loop in the browser, which is the failure mode one step along from a
    // blank page.
    for (const path of ['/progress', '/progress/', '/progress/findings', '/progress/leads', '/progress/progress']) {
      const decision = decisionAt(path, React.createElement(ProgressNamespaceRedirect));
      expect(decision.props.to, path).not.toBe(path);
    }
  });
});

describe('the application host hands the owner over to the Progress host', () => {
  const owner = { base_role: 'owner', email: 'owner@example.com' };
  const admin = { base_role: 'admin', email: 'admin@example.com' };

  it('shows the owner the handoff rather than the Control Center', () => {
    const markup = renderToStaticMarkup(
      inRouter(withUser(owner, React.createElement(ProgressRelocated)), '/progress'),
    );
    expect(markup).toContain('Opening the Control Center');
  });

  it('shows a non-owner the ordinary not-found page', () => {
    let captured;
    function Probe() { captured = ProgressRelocated(); return null; }
    renderToStaticMarkup(inRouter(withUser(admin, React.createElement(Probe)), '/progress/findings'));
    expect(captured.type).toBe(PageNotFound);
  });

  it('tells a non-owner nothing about the tool or where it lives', () => {
    // The not-found page is rendered in full here rather than being inspected as
    // a decision, because what matters is every word it puts on the screen.
    const markup = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } }) },
        inRouter(withUser(admin, React.createElement(ProgressRelocated)), '/progress/findings'),
      ),
    );
    expect(markup).not.toContain('Control Center');
    expect(markup).not.toContain('progress.dashflo.io');
    expect(markup).not.toContain('Access denied');
  });
});

describe('the Control Center stays owner only', () => {
  it('refuses an admin without rendering any of the shell', () => {
    const admin = { base_role: 'admin', email: 'admin@example.com' };
    const markup = renderToStaticMarkup(
      inRouter(withUser(admin, React.createElement(OwnerRoute)), '/'),
    );
    expect(markup).toContain('Access denied');
    // The refusal is the whole page. Nothing under the shell is drawn, so no
    // readiness figure, finding or internal note is fetched first.
    expect(markup).not.toContain('Command Center');
    expect(markup).not.toContain('Progress');
  });

  it('refuses a signed-out visitor the same way', () => {
    const markup = renderToStaticMarkup(inRouter(withUser(null, React.createElement(OwnerRoute)), '/'));
    expect(markup).toContain('Access denied');
  });

  it('lets the owner through to the routed surface', () => {
    const owner = { base_role: 'owner', email: 'owner@example.com' };
    let captured;
    function Probe() { captured = OwnerRoute(); return null; }
    renderToStaticMarkup(inRouter(withUser(owner, React.createElement(Probe)), '/'));
    expect(captured.type).toBe(Outlet);
  });

  it('reads the real role, so an owner previewing another role keeps access', () => {
    const owner = { base_role: 'owner', email: 'owner@example.com' };
    const provider = React.createElement(
      AuthContext.Provider,
      { value: { user: owner, previewRole: 'manager' } },
      null,
    );
    let captured;
    function Probe() { captured = OwnerRoute(); return null; }
    renderToStaticMarkup(
      inRouter(React.cloneElement(provider, {}, React.createElement(Probe)), '/'),
    );
    expect(captured.type).toBe(Outlet);
  });
});

describe('an anonymous visitor to the Progress host reaches the login form', () => {
  it('sends an unauthenticated visitor to /login rather than drawing nothing', () => {
    const value = {
      isAuthenticated: false,
      isLoadingAuth: false,
      authChecked: true,
      authError: null,
      checkUserAuth: () => {},
    };
    let captured;
    function Probe() {
      captured = ProtectedRoute({ unauthenticatedElement: React.createElement(Navigate, { to: '/login', replace: true }) });
      return null;
    }
    renderToStaticMarkup(
      inRouter(React.createElement(AuthContext.Provider, { value }, React.createElement(Probe)), '/'),
    );
    expect(captured.type).toBe(Navigate);
    expect(captured.props.to).toBe('/login');
  });

  it('names the Control Center origin without a path, which is the Google origin', () => {
    // Google Authorized JavaScript origins are origins. The sign-in flow is the
    // existing same-origin one: the browser reads /auth/google/config and posts
    // the ID token back to the host it was served from, so the only thing the
    // Progress host needs is its own origin registered with Google.
    expect(PROGRESS_ORIGIN).toBe('https://progress.dashflo.io');
    expect(new URL(PROGRESS_ORIGIN).pathname).toBe('/');
  });
});
