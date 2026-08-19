import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* Legacy identity alias resolution.
 *
 * The real package previews with zero hard blockers on identity (all 13 ID
 * collisions resolve automatically) but eight relationship references still
 * fail: required fields whose target entity is fully accounted for in the
 * plan, yet the reference does not resolve. The parent records are not
 * missing, and the planner already rewrites a reference onto a remapped
 * target when the reference holds the parent's own source id.
 *
 * What is proven elsewhere (migrationCryptoContract.test.js's naming-pattern
 * assertion) is that several reference fields are named identically to the
 * target entity's own natural key: `RouteGroup.campaign_id`,
 * `ContractVersion.campaign_id`, `BuyerCplRule.campaign_id` and
 * `LeadSource.campaign_id` all share their name with `NATURAL_KEYS.Campaign`.
 * That is exactly the shape of naming that produced the one proven case of
 * this in the codebase: `lib/buyerIdentity.js` exists because
 * `Lead.buyer_id`, across legacy imports and LeadByte feedback matching,
 * carries a buyer CODE rather than the Buyer record id its own schema
 * description claims.
 *
 * Whether any specific field in the real package repeats that pattern cannot
 * be proven without the owner's passphrase, so this is not a fix for eight
 * named rows. It is a general fallback: a reference that is not a record id
 * anyone recognises is tried once more against the referenced entity's own
 * declared natural key, using the exact matching rules already trusted for
 * record identity, and only when it decides that unambiguously. What follows
 * proves that fallback holds the same guarantees as ordinary identity
 * resolution: it never overrides an id match, it never invents a natural key,
 * and it fails closed the moment more than one record could be meant.
 */

const TEST_DB = 'dashflo_migration_relationship_alias_test';
const MAINTENANCE_DB = 'postgres';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

const pg = (await import('pg')).default;

async function canReachPostgres() {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const reachable = await canReachPostgres();

async function maintenance(sql) {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

const OWNER = { id: 'dashflo-owner', email: 'owner@dashflo.test', base_role: 'owner' };

async function tableCounts(pool) {
  const { rows } = await pool.query(`
    SELECT relname AS table_name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'
     ORDER BY relname`);
  const counts = {};
  for (const row of rows) {
    const { rows: [count] } = await pool.query(`SELECT count(*)::int AS n FROM ${row.table_name}`);
    counts[row.table_name] = count.n;
  }
  return counts;
}

describe.skipIf(!reachable)('legacy identity alias in relationship resolution', () => {
  let pool;
  let runMigrationImport;
  let normalizeMigrationBundle;
  let buildMigrationPlan;
  let planRelationships;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    const { ensureBase44SyncSchema } = await import('../src/db/base44SyncSchema.js');
    await ensureBase44SyncSchema();
    const { ensureMigrationImportSchema } = await import('../src/db/migrationImportSchema.js');
    await ensureMigrationImportSchema();
    ({ runMigrationImport, normalizeMigrationBundle, buildMigrationPlan } = await import('../src/lib/migrationImport.js'));
    ({ planRelationships } = await import('../src/lib/migrationPlan.js'));
  });

  afterAll(async () => {
    await pool?.end?.().catch(() => {});
    if (reachable) {
      await maintenance(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`);
      await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    }
  });

  beforeEach(async () => {
    const { rows } = await pool.query(`
      SELECT relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'`);
    for (const row of rows) await pool.query(`TRUNCATE ${row.table_name}`);
    await pool.query('TRUNCATE base44_record_provenance');
  });

  const ordinary = (entities) => ({
    manifest: {
      bundle_version: 1,
      source_app: 'legenex-dashboard',
      exported_at: '2026-08-10T00:00:00.000Z',
      counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
    },
    entities,
  });

  const preview = (entities) => runMigrationImport({ kind: 'ordinary', mode: 'preview', bundle: ordinary(entities), user: OWNER });
  const apply = (entities) => runMigrationImport({ kind: 'ordinary', mode: 'apply', bundle: ordinary(entities), user: OWNER, confirmed: true });

  // ── Resolved via the package's own natural key ───────────────────────────

  it('resolves a reference whose value is the target entity\'s natural key, not its record id', async () => {
    // RouteGroup.campaign_id is required and is literally named after
    // NATURAL_KEYS.Campaign. Here it holds "C1", the Campaign's own code, not
    // the Campaign's source record id -- the exact shape of the Lead.buyer_id
    // precedent, on a different field.
    const report = await preview({
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'Camp', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(true);
    expect(report.relationship_issue_count).toBe(0);
    expect(report.relationship_resolved.resolved_by_natural_key_alias).toBe(1);
    expect(report.relationship_alias_resolutions).toContainEqual(expect.objectContaining({
      entity: 'RouteGroup', field: 'campaign_id', referenced_entity: 'Campaign',
      referenced_value: 'C1', resolved_target_id: 'src-campaign', natural_key_field: 'campaign_id', via: 'package',
    }));
  });

  it('applies that alias resolution and writes the record id, not the code, into the stored reference', async () => {
    await apply({
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'Camp', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    const stored = (await pool.query("SELECT data->>'campaign_id' AS v FROM e_route_group WHERE id = 'src-group'")).rows[0].v;
    expect(stored).toBe('src-campaign');
    expect(stored).not.toBe('C1');
  });

  // ── Resolved via DashFlo's own natural key ───────────────────────────────

  it('resolves a reference against an alias that only exists in DashFlo, not in the package', async () => {
    await pool.query(
      "INSERT INTO e_campaign (id, data, updated_date) VALUES ('dashflo-campaign', '{\"campaign_id\":\"C1\",\"name\":\"Camp\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    const report = await preview({
      RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(true);
    expect(report.relationship_alias_resolutions[0]).toMatchObject({
      referenced_value: 'C1', resolved_target_id: 'dashflo-campaign', via: 'dashflo',
    });
  });

  // ── Never overrides an id match ──────────────────────────────────────────

  it('never tries the alias when the reference already resolves as a record id', async () => {
    // A record whose own id happens to collide with an unrelated record's
    // natural key value must not be redirected by it. Id resolution always
    // wins; the alias is reached only after id resolution has already failed.
    const report = await preview({
      Campaign: [
        { id: 'C1', campaign_id: 'REAL-CODE', name: 'Real target', updated_date: '2026-08-10T00:00:00.000Z' },
        { id: 'src-other-campaign', campaign_id: 'C1', name: 'Coincidental code', updated_date: '2026-08-10T00:00:00.000Z' },
      ],
      RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(true);
    // Resolved as an ordinary in-package id match, not as an alias.
    expect(report.relationship_resolved.resolved_in_package).toBe(1);
    expect(report.relationship_alias_resolutions).toHaveLength(0);
  });

  // ── Fails closed on ambiguity ─────────────────────────────────────────────

  it('fails closed when the alias value matches more than one package record', async () => {
    const report = await preview({
      Buyer: [
        { id: 'src-buyer-a', buyer_code: 'DUP', company_name: 'A', updated_date: '2026-08-10T00:00:00.000Z' },
        { id: 'src-buyer-b', buyer_code: 'DUP', company_name: 'B', updated_date: '2026-08-10T00:00:00.000Z' },
      ],
      Delivery: [{ id: 'src-delivery', buyer_id: 'DUP', name: 'D', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply, 'an ambiguous alias must block a required reference').toBe(false);
    expect(report.relationship_issues[0]).toMatchObject({
      entity: 'Delivery', field: 'buyer_id', referenced_entity: 'Buyer',
      status: 'referenced_record_ambiguous_alias', severity: 'blocker',
    });
    expect(report.relationship_issues[0].reason).toContain('more than one Buyer record');
    // Both buyers are still created, and so is the Delivery: an unresolved
    // required relationship blocks Apply, but it does not revoke the record's
    // own disposition. Dropping the record to clear the blocker is exactly
    // what this planner exists to never do.
    expect(report.reconciliation.planned_creates).toBe(3);
  });

  it('fails closed when the alias value matches more than one DashFlo record', async () => {
    // Two independent DashFlo suppliers that happen to share a sid is not a
    // state the identity layer would itself produce, but the relationship
    // resolver must not assume that can never happen and pick one anyway.
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('a', '{\"sid\":\"DUP\"}'::jsonb)");
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('b', '{\"sid\":\"DUP\"}'::jsonb)");

    const report = await preview({
      SupplierSource: [{ id: 'src-source', supplier_id: 'DUP', source_code: 'X', pricing_model: 'none', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(false);
    expect(report.relationship_issues[0]).toMatchObject({ status: 'referenced_record_ambiguous_alias', severity: 'blocker' });
  });

  // ── No alias for an entity with no natural key ───────────────────────────

  it('gives no alias fallback to an entity with no declared natural key, and reports the reference honestly', async () => {
    // RouteMember.route_group_id targets RouteGroup, which has no natural key.
    // A value that resolves to nothing must stay an honest blocker rather than
    // matching on an invented field such as name.
    const report = await preview({
      RouteMember: [{ id: 'src-member', route_group_id: 'group-that-does-not-exist', buyer_id: 'buyer-that-does-not-exist', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(false);
    const fields = report.relationship_issues.map((i) => i.field).sort();
    expect(fields).toEqual(['buyer_id', 'route_group_id']);
    for (const issue of report.relationship_issues) {
      expect(issue.status).toBe('referenced_record_absent');
      expect(issue.severity).toBe('blocker');
    }
  });

  // ── MetaConnection: natural key fixes identity and the downstream reference together ──

  it('resolves a MetaConnection collision by its external account id, and the dependent reference follows the remap', async () => {
    await pool.query(
      "INSERT INTO e_meta_connection (id, data, updated_date) VALUES ('dashflo-meta', '{\"name\":\"Meta\",\"auth_type\":\"system_user\",\"connected_account_id\":\"1234567890\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    const report = await preview({
      MetaConnection: [{ id: 'src-meta', name: 'Meta renamed', auth_type: 'system_user', connected_account_id: '1234567890', updated_date: '2026-08-10T00:00:00.000Z' }],
      Supplier: [{ id: 'src-supplier', sid: 'S1', name: 'Sup', updated_date: '2026-08-10T00:00:00.000Z' }],
      SupplierAdAccount: [{ id: 'src-saa', supplier_id: 'src-supplier', connection_id: 'src-meta', ad_account_id: 'act_1', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(true);
    expect(report.id_collisions[0]).toMatchObject({
      entity: 'MetaConnection', natural_key_field: 'connected_account_id', resolved_target_id: 'dashflo-meta',
    });
    // Resolved as an ordinary remap, not an alias: the child correctly held the
    // parent's own source id, so once the parent's identity resolves by natural
    // key, the existing remap machinery already carries the reference across.
    expect(report.relationship_resolved.resolved_by_remap).toBe(1);
    expect(report.relationship_alias_resolutions).toHaveLength(0);
  });

  it('never uses MetaConnection.token as its natural key', async () => {
    const { NATURAL_KEYS, MIGRATION_SECRETS_EXPECTED, SECRET_FIELDS } = await import('../src/functions/systemTransfer.generated.js');
    expect(NATURAL_KEYS.MetaConnection).toBe('connected_account_id');
    expect(MIGRATION_SECRETS_EXPECTED.MetaConnection).toContain('token');
    expect(NATURAL_KEYS.MetaConnection).not.toBe('token');
    expect(SECRET_FIELDS.MetaConnection).not.toContain(NATURAL_KEYS.MetaConnection);
  });

  // ── Invariants that must survive the new resolution path ─────────────────

  it('does not mutate the source bundle while resolving aliases', async () => {
    const bundle = ordinary({
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'Camp', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    const before = JSON.parse(JSON.stringify(bundle));
    const normalized = normalizeMigrationBundle({ kind: 'ordinary', bundle });
    await buildMigrationPlan(normalized);
    expect(bundle).toEqual(before);
    expect(normalized.entities.RouteGroup[0].campaign_id).toBe('C1');
  });

  it('keeps reconciliation balanced when references resolve through an alias', async () => {
    await pool.query(
      "INSERT INTO e_campaign (id, data, updated_date) VALUES ('dashflo-campaign', '{\"campaign_id\":\"C1\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    const report = await preview({
      RouteGroup: [
        { id: 'src-group-1', campaign_id: 'C1', name: 'G1', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' },
        { id: 'src-group-2', campaign_id: 'C1', name: 'G2', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' },
      ],
    });
    const r = report.reconciliation;
    expect(r.exported_records).toBe(2);
    expect(r.planned_creates + r.planned_updates + r.planned_preserves + r.explicit_exclusions + r.unresolved)
      .toBe(r.exported_records);
    expect(r.balanced).toBe(true);
    // Two source records shared the one alias resolution's grouping key, and
    // both counted.
    expect(report.relationship_resolved.resolved_by_natural_key_alias).toBe(2);
  });

  it('carries no credential value into an alias resolution or a relationship issue', async () => {
    await pool.query(
      "INSERT INTO e_meta_connection (id, data) VALUES ('dashflo-meta', '{\"connected_account_id\":\"1234567890\",\"token\":\"do-not-leak-this-token\"}'::jsonb)",
    );
    const report = await preview({
      SupplierAdAccount: [{ id: 'src-saa', connection_id: '1234567890', ad_account_id: 'act_1', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    expect(JSON.stringify(report)).not.toContain('do-not-leak-this-token');
  });

  it('preview remains read only when resolving through an alias', async () => {
    await pool.query(
      "INSERT INTO e_campaign (id, data) VALUES ('dashflo-campaign', '{\"campaign_id\":\"C1\"}'::jsonb)",
    );
    const before = await tableCounts(pool);
    await runMigrationImport({
      kind: 'ordinary', mode: 'preview',
      bundle: ordinary({ RouteGroup: [{ id: 'src-group', campaign_id: 'C1', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }] }),
      user: OWNER,
    });
    expect(await tableCounts(pool)).toEqual(before);
  });

  it('does not resolve an alias for a package record whose identity itself is still unresolved', async () => {
    // A relationship must never point at a record the planner refused to give
    // a target id to, alias or not.
    await pool.query("INSERT INTO e_buyer (id, data) VALUES ('a', '{\"buyer_code\":\"DUP\"}'::jsonb)");
    await pool.query("INSERT INTO e_buyer (id, data) VALUES ('b', '{\"buyer_code\":\"DUP\"}'::jsonb)");

    const report = await preview({
      Buyer: [{ id: 'src-buyer', buyer_code: 'DUP', company_name: 'C', updated_date: '2026-08-10T00:00:00.000Z' }],
      Delivery: [{ id: 'src-delivery', buyer_id: 'src-buyer', name: 'D', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(false);
    expect(report.unresolved_count).toBe(1);
    // The Buyer itself is the ambiguous target match; the Delivery reference
    // used the source id directly and correctly finds no answer, since that
    // source record has no target id to offer.
    expect(report.hard_blockers.some((b) => b.kind === 'id_collision' && b.entity === 'Buyer')).toBe(true);
  });
});
