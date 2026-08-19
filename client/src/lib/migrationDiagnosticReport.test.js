import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport, diagnosticFileName } from './migrationDiagnosticReport';

/* The diagnostic report is what stops the debugging loop this file's header
 * describes: an owner should never again need to screenshot a migration
 * preview and have an agent infer table values from a picture. What is
 * proven here is the other half of that promise -- that handing this file
 * over is always safe, even if the preview response it reads from ever grows
 * a field nobody meant to expose. The allowlist is not a formality if
 * something can still leak through a field it does allow; every test that
 * injects a fake secret puts it on a field this function is SUPPOSED to
 * carry, not an invented one, because that is the only place a leak could
 * actually happen.
 */

const securePreview = (overrides = {}) => ({
  package_version: 'legenex-migration-v1',
  kind: 'owner',
  source_application: 'legenex-dashboard',
  export_timestamp: '2026-08-19T21:20:00.000Z',
  planning_ms: 342.7,
  entities_present: ['Buyer', 'BuyerStateCpl'],
  entities_missing: [],
  records_present: 107,
  can_apply: false,
  reconciliation: {
    exported_records: 107, planned_creates: 93, planned_updates: 0, planned_preserves: 0,
    explicit_exclusions: 0, unresolved: 14, id_remaps: 0, accounted_records: 107,
    unaccounted_records: 0, balanced: true,
  },
  entity_reconciliation: [
    { entity: 'Buyer', class: 'master', supported: true, declared: 13, exported: 13, create: 13, update: 0, preserve: 0, excluded: 0, unresolved: 0, remapped: 0, balanced: true },
  ],
  hard_blocker_count: 1,
  hard_blockers: [{
    kind: 'duplicate_source_id', entity: 'MetaSyncRun', field: null, source_id: 'msr-1',
    detail: 'the same source id appears more than once in this package',
    identity_attempts: [{ field: 'buyer_code', checked_in: 'package', result: 'no_match' }],
  }],
  id_collision_count: 1,
  id_collision_types: { dashflo_native_protected: 1 },
  id_collisions: [{
    entity: 'Buyer', source_id: 'src-buyer', collision_type: 'dashflo_native_protected',
    natural_key_field: 'buyer_code', existing_target_id: 'dashflo-buyer', resolved_target_id: 'dashflo-buyer',
    severity: 'resolved', disposition: 'match the existing DashFlo record', detail: 'natural key matched',
  }],
  relationship_issue_count: 1,
  relationship_resolved: { resolved_in_package: 90, resolved_by_remap: 0, resolved_in_target: 0, resolved_by_natural_key_alias: 3 },
  relationship_issues: [{
    entity: 'BuyerStateCpl', field: 'buyer_id', referenced_entity: 'Buyer', referenced_source_id: 'nothing',
    status: 'referenced_record_absent', record_count: 1, sample_source_ids: ['cpl-1'], required: true,
    severity: 'blocker', reason: 'the referenced Buyer record is in neither the package nor DashFlo',
    resolution: 'Owner decision required.', identity_attempts: [],
  }],
  id_remap_count: 1,
  resolved_id_remaps: [{ entity: 'Buyer', source_id: 'src-buyer', target_id: 'dashflo-buyer', matched_by: 'natural_key', natural_key_field: 'buyer_code' }],
  relationship_alias_resolution_count: 1,
  relationship_alias_resolutions: [{
    entity: 'BuyerStateCpl', field: 'buyer_id', referenced_entity: 'Buyer', referenced_value: 'LB-1',
    resolved_target_id: 'src-buyer', natural_key_field: 'leadbyte_bid', via: 'package', record_count: 3, sample_source_ids: ['cpl-2'],
  }],
  unresolved_count: 14,
  unresolved_records: [{ entity: 'MetaSyncRun', source_id: 'msr-1', reason: 'the same source id appears more than once in this package', resolution: 'Re-export the package.' }],
  explicit_exclusions: [{ entity: 'IntegrationConfig', scope: 'record', key: 'integration_config.meta_oauth_state', count: 1, reason: 'Transient.', rule: 'docs/BASE44-BOUNDARY.md', sample_source_ids: ['cfg-1'] }],
  credential_bearing_entities: { ApiKey: { records: 5, fields: { key: 5 } } },
  declared_count_discrepancies: [],
  ...overrides,
});

describe('migration diagnostic report', () => {
  it('carries every safe field a coding agent needs to debug the planner without a screenshot', () => {
    const diagnostic = buildDiagnosticReport(securePreview());
    expect(diagnostic.reconciliation.exported_records).toBe(107);
    expect(diagnostic.entity_reconciliation[0]).toMatchObject({ entity: 'Buyer', class: 'master' });
    expect(diagnostic.hard_blockers[0].identity_attempts[0]).toMatchObject({ field: 'buyer_code', result: 'no_match' });
    expect(diagnostic.relationship_issues[0].referenced_entity).toBe('Buyer');
    expect(diagnostic.id_collisions[0].collision_type).toBe('dashflo_native_protected');
    expect(diagnostic.resolved_id_remaps[0].target_id).toBe('dashflo-buyer');
    expect(diagnostic.relationship_alias_resolutions[0].natural_key_field).toBe('leadbyte_bid');
    expect(diagnostic.unresolved_records[0].entity).toBe('MetaSyncRun');
    expect(diagnostic.explicit_exclusions[0].rule).toContain('BASE44-BOUNDARY');
    expect(diagnostic.planning_ms).toBe(342.7);
    expect(diagnostic.can_apply).toBe(false);
  });

  it('stamps a diagnostic format and generation time for future compatibility', () => {
    const diagnostic = buildDiagnosticReport(securePreview());
    expect(diagnostic.diagnostic_format).toBe('dashflo-migration-diagnostic-v1');
    expect(new Date(diagnostic.generated_at).toString()).not.toBe('Invalid Date');
  });

  it('returns null rather than an empty object when there is no preview yet', () => {
    expect(buildDiagnosticReport(null)).toBeNull();
    expect(buildDiagnosticReport(undefined)).toBeNull();
  });

  // ── The allowlist actually excludes anything not named ───────────────────

  it('drops a field the preview response might carry that this function never named', () => {
    const diagnostic = buildDiagnosticReport(securePreview({
      passphrase: 'a real migration passphrase',
      run_id: 'internal-run-id-still-fine-to-drop',
    }));
    expect(diagnostic).not.toHaveProperty('passphrase');
    expect(JSON.stringify(diagnostic)).not.toContain('a real migration passphrase');
  });

  it('never carries a credential value even if one is injected into a row the function does read', () => {
    const diagnostic = buildDiagnosticReport(securePreview({
      hard_blockers: [{
        kind: 'relationship', entity: 'MetaConnection', field: 'connection_id', source_id: 'src-saa',
        detail: 'unresolved', identity_attempts: [],
        // Fields this function does not name on a hard blocker row. If the
        // allowlist inside pickHardBlocker were ever loosened to spread the
        // whole row, this is exactly what would leak.
        token: 'do-not-leak-this-meta-token',
        decrypted_value: 'do-not-leak-this-secret-value',
      }],
      id_collisions: [{
        entity: 'ApiKey', source_id: 'src-key', collision_type: 'same_logical_record', severity: 'resolved',
        disposition: 'preserve', detail: 'matched',
        key: 'lgnx_sup_do_not_leak_this_api_key',
      }],
      relationship_issues: [{
        entity: 'SystemKey', field: 'owner_user_id', referenced_entity: 'User', referenced_source_id: 'u1',
        status: 'referenced_record_absent', record_count: 1, sample_source_ids: ['sk-1'], required: true,
        severity: 'blocker', reason: 'absent', resolution: 'x',
        secret: 'do-not-leak-this-system-secret',
      }],
    }));
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain('do-not-leak-this-meta-token');
    expect(serialized).not.toContain('do-not-leak-this-secret-value');
    expect(serialized).not.toContain('lgnx_sup_do_not_leak_this_api_key');
    expect(serialized).not.toContain('do-not-leak-this-system-secret');
  });

  it('never carries a passphrase, a decrypted payload marker, ciphertext, or an authorization header', () => {
    const diagnostic = buildDiagnosticReport(securePreview());
    const serialized = JSON.stringify(diagnostic).toLowerCase();
    for (const forbidden of ['passphrase', 'ciphertext', 'authorization', 'bearer ', 'private_key', 'raw_source']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('bounds identity_attempts to only its documented fields', () => {
    const diagnostic = buildDiagnosticReport(securePreview({
      hard_blockers: [{
        kind: 'relationship', entity: 'BuyerStateCpl', field: 'buyer_id', source_id: 'src-cpl', detail: 'x',
        identity_attempts: [{ field: 'buyer_code', checked_in: 'package', result: 'no_match', extraneous: 'do-not-leak-this-extra-field' }],
      }],
    }));
    expect(JSON.stringify(diagnostic)).not.toContain('do-not-leak-this-extra-field');
  });

  // ── File naming ────────────────────────────────────────────────────────

  it('names the downloaded file by kind and timestamp', () => {
    const name = diagnosticFileName(securePreview());
    expect(name).toMatch(/^dashflo-owner-migration-diagnostic-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  });
});
