import React from 'react';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import ResizeHandle from './ResizeHandle';

// Wraps a section sub-navigation column and makes it horizontally resizable.
// Each section passes a unique storageKey so widths persist independently.
export default function SubNavShell({ children }) {
  // One shared width for every section's sub-nav — like the main sidebar,
  // it stays constant across all pages (ignores any per-section key).
  const { width, startResize } = useResizableWidth({
    storageKey: 'legenex_subnav_width',
    defaultWidth: 224, // matches the previous w-56
    min: 176,
    max: 340,
  });

  return (
    <nav
      data-resize-origin
      className="relative shrink-0 border-r border-border pr-2 h-full"
      style={{ width: `${width}px` }}
    >
      {children}
      <ResizeHandle onMouseDown={startResize} title="Drag to resize menu" />
    </nav>
  );
}