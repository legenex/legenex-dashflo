import React from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import WebhookDeliverySettings from '@/components/settings/WebhookDeliverySettings';
import NativeDeliveriesList from '@/components/delivery/NativeDeliveriesList';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Canonical webhook/delivery configuration screen.
//
// Native Deliveries is the default and primary surface: buyer-owned
// Delivery/SubDelivery records, edited with the same canonical editor used
// from Operations > Buyers > Buyer Deliveries - one record, edited in either
// place, always in sync because there is only one place it is stored.
//
// Legacy Relay is what actually sends every real lead in production today
// (LeadByteConnector, via DashFlo's own LeadByte reseller relationship at
// legenex.leadbyte.co). It stays available and untouched here, kept
// separate rather than mixed invisibly with native records, until a
// deliberate, separately-approved cutover moves real traffic onto the
// native path.
export default function Webhooks() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <SectionHeader title="Webhooks" subtitle="Lead delivery configuration and payload templates" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Tabs defaultValue="native" className="w-full">
          <TabsList>
            <TabsTrigger value="native">Native Deliveries</TabsTrigger>
            <TabsTrigger value="legacy">Legacy Relay</TabsTrigger>
          </TabsList>
          <TabsContent value="native" className="pt-4">
            <NativeDeliveriesList />
          </TabsContent>
          <TabsContent value="legacy" className="pt-4 space-y-8">
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground">
                This is the connector that actually delivers real leads today. It forwards to DashFlo&apos;s LeadByte
                reseller relationship, which performs its own buyer routing and reports outcomes back. It is
                unaffected by anything configured under Native Deliveries.
              </p>
            </div>
            <WebhookDeliverySettings />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}