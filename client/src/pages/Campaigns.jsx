import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import SettingsVerticals from '@/components/settings/SettingsVerticals';
import CampaignBuyers from '@/components/campaigns/CampaignBuyers';
import CampaignSuppliers from '@/components/campaigns/CampaignSuppliers';
import CampaignBrands from '@/components/campaigns/CampaignBrands';
import CampaignCreateModal from '@/components/campaigns/CampaignCreateModal';

const TABS = ['verticals', 'buyers', 'suppliers', 'brands'];

export default function Campaigns() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') || 'verticals';
  const tab = TABS.includes(raw) ? raw : 'verticals';
  const [createOpen, setCreateOpen] = useState(false);

  const onTabChange = (v) => setParams({ tab: v }, { replace: true });

  return (
    <div>
      <SectionHeader title="Campaigns" subtitle="Verticals, buyers, suppliers, and brands for lead distribution">
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5"><Plus className="w-4 h-4" /> Create Campaign</Button>
      </SectionHeader>

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="verticals">Verticals</TabsTrigger>
          <TabsTrigger value="buyers">Buyers</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="brands">Brands</TabsTrigger>
        </TabsList>
        <TabsContent value="verticals" className="mt-4"><SettingsVerticals /></TabsContent>
        <TabsContent value="buyers" className="mt-4"><CampaignBuyers /></TabsContent>
        <TabsContent value="suppliers" className="mt-4"><CampaignSuppliers /></TabsContent>
        <TabsContent value="brands" className="mt-4"><CampaignBrands /></TabsContent>
      </Tabs>

      <CampaignCreateModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}