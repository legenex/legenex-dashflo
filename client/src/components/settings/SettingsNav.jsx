import React from 'react';
import { PulseDot } from '@/components/settings/settingsUi';

export default function SettingsNav({ groups, active, onSelect }) {
  return (
    <nav className="w-[210px] shrink-0">
      <div className="flex flex-col h-full gap-5 sticky top-0">
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.group}>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1.5">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map(item => {
                  const isActive = active === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => onSelect(item.key)}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
                        isActive
                          ? 'bg-primary/10 text-primary font-medium border-l-2 border-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground border-l-2 border-transparent'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Gateway status card */}
        <div className="mt-auto rounded-xl border border-border bg-card p-3">
          <div className="text-[9.5px] font-semibold tracking-[0.11em] uppercase text-muted-foreground/70 mb-1.5">Gateway</div>
          <div className="flex items-center gap-2">
            <PulseDot />
            <span className="text-[12px] font-mono status-sold">api.legenex.com - live</span>
          </div>
        </div>
      </div>
    </nav>
  );
}