import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MigrationPreviewReport } from '@/components/settings/MigrationPreviewReport';

/* The preview report surface.
 *
 * What this replaced told the owner "Apply is blocked: 0 schema issue(s), 11
 * relationship issue(s), and 13 ID collision(s)" and nothing else. There was no
 * way to see which records, which fields, or what would resolve them, so the
 * only available next step was to guess.
 *
 * The rules held here: every blocker is legible, resolved work is visible as
 * resolved rather than as an alarm, the reconciliation arithmetic is on screen
 * with a verdict on whether it balances, and nothing that could be a credential
 * ever reaches the markup.
 */

const render = (report) => renderToStaticMarkup(<MigrationPreviewReport report={report} />);

const baseReport = (overrides = {}) => ({
  package_version: 'legenex-migration-v1',
  kind: 'owner',
  entities_present: ['Supplier', 'Buyer'],
  entities_missing: [],
  records_present: 12,
  records_to_create: 9,
  records_to_update: 2,
  records_to_preserve: 0,
  conflict_count: 0,
  credential_bearing_entities: { ApiKey: { records: 5, fields: { key: 5 } } },
  reconciliation: {
    declared_records: 12,
    exported_records: 12,
    planned_creates: 9,
    planned_updates: 2,
    planned_preserves: 0,
    explicit_exclusions: 1,
    unresolved: 0,
    id_remaps: 2,
    accounted_records: 12,
    unaccounted_records: 0,
    balanced: true,
  },
  entity_reconciliation: [
    { entity: 'Lead', supported: true, declared: 1942, exported: 1942, create: 1942, update: 0, preserve: 0, excluded: 0, unresolved: 0, remapped: 0, balanced: true },
    { entity: 'Vertical', supported: true, declared: 0, exported: 0, create: 0, update: 0, preserve: 0, excluded: 0, unresolved: 0, remapped: 0, balanced: true },
  ],
  explicit_exclusions: [{
    key: 'integration_config.meta_oauth_state',
    entity: 'IntegrationConfig',
    scope: 'record',
    count: 1,
    reason: 'Transient Meta OAuth handshake state.',
    rule: 'docs/BASE44-BOUNDARY.md: the encrypted migration export drops meta_oauth_state records.',
  }],
  resolved_id_remaps: [{ entity: 'Supplier', source_id: 'src-supplier-1', target_id: 'dashflo-supplier', matched_by: 'natural_key', natural_key_field: 'sid' }],
  id_remap_count: 1,
  id_collisions: [{
    entity: 'Supplier',
    source_id: 'src-supplier-1',
    collision_type: 'dashflo_native_protected',
    natural_key_field: 'sid',
    existing_target_id: 'dashflo-supplier',
    resolved_target_id: 'dashflo-supplier',
    severity: 'resolved',
    disposition: 'match the existing DashFlo record',
    detail: 'natural key matched an existing DashFlo record held under a different id',
  }],
  id_collision_count: 1,
  id_collision_types: { dashflo_native_protected: 1 },
  relationship_issues: [{
    entity: 'RouteGroup',
    field: 'config_version_id',
    referenced_entity: 'RouteConfigVersion',
    referenced_source_id: 'version-that-is-gone',
    status: 'referenced_record_absent',
    record_count: 2,
    sample_source_ids: ['src-group-1'],
    required: false,
    severity: 'warning',
    reason: 'the referenced RouteConfigVersion record is in neither the package nor DashFlo',
    resolution: 'Carried across unchanged.',
  }],
  relationship_issue_count: 1,
  relationship_resolved: { resolved_in_package: 30, resolved_by_remap: 4, resolved_in_target: 0, resolved_by_natural_key_alias: 0 },
  relationship_alias_resolutions: [],
  relationship_alias_resolution_count: 0,
  unresolved_records: [],
  unresolved_count: 0,
  hard_blockers: [],
  hard_blocker_count: 0,
  declared_count_discrepancies: [],
  can_apply: true,
  ...overrides,
});

describe('migration preview report', () => {
  it('renders the reconciliation totals', () => {
    const html = render(baseReport());
    expect(html).toContain('data-testid="migration-reconciliation"');
    expect(html).toContain('Exported records');
    expect(html).toContain('Planned creates');
    expect(html).toContain('Planned updates');
    expect(html).toContain('Planned preserves');
    expect(html).toContain('Explicit exclusions');
    expect(html).toContain('Unresolved');
    expect(html).toContain('ID remaps');
  });

  it('says out loud whether the accounting balances', () => {
    expect(render(baseReport())).toContain('Every record in the package has exactly one disposition');
    const broken = baseReport({
      reconciliation: { ...baseReport().reconciliation, balanced: false, unaccounted_records: 7 },
      can_apply: false,
      hard_blocker_count: 1,
      hard_blockers: [{ kind: 'reconciliation', entity: null, detail: '7 exported record(s) have no disposition' }],
    });
    const html = render(broken);
    expect(html).toContain('have no disposition');
    expect(html).toContain('Apply stays blocked');
  });

  it('does not add remaps into the disposition total', () => {
    const html = render(baseReport());
    expect(html).toContain('deliberately not added to the total');
  });

  it('renders relationship issue detail rather than only a count', () => {
    const html = render(baseReport());
    expect(html).toContain('RouteGroup');
    expect(html).toContain('config_version_id');
    expect(html).toContain('RouteConfigVersion');
    expect(html).toContain('version-that-is-gone');
    expect(html).toContain('Referenced record is in neither the package nor DashFlo');
  });

  it('renders collision detail with its type, target and proposed disposition', () => {
    const html = render(baseReport());
    expect(html).toContain('src-supplier-1');
    expect(html).toContain('DashFlo-native record, protected');
    expect(html).toContain('dashflo-supplier');
    expect(html).toContain('match the existing DashFlo record');
    expect(html).toContain('via Supplier.sid');
  });

  it('distinguishes resolved, warning and hard blocker', () => {
    const html = render(baseReport({
      can_apply: false,
      hard_blocker_count: 1,
      hard_blockers: [{ kind: 'relationship', entity: 'BuyerStateCpl', field: 'buyer_id', source_id: 'src-cpl-1', detail: 'the referenced Buyer record is in neither the package nor DashFlo' }],
      relationship_issues: [
        ...baseReport().relationship_issues,
        {
          entity: 'BuyerStateCpl', field: 'buyer_id', referenced_entity: 'Buyer', referenced_source_id: 'gone',
          status: 'referenced_record_absent', record_count: 1, sample_source_ids: ['src-cpl-1'], required: true,
          severity: 'blocker', reason: 'absent', resolution: 'Owner decision required.',
        },
      ],
      relationship_issue_count: 2,
    }));
    expect(html).toContain('Resolved automatically');
    expect(html).toContain('Warning, review');
    expect(html).toContain('Hard blocker');
  });

  it('labels an ambiguous alias distinctly from a plain missing reference', () => {
    const html = render(baseReport({
      can_apply: false,
      relationship_issues: [{
        entity: 'Delivery', field: 'buyer_id', referenced_entity: 'Buyer', referenced_source_id: 'DUP',
        status: 'referenced_record_ambiguous_alias', record_count: 1, sample_source_ids: ['src-delivery'], required: true,
        severity: 'blocker', reason: 'this value is not a Buyer id, and more than one Buyer record shares it as Buyer.buyer_code',
        resolution: 'Owner decision required.',
      }],
      relationship_issue_count: 1,
    }));
    expect(html).toContain('Value matches more than one record by natural key');
  });

  it('shows the blocked banner only when a hard blocker exists', () => {
    expect(render(baseReport())).toContain('data-testid="migration-ready"');
    expect(render(baseReport())).not.toContain('data-testid="migration-blocked"');
    const blocked = render(baseReport({ can_apply: false, hard_blocker_count: 3 }));
    expect(blocked).toContain('data-testid="migration-blocked"');
    expect(blocked).not.toContain('data-testid="migration-ready"');
    expect(blocked).toContain('3');
    // A resolved match or a warning is never described as the thing blocking it.
    expect(blocked).toContain('do not block it');
  });

  it('renders entity level accounting for operational data', () => {
    const html = render(baseReport());
    expect(html).toContain('Reconciliation by entity');
    expect(html).toContain('Lead');
    expect(html).toContain('1,942');
    // Entities that exported nothing are summarised rather than listed.
    expect(html).toContain('1 further entity is declared by the package and exported zero');
  });

  it('renders every exclusion with a reason and a governing rule', () => {
    const html = render(baseReport());
    expect(html).toContain('Explicit exclusions');
    expect(html).toContain('IntegrationConfig');
    expect(html).toContain('Transient Meta OAuth handshake state.');
    expect(html).toContain('BASE44-BOUNDARY.md');
  });

  it('renders resolved remaps with their source and target ids', () => {
    const html = render(baseReport());
    expect(html).toContain('Resolved ID remaps');
    expect(html).toContain('natural_key');
    expect(html).toContain('kept in the migration provenance record');
  });

  it('renders resolved relationship aliases as auditable, distinct from an ordinary remap', () => {
    const html = render(baseReport({
      relationship_alias_resolutions: [{
        entity: 'RouteGroup', field: 'campaign_id', referenced_entity: 'Campaign',
        referenced_value: 'C1', resolved_target_id: 'dashflo-campaign-1', natural_key_field: 'campaign_id', via: 'dashflo',
        record_count: 3, sample_source_ids: ['src-group-1'],
      }],
      relationship_alias_resolution_count: 1,
    }));
    expect(html).toContain('Resolved relationship aliases');
    expect(html).toContain('C1');
    expect(html).toContain('dashflo-campaign-1');
    expect(html).toContain('Campaign.campaign_id');
    expect(html).toContain('DashFlo');
    expect(html).toContain('never a record id');
  });

  it('shows zero resolved relationship aliases as its own explicit state', () => {
    const html = render(baseReport());
    expect(html).toContain('No reference needed to be resolved by anything other than a record id.');
  });

  it('never renders a credential value, a passphrase or record content', () => {
    // A report that had somehow acquired sensitive values must not surface them
    // even so. The server side is what keeps them out; this is the second line.
    const html = render(baseReport({
      id_collisions: [{
        entity: 'ApiKey',
        source_id: 'src-key-1',
        collision_type: 'same_logical_record',
        natural_key_field: null,
        existing_target_id: 'dashflo-key',
        resolved_target_id: 'dashflo-key',
        severity: 'resolved',
        disposition: 'match the existing DashFlo record',
        detail: 'natural key matched',
        key: 'lgnx_sup_should_never_render',
        secret: 'meta-app-secret-value',
      }],
      relationship_alias_resolutions: [{
        entity: 'SupplierAdAccount', field: 'connection_id', referenced_entity: 'MetaConnection',
        referenced_value: '1234567890', resolved_target_id: 'dashflo-meta', natural_key_field: 'connected_account_id', via: 'dashflo',
        record_count: 1, sample_source_ids: ['src-saa'], token: 'do-not-leak-this-meta-token',
      }],
      relationship_alias_resolution_count: 1,
      passphrase: 'the migration passphrase',
    }));
    expect(html).not.toContain('lgnx_sup_should_never_render');
    expect(html).not.toContain('meta-app-secret-value');
    expect(html).not.toContain('the migration passphrase');
    expect(html).not.toContain('do-not-leak-this-meta-token');
    // The credential summary names entities and counts only.
    expect(html).toContain('Credential-bearing entities found: ApiKey');
    expect(html).toContain('No credential values are shown, logged, or used to match identity');
  });

  it('renders nothing at all without a report', () => {
    expect(renderToStaticMarkup(<MigrationPreviewReport report={null} />)).toBe('');
  });
});
