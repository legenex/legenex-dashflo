// Regression guard for the Stage 1 LeadByte terminology cleanup and the
// /deliveries -> /webhooks route rename.
//
// This does NOT scan the whole repository: most "leadbyte" occurrences are
// legitimate (the LeadByteConnector entity, its schema fields, the real
// external leadbyte.co endpoint, historical Progress documentation). Blanket
// banning the word repo-wide would either false-positive on those or need an
// exemption list that immediately drifts.
//
// Instead this pins the specific user-facing strings that were removed from
// specific files, and the specific route/label changes that replaced them. If
// either regresses, the operator sees LeadByte branding or a dead route again.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('LeadByte user-facing terminology stays removed', () => {
  const cases = [
    ['client/src/components/leads/LeadEditForm.jsx', ['LeadByte Status', 'LeadByte Lead ID']],
    ['client/src/components/leads/LeadsTable.jsx', ['LB Record Status']],
    ['client/src/lib/columnConfig.js', ['LB Status']],
    ['client/src/lib/leadExportColumns.js', ['LeadByte Status', 'LeadByte Lead ID']],
    ['client/src/components/leads/LeadDetailModal.jsx', ['reported by LeadByte']],
    ['client/src/components/settings/SettingsGeneral.jsx', ['Leadbyte']],
    ['client/src/components/settings/SettingsApiKeys.jsx', ['the LeadByte connector settings', 'LeadByte X_KEY']],
    ['client/src/components/settings/LeadSourcesPanel.jsx', ['and LeadByte,']],
    ['client/src/components/settings/SettingsSuppliers.jsx', ['reaching LeadByte']],
    ['client/src/pages/Notifications.jsx', ['LeadByte returning', 'by LeadByte']],
    ['client/src/pages/Verification.jsx', ['to LeadByte']],
    ['client/src/components/admanager/adPanels.jsx', ['LeadByte sold result']],
    ['client/src/components/campaigns/CampaignBuyers.jsx', ['from LeadByte sold']],
    ['client/src/pages/Overview.jsx', ['Leadbyte ingestion']],
    ['client/src/components/operations/onboarding/onboardingModel.js', ['leadbyte_buyer', 'LeadByte buyer']],
    ['client/src/components/operations/onboarding/OnboardingDialogs.jsx', ['leadbyte_buyer', "Xero, LeadByte,"]],
    ['client/src/components/operations/onboarding/StepRail.jsx', ['leadbyte_buyer', 'LeadByte buyer is created']],
    ['client/src/components/operations/onboarding/OnboardingDrawer.jsx', ['Xero or LeadByte.']],
    ['client/src/components/operations/buyers/BuyerProfileTab.jsx', ['LeadByte BID', 'label="Buyer Code"']],
  ];

  for (const [file, forbidden] of cases) {
    it(`${file} no longer contains removed LeadByte copy`, () => {
      const src = read(file);
      for (const needle of forbidden) {
        expect(src, `expected ${file} not to contain ${JSON.stringify(needle)}`).not.toContain(needle);
      }
    });
  }
});

describe('Canonical Buyer ID replaces Buyer Code / LeadByte BID on the profile', () => {
  const src = read('client/src/components/operations/buyers/BuyerProfileTab.jsx');

  it('shows a "Buyer ID" field bound to buyer_code', () => {
    expect(src).toContain('label="Buyer ID"');
    expect(src).toContain('buyer.buyer_code');
  });

  it('groups fields under Identity, Billing & Delivery Policy, Contact and Notes', () => {
    for (const heading of ['Identity', 'Billing &amp; Delivery Policy', 'Contact', 'Notes']) {
      expect(src).toContain(`<SectionLabel>${heading}</SectionLabel>`);
    }
  });

  it('places Contact Name inside the Contact section, after Billing & Delivery Policy', () => {
    const billingIdx = src.indexOf('Billing &amp; Delivery Policy');
    const contactHeadingIdx = src.indexOf('<SectionLabel>Contact</SectionLabel>');
    const contactNameIdx = src.indexOf('label="Contact Name"');
    expect(billingIdx).toBeGreaterThan(-1);
    expect(contactHeadingIdx).toBeGreaterThan(billingIdx);
    expect(contactNameIdx).toBeGreaterThan(contactHeadingIdx);
  });

  it('no longer submits leadbyte_bid from the profile save', () => {
    const saveCallStart = src.indexOf('api.entities.Buyer.update');
    const saveCallEnd = src.indexOf('});', saveCallStart);
    const savePayload = src.slice(saveCallStart, saveCallEnd);
    expect(savePayload).not.toContain('leadbyte_bid');
  });
});

describe('The buyer list table shows a Buyer ID column, not a bare Code column', () => {
  it('buyerColumns.js labels buyer_code as Buyer ID', () => {
    const src = read('client/src/components/operations/buyers/buyerColumns.js');
    expect(src).toContain("key: 'buyer_code', header: 'Buyer ID'");
  });
});

describe('/webhooks is canonical and /deliveries is a permanent redirect', () => {
  const routes = read('client/src/AppRoutes.jsx');

  it('mounts the Webhooks page at /webhooks', () => {
    expect(routes).toMatch(/<Route\s+path="\/webhooks"\s+element=\{<Webhooks \/>\}\s*\/>/);
  });

  it('redirects /deliveries to /webhooks instead of rendering a page', () => {
    expect(routes).toMatch(/<Route\s+path="\/deliveries"\s+element=\{<Navigate to="\/webhooks" replace \/>\}\s*\/>/);
    expect(routes).not.toContain('element={<Deliveries />}');
  });

  it('imports the page module from pages/Webhooks, not pages/Deliveries', () => {
    expect(routes).toContain("import('@/pages/Webhooks')");
    expect(routes).not.toContain("import('@/pages/Deliveries')");
  });
});

describe('Lead Distribution nav and permission map point at /webhooks', () => {
  it('DistributionNav links Webhooks to /webhooks', () => {
    const src = read('client/src/components/distribution/DistributionNav.jsx');
    expect(src).toMatch(/label: 'Webhooks', path: '\/webhooks'/);
  });

  it('the top nav config gates the Webhooks link on dist_webhooks', () => {
    const src = read('client/src/components/layout/navConfig.js');
    expect(src).toContain("{ label: 'Webhooks', path: '/webhooks', icon: Webhook, permKey: 'dist_webhooks' }");
  });

  it('permissions.js maps /webhooks (not /deliveries) to dist_webhooks', () => {
    const src = read('client/src/lib/permissions.js');
    expect(src).toContain("'/webhooks': 'dist_webhooks'");
    expect(src).not.toMatch(/'\/deliveries':\s*'dist_webhooks'/);
  });
});

describe('The webhook test-delivery function is generically named', () => {
  it('server function file is testWebhookDelivery.js exporting that name', () => {
    const src = read('server/src/functions/testWebhookDelivery.js');
    expect(src).toContain('export default async function testWebhookDelivery(ctx)');
    expect(fs.existsSync(path.join(repoRoot, 'server/src/functions/testLeadByteConnector.js'))).toBe(false);
  });

  it('the webhook editor calls the renamed function', () => {
    const src = read('client/src/components/settings/WebhookDeliverySettings.jsx');
    expect(src).toContain("from '@/functions/testWebhookDelivery'");
    expect(src).toContain('testWebhookDelivery({ connector_id:');
  });
});
