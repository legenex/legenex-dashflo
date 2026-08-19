import React from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';

/* The migration preview report.
 *
 * The summary this replaces said "11 relationship issues and 13 ID collisions"
 * and stopped there, which told the owner that the apply was blocked and
 * nothing whatsoever about why or what to do. Every number below is therefore
 * accompanied by the rows behind it.
 *
 * Three rules hold this together:
 *
 *   Every exported record is accounted for. The reconciliation block is the
 *   arithmetic, and it says out loud whether it balances. Remaps are shown
 *   beside the totals rather than inside them, because a remapped record is
 *   already counted as a create, an update or a preserve and adding it again
 *   would be a misleading total.
 *
 *   Every issue carries its own severity. Resolved automatically, warning, or
 *   hard blocker. Only hard blockers stop the apply, and the panel says which
 *   ones they are rather than leaving the owner to infer it from a count.
 *
 *   Nothing here is a value out of the package. Entity names, field names,
 *   record ids, counts and reasons only. No credential, no decrypted field, no
 *   passphrase, no record content. The server side never puts one in the
 *   report; this side never renders one either.
 *
 * Sections are plain <details> elements so the panel renders identically with
 * no DOM and no client state, which is what makes it testable in this
 * repository's runner.
 */

const SEVERITY = {
  resolved: { label: 'Resolved automatically', className: 'border-primary/40 bg-primary/5 text-primary' },
  warning: { label: 'Warning, review', className: 'border-chart-3/40 bg-chart-3/5 text-chart-3' },
  blocker: { label: 'Hard blocker', className: 'border-destructive/40 bg-destructive/5 text-destructive' },
};

const COLLISION_LABEL = {
  same_logical_record: 'Same logical record',
  dashflo_native_protected: 'DashFlo-native record, protected',
  different_logical_record: 'Different record, same id',
  ambiguous_target_match: 'Ambiguous, two DashFlo matches',
  duplicate_in_package_claims_target: 'Two source records claim one DashFlo record',
  duplicate_in_package: 'Duplicate natural key inside the package',
  remap_target_taken: 'Replacement id already in use',
  target_already_migrated: 'DashFlo record already migrated from elsewhere',
};

const RELATIONSHIP_LABEL = {
  referenced_record_absent: 'Referenced record is in neither the package nor DashFlo',
  referenced_record_excluded: 'Referenced record is excluded by an explicit rule',
  referenced_entity_unsupported: 'Referenced entity is not in the DashFlo schema',
  referenced_record_ambiguous_alias: 'Value matches more than one record by natural key',
};

const number = (value) => Number(value || 0).toLocaleString();

function SeverityBadge({ severity }) {
  const tone = SEVERITY[severity] || SEVERITY.warning;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.className}`}>
      {tone.label}
    </span>
  );
}

function Section({ title, count, tone = 'muted', children, empty }) {
  const tones = { muted: 'text-muted-foreground', primary: 'text-primary', warn: 'text-chart-3', error: 'text-destructive' };
  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[12px] font-medium text-foreground">
        <span>{title}</span>
        <span className={`shrink-0 font-mono text-[12px] ${tones[tone]}`}>{number(count)}</span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        {count > 0 ? children : <p className="text-[12px] text-muted-foreground">{empty}</p>}
      </div>
    </details>
  );
}

function Cell({ children }) {
  return <td className="whitespace-nowrap py-1 pr-3 align-top text-[11px] text-muted-foreground">{children}</td>;
}

function Table({ headers, children }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className="whitespace-nowrap py-1 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Reconciliation({ reconciliation }) {
  if (!reconciliation) return null;
  const rows = [
    ['Exported records', reconciliation.exported_records],
    ['Planned creates', reconciliation.planned_creates],
    ['Planned updates', reconciliation.planned_updates],
    ['Planned preserves', reconciliation.planned_preserves],
    ['Explicit exclusions', reconciliation.explicit_exclusions],
    ['Unresolved', reconciliation.unresolved],
  ];
  return (
    <div data-testid="migration-reconciliation" className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        {reconciliation.balanced
          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          : <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />}
        <span className="text-[12px] font-semibold text-foreground">Reconciliation</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="text-[12px] text-muted-foreground">
            {label} <span className="font-mono text-foreground">{number(value)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {reconciliation.balanced
          ? `Creates plus updates plus preserves plus exclusions plus unresolved equals ${number(reconciliation.exported_records)} exported records. Every record in the package has exactly one disposition.`
          : `${number(reconciliation.unaccounted_records)} exported record(s) have no disposition. Apply stays blocked until the accounting balances.`}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        ID remaps <span className="font-mono text-foreground">{number(reconciliation.id_remaps)}</span>.
        A remap changes which DashFlo id a record is written to. It is already counted as a create, an update or a
        preserve above and is deliberately not added to the total.
        {reconciliation.declared_records !== reconciliation.exported_records
          ? ` The package manifest declares ${number(reconciliation.declared_records)}.`
          : ' The package manifest declares the same number.'}
      </p>
    </div>
  );
}

export function MigrationPreviewReport({ report }) {
  if (!report) return null;
  const reconciliation = report.reconciliation;
  const entityRows = (report.entity_reconciliation || []).filter((row) => row.exported > 0);
  const emptyEntities = (report.entity_reconciliation || []).length - entityRows.length;
  const collisions = report.id_collisions || [];
  const relationships = report.relationship_issues || [];
  const remaps = report.resolved_id_remaps || [];
  const relationshipAliases = report.relationship_alias_resolutions || [];
  const exclusions = report.explicit_exclusions || [];
  const blockers = report.hard_blockers || [];
  const unresolvedRecords = report.unresolved_records || [];

  return (
    <div data-testid="migration-preview-report" className="space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] text-muted-foreground sm:grid-cols-4">
        <div>Version <span className="text-foreground">{report.package_version}</span></div>
        <div>Entities <span className="text-foreground">{report.entities_present?.length || 0}</span></div>
        <div>Records <span className="text-foreground">{number(report.records_present)}</span></div>
        <div>Create <span className="text-foreground">{number(report.records_to_create)}</span></div>
        <div>Update <span className="text-foreground">{number(report.records_to_update)}</span></div>
        <div>Preserve <span className="text-foreground">{number(report.records_to_preserve)}</span></div>
        <div>Conflicts <span className="text-foreground">{number(report.conflict_count)}</span></div>
        <div>Missing entities <span className="text-foreground">{report.entities_missing?.length || 0}</span></div>
      </div>

      <div className="text-[12px] text-muted-foreground">
        Credential-bearing entities found: {Object.keys(report.credential_bearing_entities || {}).join(', ') || 'none'}.
        No credential values are shown, logged, or used to match identity.
      </div>

      <Reconciliation reconciliation={reconciliation} />

      {report.can_apply === false ? (
        <div data-testid="migration-blocked" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-[12px] text-destructive">
            Apply is blocked by {number(report.hard_blocker_count)} hard blocker(s). Resolved matches and warnings below
            do not block it.
          </p>
        </div>
      ) : (
        <div data-testid="migration-ready" className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-[12px] text-primary">
            No hard blockers. Every exported record has a deterministic disposition and every declared relationship
            resolves to a final DashFlo id.
          </p>
        </div>
      )}

      <Section
        title="Hard blockers"
        count={report.hard_blocker_count || 0}
        tone="error"
        empty="No hard blockers. Nothing is preventing the apply."
      >
        <Table headers={['Kind', 'Entity', 'Field', 'Source ID', 'Detail']}>
          {blockers.map((row, index) => (
            <tr key={`${row.kind}-${row.entity}-${row.source_id}-${index}`}>
              <Cell>{row.kind}</Cell>
              <Cell>{row.entity || '-'}</Cell>
              <Cell>{row.field || '-'}</Cell>
              <Cell><span className="font-mono">{row.source_id || '-'}</span></Cell>
              <Cell>{row.detail}</Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="ID collisions"
        count={report.id_collision_count || 0}
        tone="warn"
        empty="No source record id met an existing DashFlo record."
      >
        <Table headers={['Entity', 'Source ID', 'Collision type', 'Existing target', 'Proposed disposition', 'Status']}>
          {collisions.map((row, index) => (
            <tr key={`${row.entity}-${row.source_id}-${index}`}>
              <Cell>{row.entity}</Cell>
              <Cell><span className="font-mono">{row.source_id}</span></Cell>
              <Cell>{COLLISION_LABEL[row.collision_type] || row.collision_type}</Cell>
              <Cell><span className="font-mono">{row.existing_target_id || row.resolved_target_id || '-'}</span></Cell>
              <Cell>{row.disposition}{row.natural_key_field ? ` via ${row.entity}.${row.natural_key_field}` : ''}</Cell>
              <Cell><SeverityBadge severity={row.severity} /></Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Relationship issues"
        count={report.relationship_issue_count || 0}
        tone="warn"
        empty="Every declared reference resolved to a final DashFlo id."
      >
        <Table headers={['Entity', 'Field', 'Referenced entity', 'Referenced source ID', 'Records', 'Reason', 'Status']}>
          {relationships.map((row, index) => (
            <tr key={`${row.entity}-${row.field}-${row.referenced_source_id}-${index}`}>
              <Cell>{row.entity}</Cell>
              <Cell>{row.field}</Cell>
              <Cell>{row.referenced_entity}</Cell>
              <Cell><span className="font-mono">{row.referenced_source_id}</span></Cell>
              <Cell>{number(row.record_count)}</Cell>
              <Cell>{RELATIONSHIP_LABEL[row.status] || row.reason}</Cell>
              <Cell><SeverityBadge severity={row.severity} /></Cell>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          A warning here is a reference the source system already held that resolves nowhere, in a field the DashFlo
          schema does not require. It is carried across unchanged: blanking it would lose data and dropping the record
          would lose more. A blocker is the same thing in a field the schema requires.
        </p>
      </Section>

      <Section
        title="Resolved ID remaps"
        count={report.id_remap_count || 0}
        tone="primary"
        empty="No record needed a different DashFlo id."
      >
        <Table headers={['Entity', 'Source ID', 'Target ID', 'Matched by', 'Natural key']}>
          {remaps.map((row, index) => (
            <tr key={`${row.entity}-${row.source_id}-${index}`}>
              <Cell>{row.entity}</Cell>
              <Cell><span className="font-mono">{row.source_id}</span></Cell>
              <Cell><span className="font-mono">{row.target_id}</span></Cell>
              <Cell>{row.matched_by}</Cell>
              <Cell>{row.natural_key_field ? `${row.entity}.${row.natural_key_field}` : '-'}</Cell>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Every reference to a remapped record anywhere in the package is rewritten to the target id before anything is
          written, and the original source id is kept in the migration provenance record.
        </p>
      </Section>

      <Section
        title="Resolved relationship aliases"
        count={report.relationship_alias_resolution_count || 0}
        tone="primary"
        empty="No reference needed to be resolved by anything other than a record id."
      >
        <Table headers={['Entity', 'Field', 'Referenced entity', 'Referenced value', 'Resolved to', 'Natural key', 'Found in']}>
          {relationshipAliases.map((row, index) => (
            <tr key={`${row.entity}-${row.field}-${row.referenced_value}-${index}`}>
              <Cell>{row.entity}</Cell>
              <Cell>{row.field}</Cell>
              <Cell>{row.referenced_entity}</Cell>
              <Cell><span className="font-mono">{row.referenced_value}</span></Cell>
              <Cell><span className="font-mono">{row.resolved_target_id}</span></Cell>
              <Cell>{row.natural_key_field ? `${row.referenced_entity}.${row.natural_key_field}` : '-'}</Cell>
              <Cell>{row.via === 'dashflo' ? 'DashFlo' : 'this package'}</Cell>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          A row here is a reference whose value was never a record id, in the package or in DashFlo, but matched the
          referenced entity&apos;s own natural key exactly once. The write path stores the resolved record id, not the
          value the package carried.
        </p>
      </Section>

      <Section
        title="Explicit exclusions"
        count={exclusions.length}
        empty="Nothing is excluded from this package."
      >
        <Table headers={['Entity', 'Scope', 'Count', 'Reason', 'Governing rule']}>
          {exclusions.map((row) => (
            <tr key={row.key}>
              <Cell>{row.entity}</Cell>
              <Cell>{row.scope}</Cell>
              <Cell>{number(row.count)}</Cell>
              <Cell>{row.reason}</Cell>
              <Cell>{row.rule}</Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Unresolved records"
        count={report.unresolved_count || 0}
        tone="error"
        empty="Every source record has a deterministic disposition."
      >
        <Table headers={['Entity', 'Source ID', 'Reason', 'What resolves it']}>
          {unresolvedRecords.map((row, index) => (
            <tr key={`${row.entity}-${row.source_id}-${index}`}>
              <Cell>{row.entity}</Cell>
              <Cell><span className="font-mono">{row.source_id || '(missing)'}</span></Cell>
              <Cell>{row.reason}</Cell>
              <Cell>{row.resolution}</Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Reconciliation by entity"
        count={entityRows.length}
        tone="primary"
        empty="The package carries no records."
      >
        <Table headers={['Entity', 'Exported', 'Create', 'Update', 'Preserve', 'Excluded', 'Unresolved', 'Remapped', 'Balanced']}>
          {entityRows.map((row) => (
            <tr key={row.entity}>
              <Cell>{row.entity}</Cell>
              <Cell>{number(row.exported)}</Cell>
              <Cell>{number(row.create)}</Cell>
              <Cell>{number(row.update)}</Cell>
              <Cell>{number(row.preserve)}</Cell>
              <Cell>{number(row.excluded)}</Cell>
              <Cell>{number(row.unresolved)}</Cell>
              <Cell>{number(row.remapped)}</Cell>
              <Cell>{row.balanced ? 'yes' : 'NO'}</Cell>
            </tr>
          ))}
        </Table>
        {emptyEntities > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {emptyEntities} further entit{emptyEntities === 1 ? 'y is' : 'ies are'} declared by the package and exported zero
            records.
          </p>
        )}
      </Section>

      {(report.declared_count_discrepancies || []).length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-chart-3/40 bg-chart-3/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-chart-3" />
          <p className="text-[12px] text-chart-3">
            {report.declared_count_discrepancies.length} entit{report.declared_count_discrepancies.length === 1 ? 'y' : 'ies'} decrypted
            a different number of records than the manifest declared. The decrypted count is authoritative and is what the
            reconciliation above uses.
          </p>
        </div>
      )}
    </div>
  );
}

export default MigrationPreviewReport;
