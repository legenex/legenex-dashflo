import React, { useState, useMemo, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import Sidebar from './Sidebar';
import DrawerNav from './DrawerNav';
import MobileBottomTabs from './MobileBottomTabs';
import DataBotWidget from '@/components/databot/DataBotWidget';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { navGroups } from './navConfig';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';

// Resolve a human page title from the nav config for the current path.
function usePageTitle() {
  const location = useLocation();
  return useMemo(() => {
    const path = location.pathname;
    if (path === '/') return 'Overview';
    for (const group of navGroups) {
      if (group.path && group.path !== '/' && path === group.path) return group.label;
      for (const child of group.children || []) {
        if (child.path === path) return group.label;
      }
      if (group.path && group.path !== '/' && path.startsWith(group.path + '/')) return group.label;
    }
    return 'Legenex';
  }, [location.pathname]);
}

export default function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const title = usePageTitle();
  const location = useLocation();
  const queryClient = useQueryClient();
  const scrollRef = useRef(null);

  // Pull-to-refresh only on the data-heavy list dashboards.
  const ptrEnabled = location.pathname === '/' || location.pathname === '/leads';
  const { pull, refreshing, threshold } = usePullToRefresh(
    scrollRef,
    () => queryClient.invalidateQueries(),
    { enabled: ptrEnabled }
  );

  const { data: errorCount = 0 } = useQuery({
    queryKey: ['layout-error-count'],
    queryFn: async () => {
      const errs = await api.entities.ErrorLog.list('-created_date', 100);
      return errs.length;
    },
    staleTime: 60000,
  });

  return (
    <div className="h-screen bg-background overflow-hidden">
      {/* Desktop sidebar: lg and up only */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile top header: below lg only */}
      <header
        className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 bg-background/95 backdrop-blur border-b border-border"
        style={{ height: 'calc(52px + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
      >
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="tap-target relative w-[38px] h-[38px] flex items-center justify-center rounded-lg bg-card border border-border"
        >
          <Menu className="w-[18px] h-[18px]" />
          {errorCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary" />
          )}
        </button>
        <div className="text-[15px] font-semibold text-foreground truncate">{title}</div>
        <div className="flex-1" />
      </header>

      {/* Mobile drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="p-0 bg-card border-sidebar-border" style={{ width: '288px', maxWidth: '288px' }}>
          <DrawerNav onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <main className="h-screen lg:ml-[var(--sidebar-width,248px)]">
        {(pull > 0 || refreshing) && (
          <div
            className="lg:hidden flex items-center justify-center text-muted-foreground overflow-hidden"
            style={{ height: `${Math.min(pull, threshold)}px`, opacity: Math.min(pull / threshold, 1) }}
          >
            <Loader2 className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
          </div>
        )}
        <div
          ref={scrollRef}
          className="app-scroll h-[calc(100%-52px-env(safe-area-inset-top))] lg:h-full overflow-y-auto overflow-x-hidden p-4 lg:p-8"
        >
          <Outlet />
        </div>
      </main>
      <MobileBottomTabs />
      <DataBotWidget />
    </div>
  );
}