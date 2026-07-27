import React from 'react';
import CsvImporter from '@/components/settings/CsvImporter';
import DuplicateScanner from '@/components/settings/DuplicateScanner';
import LeadSourcesPanel from '@/components/settings/LeadSourcesPanel';
import SettingsSuppliers from '@/components/settings/SettingsSuppliers';
import MetaAppCredentialsCard from '@/components/settings/MetaAppCredentialsCard';

export default function SettingsDataSources() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-[15px] font-semibold text-foreground mb-3">Credentials</div>
        <MetaAppCredentialsCard />
      </div>
      <CsvImporter />
      {/* Sits with the importer because that is where duplicates originate. */}
      <DuplicateScanner />
      <LeadSourcesPanel />
      <div>
        <div className="text-[15px] font-semibold text-foreground mb-3">Sources</div>
        <SettingsSuppliers />
      </div>
    </div>
  );
}
