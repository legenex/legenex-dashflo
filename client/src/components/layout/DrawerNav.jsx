import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePermissions } from '@/lib/AuthContext';
import { useTheme } from '@/lib/theme';
import { ChevronDown, ChevronRight } from 'lucide-react';
import ViewAsSwitcher from './ViewAsSwitcher';
import SidebarProfile from './SidebarProfile';
import { navGroups, filterNav } from './navConfig';

function isChildActive(location, child) {
  if (child.tab) {
    const params = new URLSearchParams(location.search);
    return location.pathname === child.path && params.get('tab') === child.tab;
  }
  if (child.path === '/') return location.pathname === '/';
  return location.pathname === child.path;
}

// Drawer variant of the sidebar nav. Same navGroups + filterNav + footer content,
// but no ResizeHandle and no Expand/Collapse All button. Navigating closes the drawer.
export default function DrawerNav({ onNavigate }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { theme } = useTheme();
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const logoSrc = isDark
    ? '/brand/f9cc21785_LogoWideLightClear.png'
    : '/brand/9eecce577_Logo-Wide-Dark-Clear.png';
  const groups = filterNav(navGroups, can);

  const [openGroups, setOpenGroups] = useState(() =>
    groups.filter(g => g.type === 'dropdown' && g.children.some(c => isChildActive(location, c))).map(g => g.label)
  );

  const toggleGroup = (label) => {
    setOpenGroups(prev => prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]);
  };

  const go = (to) => {
    navigate(to);
    onNavigate?.();
  };

  return (
    <div className="h-full flex flex-col bg-card">
      <Link to="/" onClick={() => onNavigate?.()} className="flex items-center px-5 py-6">
        <img src={logoSrc} alt="Legenex DashFlo" className="h-10 w-auto max-w-full object-contain" />
      </Link>

      <nav className="flex-1 px-3 space-y-0.5 mt-2 overflow-y-auto">
        {groups.map(group => {
          const Icon = group.icon;

          if (group.type === 'single') {
            const isActive = group.path === '/' ? location.pathname === '/' : location.pathname === group.path;
            return (
              <button
                key={group.label}
                onClick={() => go(group.path)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 relative text-left
                  ${isActive ? 'bg-primary/10 text-foreground' : 'text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent'}`}
              >
                {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />}
                <Icon className={`w-[18px] h-[18px] ${isActive ? 'text-primary' : ''}`} />
                {group.label}
              </button>
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
                  onClick={() => group.path ? go(group.path) : toggleGroup(group.label)}
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
                      <button
                        key={child.label}
                        onClick={() => go(to)}
                        className={`w-full flex items-center px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150 text-left
                          ${active ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent'}`}
                      >
                        {child.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-sidebar-border space-y-2">
        <ViewAsSwitcher />
        <SidebarProfile />
        <div className="text-[11px] text-muted-foreground text-center">v1.0.1</div>
      </div>
    </div>
  );
}