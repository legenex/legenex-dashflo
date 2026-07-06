import React from 'react';

export default function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-[22px] font-bold text-foreground tracking-tight">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  );
}