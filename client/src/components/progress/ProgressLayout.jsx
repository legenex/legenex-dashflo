import React, { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, ExternalLink, ShieldAlert, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePermissions } from '@/lib/AuthContext';
import { PROGRESS_NAV } from './progressNav';
import { isProgressHost } from '@/lib/hostScope';
import ProgressErrorBoundary from './ProgressErrorBoundary';

// Dedicated shell for the Progress Control Center.
//
// Permanent left sidebar on desktop, a drawer on mobile. It mirrors the card,
// row and token treatment of the known-good operator pages (Operations, Leads)
// so this reads as part of the same product, but it never mounts the operator
// sidebar: the two surfaces have different jobs and different audiences.

function NavItems({ items, onNavigate, compact }) {
  const location = useLocation();
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {items.map((item) => {
        const Icon = item.icon;
        // Command Center is the index route, so only match it exactly.
        const active = item.to === '/progress'
          ? location.pathname === '/progress'
          : location.pathname.startsWith(item.to);
        return (
          <NavLink
            key={item.key}
            to={item.to}
            onClick={onNavigate}
            title={compact ? `${item.label}: ${item.description}` : undefined}
            className={`group relative flex items-start gap-2.5 rounded-md py-2 transition-colors ${compact ? 'justify-center px-2' : 'px-3'} ${
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-primary" />}
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            {!compact && (
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-tight">{item.label}</span>
                <span className="mt-0.5 block text-[11px] leading-tight text-muted-foreground">
                  {item.description}
                </span>
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function SidebarHeader() {
  return (
    <div className="border-b border-border px-4 py-3">
      <p className="text-[13px] font-semibold text-foreground">Progress Control Center</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">Legenex Dashboard build management</p>
    </div>
  );
}

function SidebarFooter() {
  return (
    <div className="mt-auto border-t border-border p-3">
      <a
        href="/"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Back to the operator dashboard
      </a>
    </div>
  );
}

export default function ProgressLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem('progress_nav_open') !== '0'; } catch { return true; }
  });
  const { can } = usePermissions();
  const location = useLocation();

  const items = PROGRESS_NAV.filter((i) => i.built && (!i.permKey || can(i.permKey)));

  // A user who reached a progress route without any progress key at all sees an
  // explicit notice rather than an empty shell.
  if (items.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <ShieldAlert className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-[15px] font-semibold text-foreground">No progress access</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Your account does not have any Progress Control Center permission. Ask an administrator
            to grant progress access under Settings, Users and Roles.
          </p>
        </div>
      </div>
    );
  }

  // On the dashboard host the operator sidebar already carries a Progress
  // section, so rendering a second nav column here would be duplicate navigation
  // eating the width of the thing being reviewed. On the progress subdomain
  // there is no operator sidebar, so this is the only navigation and it stays.
  const ownNav = isProgressHost(typeof window !== 'undefined' ? window.location.hostname : '');

  if (!ownNav) {
    return (
      <div className="min-w-0">
        <ProgressErrorBoundary key={location.pathname}>
          <Outlet />
        </ProgressErrorBoundary>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar. Only on the progress subdomain. Collapsible, because
          even alone it competes with the page tree for width. */}
      <aside className={`hidden shrink-0 flex-col border-r border-border bg-card lg:flex ${navOpen ? 'w-64' : 'w-14'}`}>
        {navOpen && <SidebarHeader />}
        <NavItems items={items} compact={!navOpen} />
        <div className="mt-auto border-t border-border p-2">
          <button
            type="button"
            onClick={() => {
              const next = !navOpen;
              setNavOpen(next);
              try { localStorage.setItem('progress_nav_open', next ? '1' : '0'); } catch { /* private mode */ }
            }}
            title={navOpen ? 'Collapse' : 'Expand'}
            className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {navOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            {navOpen && 'Collapse'}
          </button>
        </div>
        {navOpen && <SidebarFooter />}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-background/80"
          />
          <div className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <p className="text-[13px] font-semibold text-foreground">Progress Control Center</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Build management</p>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <NavItems items={items} onNavigate={() => setDrawerOpen(false)} />
            <SidebarFooter />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="text-[13px] font-semibold text-foreground">Progress Control Center</span>
        </div>

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          {/* Keyed on pathname so navigating away from a broken surface clears
              the error instead of trapping the shell in it. */}
          <ProgressErrorBoundary key={location.pathname}>
            <Outlet />
          </ProgressErrorBoundary>
        </main>
      </div>
    </div>
  );
}
