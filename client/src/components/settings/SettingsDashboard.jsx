import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  Plug, KeyRound, Users, Database, ListTree, Shuffle,
  Webhook, AlertTriangle, ShieldCheck, BookOpen,
} from 'lucide-react';
import ToolTile from '@/components/tools/ToolTile';

// Settings landing page: a status board rather than a wall of links.
//
// Every other section (Operations, Tools, Lead Distribution) opens on a
// dashboard that answers "what is connected and what needs attention" before
// asking you to pick a sub-page. Settings opened straight onto a form, so
// nothing surfaced a disconnected integration or a pile of unresolved errors
// until you happened to click into it.
//
// Counts are real, loaded from the same entities the panels themselves use.
export default function SettingsDashboard({ onSelect, isAdmin }) {
  const opts = { staleTime: 60_000 };
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.entities.User.list(), ...opts });
  const { data: apiKeys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: () => api.entities.ApiKey.list('-created_date', 200), ...opts });
  const { data: integrations = [] } = useQuery({ queryKey: ['integration-configs'], queryFn: () => api.entities.IntegrationConfig.list(), ...opts });
  const { data: errors = [] } = useQuery({ queryKey: ['error-logs'], queryFn: () => api.entities.ErrorLog.list('-created_date', 500), ...opts });
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.entities.Supplier.list(), ...opts });
  const { data: customFields = [] } = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.entities.CustomField.list('-created_date', 500), ...opts });
  const { data: mappings = [] } = useQuery({ queryKey: ['field-mappings'], queryFn: () => api.entities.FieldMapping.list('-created_date', 500), ...opts });
  const { data: docs = [] } = useQuery({ queryKey: ['kb-docs'], queryFn: () => api.entities.KnowledgeDoc.list('-created_date', 200), ...opts });
  const { data: audits = [] } = useQuery({ queryKey: ['audit-runs'], queryFn: () => api.entities.AuditRun.list('-created_date', 20), ...opts });

  const isConnected = (i) => i.connected || i.enabled || i.status === 'connected';
  const connected = integrations.filter(isConnected);
  const disconnected = integrations.length - connected.length;
  const unresolved = errors.filter((e) => !e.resolved).length;
  const activeSuppliers = suppliers.filter((s) => s.active).length;
  const lastAudit = audits[0];

  // A tile turns amber when it needs attention, red when something is broken.
  const tiles = [
    {
      key: 'integrations', icon: Plug, title: 'Integrations',
      description: 'Connected services and providers.',
      stats: [
        { label: 'Connected', value: `${connected.length} of ${integrations.length}` },
        { label: 'Hint', value: disconnected > 0 ? `${disconnected} not connected` : 'all live' },
      ],
      status: integrations.length === 0 ? 'warn' : disconnected > 0 ? 'warn' : 'ok',
    },
    {
      key: 'data-sources', icon: Database, title: 'Data Sources',
      description: 'Inbound lead sources and CSV import.',
      stats: [
        { label: 'Suppliers', value: String(suppliers.length) },
        { label: 'Hint', value: `${activeSuppliers} active` },
      ],
      status: activeSuppliers === 0 ? 'warn' : 'ok',
    },
    {
      key: 'apikeys', icon: KeyRound, title: 'API Keys',
      description: 'Gateway and supplier keys.',
      stats: [
        { label: 'Keys', value: String(apiKeys.length) },
        { label: 'Hint', value: apiKeys.length === 0 ? 'no keys issued' : 'gateway live' },
      ],
      status: apiKeys.length === 0 ? 'warn' : 'ok',
    },
    {
      key: 'users', icon: Users, title: 'Users and Roles',
      description: 'Team members and permissions.',
      stats: [
        { label: 'Users', value: String(users.length) },
        { label: 'Hint', value: users.length === 1 ? 'single operator' : 'team access' },
      ],
      status: 'ok',
    },
    {
      key: 'fields', icon: ListTree, title: 'Custom Fields',
      description: 'The lead field catalog.',
      stats: [
        { label: 'Fields', value: String(customFields.length) },
        { label: 'Hint', value: customFields.length === 0 ? 'nothing catalogued' : 'catalogued' },
      ],
      status: 'ok',
    },
    {
      key: 'field-mapping', icon: Shuffle, title: 'Field Mapping',
      description: 'Incoming key to field mapping.',
      stats: [
        { label: 'Mappings', value: String(mappings.length) },
        { label: 'Hint', value: mappings.length === 0 ? 'unmapped intake' : 'mapped' },
      ],
      status: mappings.length === 0 ? 'warn' : 'ok',
    },
    {
      key: 'errors', icon: AlertTriangle, title: 'Error Logs',
      description: 'Pipeline failures and reasons.',
      stats: [
        { label: 'Unresolved', value: String(unresolved) },
        { label: 'Hint', value: unresolved > 0 ? 'needs review' : 'clean' },
      ],
      status: unresolved > 0 ? 'error' : 'ok',
    },
    {
      key: 'audits', icon: ShieldCheck, title: 'Audits',
      description: 'Runtime probes and findings.',
      stats: [
        { label: 'Runs', value: String(audits.length) },
        { label: 'Hint', value: lastAudit ? 'last run recorded' : 'never run' },
      ],
      status: lastAudit ? 'ok' : 'warn',
    },
    {
      key: 'knowledge', icon: BookOpen, title: 'Knowledge Base',
      description: 'Docs the AI assistant reads.',
      stats: [
        { label: 'Docs', value: String(docs.length) },
        { label: 'Hint', value: docs.length === 0 ? 'assistant unfed' : 'indexed' },
      ],
      status: docs.length === 0 ? 'warn' : 'ok',
    },
    ...(isAdmin ? [{
      key: 'inbound-webhooks', icon: Webhook, title: 'Inbound Webhooks',
      description: 'LeadByte outcome webhook routes.',
      stats: [
        { label: 'Access', value: 'Admin' },
        { label: 'Hint', value: 'outcome routing' },
      ],
      status: 'ok',
    }] : []),
  ];

  return (
    <div>
      {/* Attention strip: only shown when something actually needs doing, so it
          stays meaningful rather than becoming decoration. */}
      {(unresolved > 0 || disconnected > 0) && (
        <div className="mb-5 rounded-[10px] border border-status-unsold bg-status-unsold p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 status-unsold shrink-0 mt-0.5" />
            <div className="text-[13px] text-muted-foreground">
              <p className="font-semibold text-foreground">Needs attention</p>
              <ul className="mt-1 space-y-0.5">
                {unresolved > 0 && (
                  <li>
                    <button onClick={() => onSelect('errors')} className="underline underline-offset-2 hover:text-foreground">
                      {unresolved} unresolved pipeline error{unresolved === 1 ? '' : 's'}
                    </button>
                  </li>
                )}
                {disconnected > 0 && (
                  <li>
                    <button onClick={() => onSelect('integrations')} className="underline underline-offset-2 hover:text-foreground">
                      {disconnected} integration{disconnected === 1 ? '' : 's'} not connected
                    </button>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ToolTile is a Link. It navigates to /settings?tab=..., which the page
          reads, so no click handler is needed and we avoid nesting a link
          inside a button. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {tiles.map((t) => (
          <ToolTile
            key={t.key}
            to={`/settings?tab=${t.key}`}
            icon={t.icon}
            title={t.title}
            description={t.description}
            stats={t.stats}
            status={t.status}
          />
        ))}
      </div>
    </div>
  );
}
