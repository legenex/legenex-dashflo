import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Megaphone, Send, Zap, ChevronRight } from 'lucide-react';
import SubNavShell from '@/components/layout/SubNavShell';

const ITEMS = [
  { label: 'Dashboard', path: '/distribution', icon: LayoutDashboard },
  { label: 'Campaigns', path: '/campaigns', icon: Megaphone, children: [
    { label: 'Verticals', tab: 'verticals' },
    { label: 'Buyers', tab: 'buyers' },
    { label: 'Suppliers', tab: 'suppliers' },
    { label: 'Brands', tab: 'brands' },
  ] },
  { label: 'Deliveries', path: '/deliveries', icon: Send },
  { label: 'Conversion Events', path: '/conversion-events', icon: Zap },
];

const linkClass = (active) =>
  `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
    active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
  }`;

// Left sub-sidebar for the Lead Distribution section.
export default function DistributionNav() {
  const location = useLocation();
  const onCampaigns = location.pathname === '/campaigns';
  const activeTab = new URLSearchParams(location.search).get('tab') || 'verticals';

  // Auto-expand the Campaigns dropdown while on the Campaigns page.
  const [campaignsOpen, setCampaignsOpen] = useState(onCampaigns);
  useEffect(() => { if (onCampaigns) setCampaignsOpen(true); }, [onCampaigns]);

  return (
    <SubNavShell>
      <div className="space-y-0.5">
        {ITEMS.map(item => {
          const Icon = item.icon;
          const active = location.pathname === item.path;

          if (item.children) {
            return (
              <div key={item.path}>
                <div className={`${linkClass(active)} pr-2`}>
                  <Link to={item.path} className="flex items-center gap-2.5 flex-1 min-w-0">
                    <Icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setCampaignsOpen(o => !o); }}
                    className="shrink-0 p-0.5 -mr-1 rounded hover:bg-accent/60"
                    aria-label={campaignsOpen ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight className={`w-3.5 h-3.5 transition-transform ${campaignsOpen ? 'rotate-90' : ''}`} />
                  </button>
                </div>
                {campaignsOpen && (
                  <div className="mt-0.5 ml-4 pl-2.5 border-l border-border space-y-0.5">
                    {item.children.map(child => {
                      const childActive = onCampaigns && activeTab === child.tab;
                      return (
                        <Link
                          key={child.tab}
                          to={`${item.path}?tab=${child.tab}`}
                          className={`block px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                            childActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                          }`}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link key={item.path} to={item.path} className={linkClass(active)}>
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </SubNavShell>
  );
}