import React from 'react';
import CsvImporter from '@/components/settings/CsvImporter';
import LeadSourcesPanel from '@/components/settings/LeadSourcesPanel';
import SettingsSuppliers from '@/components/settings/SettingsSuppliers';

export default function SettingsDataSources() {
  return (
    <div className="space-y-6">
      <CsvImporter />
      <LeadSourcesPanel />
      <div>
        <div className="text-[15px] font-semibold text-foreground mb-3">Sources</div>
        <SettingsSuppliers />
      </div>
    </div>
  );
}