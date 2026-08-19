/* The downloadable migration diagnostic report.
 *
 * Debugging the migration planner against a real package used to mean: run a
 * preview against a 130+ MB encrypted file, screenshot a narrow scrolling UI,
 * paste the screenshot, and have the agent guess at table values it could not
 * quite read. That is slow, imprecise, and repeats the whole export/preview
 * cycle for every hypothesis. The preview response already carries everything
 * needed to debug the planner without any of that: full reconciliation,
 * every hard blocker, every relationship issue, every collision, every
 * resolved remap and alias, with detailed rows since a real package's blocker
 * count is far below the per-category sample cap. This turns that response
 * into a file the owner can hand over directly.
 *
 * Built as an explicit allowlist rather than "download the whole preview
 * object" on purpose. The preview response is already proven safe by the
 * server (extensive tests assert no credential ever reaches it), but a
 * diagnostic export is a second, independent line of defense: if a future
 * field is ever added to the preview response without the same scrutiny, an
 * allowlist here means it is simply absent from the download rather than
 * silently included. Every field named below is planning metadata: entity
 * names, field names, source and target record ids, counts, reasons, and
 * timing. Nothing here is a decrypted record value, a credential, or the
 * passphrase, and the shape of this function is what keeps that true even as
 * the preview response grows.
 */

const IDENTITY_ATTEMPT_FIELDS = ['field', 'checked_in', 'result', 'candidate_count'];

function pickIdentityAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.map((attempt) => {
    const out = {};
    for (const key of IDENTITY_ATTEMPT_FIELDS) if (key in attempt) out[key] = attempt[key];
    return out;
  });
}

function pickHardBlocker(row) {
  return {
    kind: row.kind,
    entity: row.entity ?? null,
    field: row.field ?? null,
    source_id: row.source_id ?? null,
    detail: row.detail,
    identity_attempts: pickIdentityAttempts(row.identity_attempts),
  };
}

function pickRelationshipIssue(row) {
  return {
    entity: row.entity,
    field: row.field,
    referenced_entity: row.referenced_entity,
    referenced_source_id: row.referenced_source_id,
    status: row.status,
    record_count: row.record_count,
    sample_source_ids: row.sample_source_ids,
    required: row.required,
    severity: row.severity,
    reason: row.reason,
    resolution: row.resolution,
    identity_attempts: pickIdentityAttempts(row.identity_attempts),
  };
}

function pickCollision(row) {
  return {
    entity: row.entity,
    source_id: row.source_id,
    collision_type: row.collision_type,
    natural_key_field: row.natural_key_field ?? null,
    existing_target_id: row.existing_target_id ?? null,
    resolved_target_id: row.resolved_target_id ?? null,
    severity: row.severity,
    disposition: row.disposition,
    detail: row.detail,
  };
}

function pickRemap(row) {
  return {
    entity: row.entity,
    source_id: row.source_id,
    target_id: row.target_id,
    matched_by: row.matched_by,
    natural_key_field: row.natural_key_field ?? null,
  };
}

function pickAliasResolution(row) {
  return {
    entity: row.entity,
    field: row.field,
    referenced_entity: row.referenced_entity,
    referenced_value: row.referenced_value,
    resolved_target_id: row.resolved_target_id,
    natural_key_field: row.natural_key_field,
    via: row.via,
    record_count: row.record_count,
    sample_source_ids: row.sample_source_ids,
  };
}

function pickUnresolvedRecord(row) {
  return {
    entity: row.entity,
    source_id: row.source_id,
    reason: row.reason,
    resolution: row.resolution,
  };
}

function pickExclusion(row) {
  return {
    entity: row.entity,
    scope: row.scope,
    key: row.key,
    count: row.count,
    reason: row.reason,
    rule: row.rule,
    sample_source_ids: row.sample_source_ids,
  };
}

function pickEntityReconciliation(row) {
  return {
    entity: row.entity,
    class: row.class,
    supported: row.supported,
    declared: row.declared,
    exported: row.exported,
    create: row.create,
    update: row.update,
    preserve: row.preserve,
    excluded: row.excluded,
    unresolved: row.unresolved,
    remapped: row.remapped,
    balanced: row.balanced,
  };
}

// The whole point of an allowlist: everything returned here is named
// explicitly, field by field, so nothing the preview response might one day
// add rides along unreviewed.
export function buildDiagnosticReport(preview) {
  if (!preview) return null;
  return {
    generated_at: new Date().toISOString(),
    diagnostic_format: 'dashflo-migration-diagnostic-v1',

    package_version: preview.package_version,
    kind: preview.kind,
    source_application: preview.source_application,
    export_timestamp: preview.export_timestamp,
    planning_ms: preview.planning_ms ?? null,

    entities_present: preview.entities_present,
    entities_missing: preview.entities_missing,
    records_present: preview.records_present,

    can_apply: preview.can_apply,

    reconciliation: preview.reconciliation,
    entity_reconciliation: (preview.entity_reconciliation || []).map(pickEntityReconciliation),

    hard_blocker_count: preview.hard_blocker_count,
    hard_blockers: (preview.hard_blockers || []).map(pickHardBlocker),

    id_collision_count: preview.id_collision_count,
    id_collision_types: preview.id_collision_types,
    id_collisions: (preview.id_collisions || []).map(pickCollision),

    relationship_issue_count: preview.relationship_issue_count,
    relationship_resolved: preview.relationship_resolved,
    relationship_issues: (preview.relationship_issues || []).map(pickRelationshipIssue),

    id_remap_count: preview.id_remap_count,
    resolved_id_remaps: (preview.resolved_id_remaps || []).map(pickRemap),

    relationship_alias_resolution_count: preview.relationship_alias_resolution_count,
    relationship_alias_resolutions: (preview.relationship_alias_resolutions || []).map(pickAliasResolution),

    unresolved_count: preview.unresolved_count,
    unresolved_records: (preview.unresolved_records || []).map(pickUnresolvedRecord),

    explicit_exclusions: (preview.explicit_exclusions || []).map(pickExclusion),

    // Entity name and record count only. No credential value, in any form,
    // is ever in the preview this reads from, and this field never carried
    // one: it names which entities hold credential-bearing fields and how
    // many records, nothing else.
    credential_bearing_entities: preview.credential_bearing_entities,

    declared_count_discrepancies: preview.declared_count_discrepancies,
  };
}

export function diagnosticFileName(preview) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const kind = preview?.kind || 'migration';
  return `dashflo-${kind}-migration-diagnostic-${stamp}.json`;
}

export default { buildDiagnosticReport, diagnosticFileName };
