import React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { useCollapsible } from '@/hooks/useCollapsible';
import ResizeHandle from './ResizeHandle';
import SubNavRail from './SubNavRail';

// Wraps a section sub-navigation column and makes it horizontally resizable
// and collapsible. The collapsed preference is remembered across pages and
// page refreshes.
//
// At lg and up: renders the resizable vertical column. When collapsed, the
// column shrinks to a thin rail with a single expand button.
// Below lg: renders no column and no ResizeHandle. Instead, when the nav passes
// an `items` array, it renders a horizontal scrolling rail (SubNavRail).
export default function SubNavShell({ children, items }) {
  // One shared width for every section's sub-nav — like the main sidebar,
  // it stays constant across all pages (ignores any per-section key).
  const { width, startResize } = useResizableWidth({
    storageKey: 'legenex_subnav_width',
    defaultWidth: 224, // matches the previous w-56
    min: 176,
    max: 340,
  });

  const { collapsed, toggle } = useCollapsible({ storageKey: 'legenex_subnav_collapsed' });

  return (
    <>
      {/* Mobile rail: below lg only */}
      {items && <SubNavRail items={items} />}

      {/* Desktop collapsed rail: lg and up only */}
      {collapsed && (
        <div className="hidden lg:flex shrink-0 border-r border-border pr-1 pl-1 pt-3 h-full justify-center">
          <button
            onClick={toggle}
            aria-label="Expand menu"
            title="Expand menu"
            className="w-8 h-8 flex items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Desktop vertical column: lg and up only */}
      {!collapsed && (
        <nav
          data-resize-origin
          className="hidden lg:block relative shrink-0 border-r border-border pr-2 h-full"
          style={{ width: `${width}px` }}
        >
          <div className="flex justify-end pr-1 pt-2">
            <button
              onClick={toggle}
              aria-label="Collapse menu"
              title="Collapse menu"
              className="w-7 h-7 flex items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          {children}
          <ResizeHandle onMouseDown={startResize} title="Drag to resize menu" />
        </nav>
      )}
    </>
  );
}