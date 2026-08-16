import React, { useState } from 'react';
import SettingsSystemKeys from '@/components/settings/SettingsSystemKeys';
import SettingsApiKeys from '@/components/settings/SettingsApiKeys';
import SettingsBuyerKeys from '@/components/settings/SettingsBuyerKeys';

const CATEGORIES = [
  { key: 'system', label: 'System Keys' },
  { key: 'supplier', label: 'Supplier Keys' },
  { key: 'buyer', label: 'Buyer Keys' },
];

export default function SettingsApiKeysHub() {
  const [category, setCategory] = useState('system');
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
        {CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setCategory(item.key)}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${category === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {category === 'system' && <SettingsSystemKeys />}
      {category === 'supplier' && <SettingsApiKeys />}
      {category === 'buyer' && <SettingsBuyerKeys />}
    </div>
  );
}
