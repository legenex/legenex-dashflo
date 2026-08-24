import React from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import WebhookDeliverySettings from '@/components/settings/WebhookDeliverySettings';

export default function Webhooks() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <SectionHeader title="Webhooks" subtitle="Lead delivery configuration and payload templates" />
      <div className="flex-1 min-h-0 overflow-y-auto space-y-8">
        <WebhookDeliverySettings />
      </div>
    </div>
  );
}