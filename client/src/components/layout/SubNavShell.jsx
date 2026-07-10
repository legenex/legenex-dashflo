import React from 'react';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import ResizeHandle from './ResizeHandle';
import SubNavRail from './SubNavRail';

// Wraps a section sub-navigation column and makes it horizontally resizable.
//
// At lg and up: renders the resizable vertical column exactly as before.
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

  return (
    <>
      {/* Mobile rail: below lg only */}
      {items && <SubNavRail items={items} />}

      {/* Desktop vertical column: lg and up only */}
      <nav
        data-resize-origin
        className="hidden lg:block relative shrink-0 border-r border-border pr-2 h-full"
        style={{ width: `${width}px` }}
      >
        {children}
        <ResizeHandle onMouseDown={startResize} title="Drag to resize menu" />
      </nav>
    </>
  );
}