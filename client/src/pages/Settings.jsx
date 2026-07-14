import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePermissions } from '@/lib/AuthContext';
import SectionShell from '@/components/layout/SectionShell';
import SettingsNav from '@/components/settings/SettingsNav';
import SettingsShell from '@/components/settings/SettingsShell';
import SettingsErrorBoundary from '@/components/settings/SettingsErrorBoundary';
import SettingsGeneral from '@/components/settings/SettingsGeneral';
import SettingsUsers from '@/components/settings/SettingsUsers';
import SettingsIntegrations from '@/components/settings/SettingsIntegrations';
import SettingsDataSources from '@/components/settings/SettingsDataSources';
import SettingsCustomFields from '@/components/settings/SettingsCustomFields';
import SettingsFieldMapping from '@/components/settings/SettingsFieldMapping';
import SettingsApiKeys from '@/components/settings/SettingsApiKeys';
import SettingsInboundWebhooks from '@/components/settings/SettingsInboundWebhooks';
import SettingsKnowledgeBase from '@/components/settings/SettingsKnowledgeBase';
import SettingsBilling from '@/components/settings/SettingsBilling';
import SettingsIgnoreList from '@/components/settings/SettingsIgnoreList';
import SettingsProfile from '@/components/settings/SettingsProfile';
import ErrorLogs from '@/pages/ErrorLogs';

// NAV is built inside the component so the admin-only Inbound Webhooks item can
// be omitted for non-admins.
function buildNav(isAdmin) {
  return [
    { group: 'Account', items: [
      { key: 'profile', label: 'Profile' },
      { key: 'general', label: 'General' },
      { key: 'users', label: 'Users and Roles' },
    ] },
    { group: 'Data', items: [
      { key: 'integrations', label: 'Integrations' },
      { key: 'data-sources', label: 'Data Sources' },
      { key: 'fields', label: 'Custom Fields' },
      { key: 'field-mapping', label: 'Field Mapping' },
      { key: 'apikeys', label: 'API Keys' },
      ...(isAdmin ? [{ key: 'inbound-webhooks', label: 'Inbound Webhooks' }] : []),
      { key: 'errors', label: 'Error Logs' },
      { key: 'knowledge', label: 'Knowledge Base' },
      { key: 'billing', label: 'Billing and Plan' },
    ] },
  ];
}

// tab key -> { title (page name in header), subtitle, panel }
const PANELS = {
  profile: { title: 'Profile', subtitle: 'Your account details.', node: <SettingsProfile /> },
  general: { title: 'General', subtitle: 'Workspace defaults.', node: <SettingsGeneral /> },
  users: { title: 'Users and Roles', subtitle: 'Team members and permissions.', node: <SettingsUsers /> },
  integrations: { title: 'Integrations', subtitle: 'Connected services and providers.', node: <SettingsIntegrations /> },
  'data-sources': { title: 'Data Sources', subtitle: 'Inbound lead sources.', node: <SettingsDataSources /> },
  fields: { title: 'Custom Fields', subtitle: 'The lead field catalog.', node: <SettingsCustomFields /> },
  'field-mapping': { title: 'Field Mapping', subtitle: 'Incoming key to field mapping.', node: <SettingsFieldMapping /> },
  apikeys: { title: 'API Keys', subtitle: 'Gateway and supplier keys.', node: <SettingsApiKeys /> },
  'inbound-webhooks': { title: 'Inbound Webhooks', subtitle: 'LeadByte outcome webhook routes.', node: <SettingsInboundWebhooks />, adminOnly: true },
  errors: { title: 'Error Logs', subtitle: 'Pipeline failures and reasons.', node: <ErrorLogs embedded /> },
  knowledge: { title: 'Knowledge Base', subtitle: 'Docs the AI assistant reads.', node: <SettingsKnowledgeBase /> },
  billing: { title: 'Billing and Plan', subtitle: 'Plan and billing.', node: <SettingsBilling /> },
  adaptive: { title: 'Ignore List', subtitle: 'Fields excluded from cataloging.', node: <SettingsIgnoreList /> },
};

const VALID = Object.keys(PANELS);

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { realRole } = usePermissions();
  const isAdmin = realRole === 'admin' || realRole === 'owner';
  const raw = searchParams.get('tab') || 'general';
  let tab = VALID.includes(raw) ? raw : 'general';
  // Fail closed: a non-admin reaching an admin-only tab directly is sent to General.
  if (PANELS[tab]?.adminOnly && !isAdmin) tab = 'general';
  const setTab = (v) => setSearchParams({ tab: v }, { replace: true });

  const panel = PANELS[tab];
  const nav = buildNav(isAdmin);

  return (
    <SectionShell nav={<SettingsNav groups={nav} active={tab} onSelect={setTab} />}>
      <SettingsShell title={panel.title} subtitle={panel.subtitle}>
        <SettingsErrorBoundary key={tab}>
          {panel.node}
        </SettingsErrorBoundary>
      </SettingsShell>
    </SectionShell>
  );
}