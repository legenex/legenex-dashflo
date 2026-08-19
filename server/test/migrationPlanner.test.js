import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* The owner migration planner.
 *
 * The production preview that motivated this file completed successfully and
 * then refused to apply: 141,860 records, every one of them a create, zero
 * updates, zero preserves, and 24 blockers that had no resolution path. Eleven
 * were relationship issues reported as a target entity and an id with no
 * indication of which record held the reference; thirteen were natural keys
 * that matched a DashFlo record under a different id, reported as "ID
 * collisions" and treated as fatal.
 *
 * Neither was a data problem. The importer had no concept of a target id that
 * differs from a source id, so a natural key match had nowhere to go, and
 * relationship validation ran against raw source ids and therefore could never
 * see a match even if one had been made. Removing the collision check would not
 * have helped: nothing in the write path consulted a natural key either, so the
 * apply would have inserted a second account for the owner.
 *
 * What follows holds the properties that make the fix safe rather than merely
 * unblocking, in the order the planner decides them. It runs against a real
 * disposable PostgreSQL, because identity resolution is a set of database
 * queries and a double would agree with itself while the real thing behaved
 * differently.
 */

const TEST_DB = 'dashflo_migration_planner_test';
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
const PASSPHRASE = 'planner regression passphrase 2026';

// Every entity table, so "nothing was written" is checked against the whole
// database rather than the tables a test remembered to name.
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

describe.skipIf(!reachable)('owner migration planner', () => {
  let pool;
  let runMigrationImport;
  let buildMigrationPlan;
  let normalizeMigrationBundle;
  let derivedTargetId;
  let cryptoSpec;
  let migrationOrder;

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
    ({ runMigrationImport, buildMigrationPlan, normalizeMigrationBundle } = await import('../src/lib/migrationImport.js'));
    ({ derivedTargetId } = await import('../src/lib/migrationPlan.js'));
    const catalog = await import('../src/functions/systemTransfer.generated.js');
    cryptoSpec = catalog.MIGRATION_CRYPTO;
    migrationOrder = catalog.MIGRATION_ENTITY_ORDER;
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

  // An ordinary bundle is enough for everything except credential carriage, and
  // it keeps the fixtures readable. The encrypted transport is proven in
  // migrationImportRoundTrip and migrationCryptoContract.
  const ordinary = (entities) => ({
    manifest: {
      bundle_version: 1,
      source_app: 'legenex-dashboard',
      exported_at: '2026-08-10T00:00:00.000Z',
      counts: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, v.length])),
    },
    entities,
  });

  // A genuine encrypted owner package, sealed with the shipped parameters. A
  // static fixture would drift from the exporter; this cannot.
  function ownerPackage(entities) {
    const salt = crypto.randomBytes(cryptoSpec.salt_bytes);
    const key = crypto.pbkdf2Sync(Buffer.from(PASSPHRASE, 'utf8'), salt, cryptoSpec.iterations, cryptoSpec.key_bits / 8, 'sha256');
    const chunks = [];
    for (const entity of migrationOrder) {
      const rows = entities[entity];
      if (!rows?.length) continue;
      const plaintext = Buffer.from(JSON.stringify({ entity, offset: 0, records: rows }), 'utf8');
      const iv = crypto.randomBytes(cryptoSpec.iv_bytes);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      chunks.push({
        entity,
        offset: 0,
        records: rows.length,
        iv: iv.toString('base64'),
        ciphertext: sealed.toString('base64'),
        plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      });
    }
    return {
      format: cryptoSpec.format,
      source_app: 'legenex-dashboard',
      target: 'dashflo',
      exported_at: '2026-08-10T00:00:00.000Z',
      crypto: { ...cryptoSpec, salt: salt.toString('base64') },
      counts: Object.fromEntries(migrationOrder.map((name) => [name, entities[name]?.length || 0])),
      chunks,
    };
  }

  const preview = (entities) => runMigrationImport({ kind: 'ordinary', mode: 'preview', bundle: ordinary(entities), user: OWNER });
  const apply = (entities) => runMigrationImport({ kind: 'ordinary', mode: 'apply', bundle: ordinary(entities), user: OWNER, confirmed: true });

  const supplier = (id, sid, extra = {}) => ({ id, sid, name: `Supplier ${sid}`, updated_date: '2026-08-10T00:00:00.000Z', ...extra });
  const buyer = (id, code, extra = {}) => ({ id, buyer_code: code, company_name: `Buyer ${code}`, updated_date: '2026-08-10T00:00:00.000Z', ...extra });

  // ── Planning order ────────────────────────────────────────────────────────

  it('resolves relationships against final target ids whatever order the package lists entities in', async () => {
    // The child is listed before its parent. The old validator walked the
    // package in the order it arrived and compared raw source ids, so a package
    // written child-first could report a parent that was right there.
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    const report = await preview({
      SupplierSource: [{ id: 'src-source', supplier_id: 'src-supplier', source_code: 'LGNX-DS', pricing_model: 'none', updated_date: '2026-08-10T00:00:00.000Z' }],
      Supplier: [supplier('src-supplier', 'LGNX')],
    });

    expect(report.can_apply).toBe(true);
    expect(report.relationship_issue_count).toBe(0);
    // The parent moved onto the DashFlo record, and the child followed it.
    expect(report.relationship_resolved.resolved_by_remap).toBe(1);
  });

  // ── Natural key identity ──────────────────────────────────────────────────

  it('resolves a colliding id through a natural key rather than blocking on it', async () => {
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Legenex\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    const report = await preview({ Supplier: [supplier('src-supplier', 'LGNX')] });

    expect(report.can_apply).toBe(true);
    expect(report.records_to_create).toBe(0);
    expect(report.id_collisions[0]).toMatchObject({
      entity: 'Supplier',
      source_id: 'src-supplier',
      natural_key_field: 'sid',
      resolved_target_id: 'dashflo-supplier',
      severity: 'resolved',
    });
  });

  it('preserves a matched record whose values already agree', async () => {
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Supplier LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    const report = await preview({ Supplier: [supplier('src-supplier', 'LGNX')] });
    expect(report.records_to_preserve).toBe(1);
    expect(report.records_to_update).toBe(0);
    expect(report.reconciliation.balanced).toBe(true);
  });

  it('reports an allowed field change on a matched record as an update', async () => {
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Old name\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    const report = await preview({ Supplier: [supplier('src-supplier', 'LGNX')] });
    expect(report.records_to_update).toBe(1);
    expect(report.records_to_preserve).toBe(0);
  });

  it('gives a different logical record under a taken id a new deterministic DashFlo id', async () => {
    // Same id, different natural key: two unrelated records, and neither may
    // overwrite the other.
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('shared-id', '{\"sid\":\"NATIVE\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    const report = await preview({ Supplier: [supplier('shared-id', 'FROMSOURCE')] });
    const allocated = derivedTargetId('Supplier', 'shared-id');

    expect(report.can_apply).toBe(true);
    expect(report.resolved_id_remaps).toContainEqual(expect.objectContaining({
      entity: 'Supplier', source_id: 'shared-id', target_id: allocated, matched_by: 'allocated',
    }));
    // Stable across preview and apply, and across reruns. A random id would be
    // neither, and the preview could not promise it.
    expect(derivedTargetId('Supplier', 'shared-id')).toBe(allocated);
    expect(allocated).toMatch(/^[0-9a-f]{24}$/);
    expect(allocated).not.toBe('shared-id');
  });

  it('rewrites a dependent reference onto the remapped target id', async () => {
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    await apply({
      Supplier: [supplier('src-supplier', 'LGNX')],
      SupplierSource: [{ id: 'src-source', supplier_id: 'src-supplier', source_code: 'LGNX-DS', pricing_model: 'none', updated_date: '2026-08-10T00:00:00.000Z' }],
      ApiKey: [{ id: 'src-key', supplier_id: 'src-supplier', name: 'k', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect((await pool.query("SELECT data->>'supplier_id' AS v FROM e_supplier_source WHERE id = 'src-source'")).rows[0].v)
      .toBe('dashflo-supplier');
    expect((await pool.query("SELECT data->>'supplier_id' AS v FROM e_api_key WHERE id = 'src-key'")).rows[0].v)
      .toBe('dashflo-supplier');
  });

  it('carries a remap through a multi-level dependency chain and through a JSON id array', async () => {
    // Buyer -> Delivery -> SubDelivery -> RouteMember, plus Campaign.supplier_ids
    // as the array shaped reference. Rewriting only the record that collided
    // would leave every one of these pointing at an id that is not there.
    await pool.query(
      "INSERT INTO e_buyer (id, data, updated_date) VALUES ('dashflo-buyer', '{\"buyer_code\":\"B1\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    await pool.query(
      "INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    await apply({
      Supplier: [supplier('src-supplier', 'LGNX')],
      Buyer: [buyer('src-buyer', 'B1')],
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'C', supplier_ids: JSON.stringify(['src-supplier']), updated_date: '2026-08-10T00:00:00.000Z' }],
      Delivery: [{ id: 'src-delivery', name: 'D', buyer_id: 'src-buyer', updated_date: '2026-08-10T00:00:00.000Z' }],
      SubDelivery: [{ id: 'src-sub', delivery_id: 'src-delivery', name: 'S', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteGroup: [{ id: 'src-group', campaign_id: 'src-campaign', name: 'G', method: 'priority', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteMember: [{ id: 'src-member', route_group_id: 'src-group', buyer_id: 'src-buyer', sub_delivery_id: 'src-sub', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect((await pool.query("SELECT data->>'buyer_id' AS v FROM e_delivery WHERE id = 'src-delivery'")).rows[0].v).toBe('dashflo-buyer');
    expect((await pool.query("SELECT data->>'buyer_id' AS v FROM e_route_member WHERE id = 'src-member'")).rows[0].v).toBe('dashflo-buyer');
    // Two levels down, and the link that was never remapped still points at the
    // record that was never remapped.
    expect((await pool.query("SELECT data->>'delivery_id' AS v FROM e_sub_delivery WHERE id = 'src-sub'")).rows[0].v).toBe('src-delivery');
    expect((await pool.query("SELECT data->>'sub_delivery_id' AS v FROM e_route_member WHERE id = 'src-member'")).rows[0].v).toBe('src-sub');
    expect(JSON.parse((await pool.query("SELECT data->>'supplier_ids' AS v FROM e_campaign WHERE id = 'src-campaign'")).rows[0].v))
      .toEqual(['dashflo-supplier']);
  });

  it('fails closed when two DashFlo records answer to one natural key', async () => {
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('a', '{\"sid\":\"LGNX\"}'::jsonb)");
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('b', '{\"sid\":\"LGNX\"}'::jsonb)");

    const report = await preview({ Supplier: [supplier('src-supplier', 'LGNX')] });
    expect(report.can_apply).toBe(false);
    expect(report.id_collisions[0]).toMatchObject({ collision_type: 'ambiguous_target_match', severity: 'blocker' });
    expect(report.reconciliation.unresolved).toBe(1);
  });

  // ── Relationships ─────────────────────────────────────────────────────────

  it('keeps an unresolvable required reference as a hard blocker and names the record holding it', async () => {
    const report = await preview({
      BuyerStateCpl: [{ id: 'src-cpl', buyer_id: 'buyer-that-does-not-exist', state: 'TX', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply).toBe(false);
    expect(report.relationship_issues[0]).toMatchObject({
      entity: 'BuyerStateCpl',
      field: 'buyer_id',
      referenced_entity: 'Buyer',
      referenced_source_id: 'buyer-that-does-not-exist',
      status: 'referenced_record_absent',
      severity: 'blocker',
    });
    expect(report.relationship_issues[0].sample_source_ids).toContain('src-cpl');
  });

  it('carries an unresolvable optional reference across as a warning rather than dropping the record', async () => {
    const report = await preview({
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'C', updated_date: '2026-08-10T00:00:00.000Z' }],
      RouteGroup: [{ id: 'src-group', campaign_id: 'src-campaign', name: 'G', method: 'priority', config_version_id: 'version-that-is-gone', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.can_apply, 'an optional dangling pointer the source already had is not a reason to refuse the migration').toBe(true);
    expect(report.relationship_issues[0]).toMatchObject({ field: 'config_version_id', severity: 'warning' });
    // The record is still fully accounted for. Nothing is dropped to clear a
    // warning.
    expect(report.reconciliation.planned_creates).toBe(2);
    expect(report.reconciliation.balanced).toBe(true);
  });

  it('resolves a reference that only DashFlo holds', async () => {
    await pool.query("INSERT INTO e_buyer (id, data) VALUES ('already-here', '{\"buyer_code\":\"Z9\"}'::jsonb)");
    const report = await preview({
      BuyerStateCpl: [{ id: 'src-cpl', buyer_id: 'already-here', state: 'TX', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_issue_count).toBe(0);
    expect(report.relationship_resolved.resolved_in_target).toBe(1);
  });

  it('names the governing rule when a reference points at a record an exclusion removed', async () => {
    const report = await preview({
      IntegrationConfig: [{ id: 'oauth-state', name: 'meta_oauth_state', config: 'transient', updated_date: '2026-08-10T00:00:00.000Z' }],
      Campaign: [{ id: 'src-campaign', campaign_id: 'C1', name: 'C', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    expect(report.explicit_exclusions).toHaveLength(1);
    expect(report.explicit_exclusions[0]).toMatchObject({
      entity: 'IntegrationConfig',
      scope: 'record',
      count: 1,
    });
    expect(report.explicit_exclusions[0].reason.length).toBeGreaterThan(20);
    expect(report.explicit_exclusions[0].rule).toContain('BASE44-BOUNDARY');
  });

  // ── Reconciliation ────────────────────────────────────────────────────────

  it('accounts for every exported record exactly once', async () => {
    await pool.query("INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Supplier LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')");
    await pool.query("INSERT INTO e_buyer (id, data, updated_date) VALUES ('dashflo-buyer', '{\"buyer_code\":\"B1\",\"company_name\":\"Old\"}'::jsonb, '2026-08-01T00:00:00Z')");

    const report = await preview({
      Supplier: [supplier('src-supplier', 'LGNX'), supplier('src-supplier-2', 'ACME')],
      Buyer: [buyer('src-buyer', 'B1')],
      IntegrationConfig: [{ id: 'oauth-state', name: 'meta_oauth_state', config: 'x', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    const r = report.reconciliation;
    expect(r.exported_records).toBe(4);
    expect(r.planned_creates + r.planned_updates + r.planned_preserves + r.explicit_exclusions + r.unresolved)
      .toBe(r.exported_records);
    expect(r.balanced).toBe(true);
    expect(r.unaccounted_records).toBe(0);
    // One preserve, one update, one create, one exclusion.
    expect(r).toMatchObject({ planned_creates: 1, planned_updates: 1, planned_preserves: 1, explicit_exclusions: 1 });
    // A remap is an attribute of those, never a sixth bucket.
    expect(r.id_remaps).toBe(2);
  });

  it('reconciles every entity in the manifest, including the ones that exported nothing', async () => {
    const bundle = ownerPackage({ Supplier: [supplier('src-supplier', 'LGNX')] });
    const report = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle, passphrase: PASSPHRASE, user: OWNER });

    expect(report.entities_present).toHaveLength(93);
    expect(report.entity_reconciliation).toHaveLength(93);
    expect(report.entity_reconciliation.every((row) => row.balanced)).toBe(true);
    const declared = report.entity_reconciliation.reduce((sum, row) => sum + row.exported, 0);
    expect(declared).toBe(report.reconciliation.exported_records);
  });

  it('reports preview counts that the apply then produces', async () => {
    await pool.query("INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Old\"}'::jsonb, '2026-08-01T00:00:00Z')");
    const entities = {
      Supplier: [supplier('src-supplier', 'LGNX'), supplier('src-supplier-2', 'ACME')],
      IntegrationConfig: [{ id: 'oauth-state', name: 'meta_oauth_state', config: 'x', updated_date: '2026-08-10T00:00:00.000Z' }],
    };

    const report = await preview(entities);
    const applied = await apply(entities);

    expect(applied.applied.created).toBe(report.reconciliation.planned_creates);
    expect(applied.applied.updated).toBe(report.reconciliation.planned_updates);
    expect(applied.applied.preserved).toBe(report.reconciliation.planned_preserves);
    expect(applied.applied.skipped).toBe(report.reconciliation.explicit_exclusions);
    expect(applied.applied.remapped).toBe(report.reconciliation.id_remaps);
  });

  it('refuses to apply while any record is unresolved', async () => {
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('a', '{\"sid\":\"LGNX\"}'::jsonb)");
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('b', '{\"sid\":\"LGNX\"}'::jsonb)");
    const before = await tableCounts(pool);

    await expect(apply({ Supplier: [supplier('src-supplier', 'LGNX')] })).rejects.toThrow(/cannot be applied/i);
    expect(await tableCounts(pool)).toEqual(before);
  });

  it('does not let a resolved collision or a resolved relationship block the apply', async () => {
    await pool.query("INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')");
    const report = await preview({
      Supplier: [supplier('src-supplier', 'LGNX')],
      SupplierSource: [{ id: 'src-source', supplier_id: 'src-supplier', source_code: 'LGNX-DS', pricing_model: 'none', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect(report.id_collision_count).toBeGreaterThan(0);
    expect(report.hard_blocker_count).toBe(0);
    expect(report.can_apply).toBe(true);
  });

  // ── Protected target state ────────────────────────────────────────────────

  it('never overwrites the authorization fields of a DashFlo account it matched', async () => {
    await pool.query(
      'INSERT INTO e_user (id, data, updated_date) VALUES ($1, $2::jsonb, $3)',
      [OWNER.id, JSON.stringify({
        email: OWNER.email, role: 'admin', base_role: 'owner', permissions: '{"set_export_import":true}',
      }), '2026-08-01T00:00:00.000Z'],
    );

    await apply({
      User: [{
        id: 'src-user', email: OWNER.email, role: 'user', base_role: 'manager',
        permissions: '{}', linked_buyer_id: 'some-buyer', full_name: 'From Source',
        updated_date: '2026-08-10T00:00:00.000Z',
      }],
    });

    const { rows } = await pool.query('SELECT id, data FROM e_user');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(OWNER.id);
    expect(rows[0].data).toMatchObject({
      email: OWNER.email, role: 'admin', base_role: 'owner', permissions: '{"set_export_import":true}',
    });
    expect(rows[0].data.linked_buyer_id).toBeUndefined();
    // Non-authorization fields still migrate, so the record is not frozen.
    expect(rows[0].data.full_name).toBe('From Source');
  });

  it('never lets an import set the live distribution mode', async () => {
    await pool.query(
      "INSERT INTO e_app_settings (id, data, updated_date) VALUES ('settings', '{\"distribution_mode\":\"native\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    await apply({
      AppSettings: [{ id: 'settings', distribution_mode: 'legacy', company_name: 'DashFlo', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    const { rows } = await pool.query("SELECT data FROM e_app_settings WHERE id = 'settings'");
    expect(rows[0].data.distribution_mode).toBe('native');
    expect(rows[0].data.company_name).toBe('DashFlo');
  });

  // ── Credentials ───────────────────────────────────────────────────────────

  it('never uses a credential field as an identity key', async () => {
    const { NATURAL_KEYS, MIGRATION_SECRETS_EXPECTED, SECRET_FIELDS } = await import('../src/functions/systemTransfer.generated.js');
    const secretish = /(auth|key|secret|token|password|passwd|pwd|bearer|sig|signature|credential)/i;
    for (const [entity, field] of Object.entries(NATURAL_KEYS)) {
      expect(secretish.test(field), `${entity}.${field} must not be a credential`).toBe(false);
      expect(MIGRATION_SECRETS_EXPECTED[entity] || [], `${entity}.${field}`).not.toContain(field);
      expect(SECRET_FIELDS[entity] || [], `${entity}.${field}`).not.toContain(field);
    }
  });

  it('accounts for every credential-bearing record without ever showing a credential', async () => {
    const SUPPLIER_KEY = 'lgnx_sup_planner_regression_value';
    const bundle = ownerPackage({
      Supplier: [supplier('src-supplier', 'LGNX')],
      ApiKey: [{ id: 'src-key', supplier_id: 'src-supplier', name: 'k', key: SUPPLIER_KEY, updated_date: '2026-08-10T00:00:00.000Z' }],
      SystemKey: [{ id: 'src-system-key', provider: 'meta', client_id: 'meta-client', secret: 'meta-secret-value', updated_date: '2026-08-10T00:00:00.000Z' }],
      MetaConnection: [{ id: 'src-meta', name: 'Meta', token: 'meta-durable-token', updated_date: '2026-08-10T00:00:00.000Z' }],
      LeadByteConnector: [{ id: 'src-lb', name: 'LB', headers: JSON.stringify({ X_KEY: 'leadbyte-value' }), target_url: 'https://lb.example.test/p?key=v', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    const report = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle, passphrase: PASSPHRASE, user: OWNER });

    // Every credential-bearing record is planned, not quietly left out.
    expect(report.reconciliation.planned_creates).toBe(5);
    expect(Object.keys(report.credential_bearing_entities).sort())
      .toEqual(['ApiKey', 'LeadByteConnector', 'MetaConnection', 'SystemKey']);

    const serialized = JSON.stringify(report);
    for (const value of [SUPPLIER_KEY, 'meta-secret-value', 'meta-durable-token', 'leadbyte-value', PASSPHRASE]) {
      expect(serialized, `report must not carry ${value.slice(0, 8)}`).not.toContain(value);
    }
  });

  it('never lets a blank or redacted credential replace one DashFlo already holds', async () => {
    await pool.query(
      "INSERT INTO e_meta_connection (id, data, updated_date) VALUES ('meta-1', '{\"name\":\"Meta\",\"token\":\"live-durable-token\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    await pool.query(
      "INSERT INTO e_pull_source (id, data, updated_date) VALUES ('pull-1', '{\"name\":\"Pull\",\"api_key\":\"live-pull-key\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );

    await apply({
      MetaConnection: [{ id: 'meta-1', name: 'Meta renamed', token: '__REDACTED__', updated_date: '2026-08-10T00:00:00.000Z' }],
      PullSource: [{ id: 'pull-1', name: 'Pull renamed', api_key: '', updated_date: '2026-08-10T00:00:00.000Z' }],
    });

    expect((await pool.query("SELECT data->>'token' AS v FROM e_meta_connection WHERE id = 'meta-1'")).rows[0].v).toBe('live-durable-token');
    expect((await pool.query("SELECT data->>'api_key' AS v FROM e_pull_source WHERE id = 'pull-1'")).rows[0].v).toBe('live-pull-key');
  });

  // ── Read only preview ─────────────────────────────────────────────────────

  it('writes no business record, no credential and no applied audit row during a preview', async () => {
    await pool.query("INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\",\"name\":\"Legenex\"}'::jsonb, '2026-08-01T00:00:00Z')");
    await pool.query(
      "INSERT INTO e_meta_connection (id, data, updated_date) VALUES ('meta-1', '{\"token\":\"live-durable-token\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    const before = await tableCounts(pool);
    const credentialBefore = (await pool.query("SELECT data FROM e_meta_connection WHERE id = 'meta-1'")).rows[0].data;
    const provenanceBefore = (await pool.query('SELECT count(*)::int AS n FROM base44_record_provenance')).rows[0].n;

    await runMigrationImport({
      kind: 'owner',
      mode: 'preview',
      passphrase: PASSPHRASE,
      user: OWNER,
      bundle: ownerPackage({
        Supplier: [supplier('src-supplier', 'LGNX')],
        MetaConnection: [{ id: 'meta-1', token: 'a-different-token', updated_date: '2026-08-10T00:00:00.000Z' }],
      }),
    });

    expect(await tableCounts(pool)).toEqual(before);
    expect((await pool.query("SELECT data FROM e_meta_connection WHERE id = 'meta-1'")).rows[0].data).toEqual(credentialBefore);
    expect((await pool.query('SELECT count(*)::int AS n FROM base44_record_provenance')).rows[0].n).toBe(provenanceBefore);
    // The audit row records a validated preview, never a completed migration.
    const { rows } = await pool.query('SELECT status, mode FROM migration_import_runs ORDER BY started_at DESC LIMIT 1');
    expect(rows[0]).toEqual({ status: 'validated', mode: 'preview' });
  });

  it('requires an explicit confirmation before applying anything', async () => {
    const before = await tableCounts(pool);
    await expect(runMigrationImport({
      kind: 'ordinary', mode: 'apply', bundle: ordinary({ Supplier: [supplier('src-supplier', 'LGNX')] }), user: OWNER,
    })).rejects.toThrow(/confirmation is required/i);
    expect(await tableCounts(pool)).toEqual(before);
  });

  it('rolls the whole apply back when any record fails', async () => {
    // A record whose data cannot be serialised into the jsonb column aborts the
    // statement. Nothing that came before it in the same transaction may survive.
    const before = await tableCounts(pool);
    const poison = { id: 'src-bad', sid: 'BAD', name: 'x', updated_date: '2026-08-10T00:00:00.000Z' };
    poison.self = poison; // JSON.stringify throws on the circular reference

    await expect(apply({
      Supplier: [supplier('src-good', 'GOOD'), poison],
    })).rejects.toThrow();

    expect(await tableCounts(pool), 'the good record must not survive the failed run').toEqual(before);
  });

  // ── Plan determinism ──────────────────────────────────────────────────────

  it('produces the same plan twice against the same target state', async () => {
    await pool.query("INSERT INTO e_supplier (id, data, updated_date) VALUES ('dashflo-supplier', '{\"sid\":\"LGNX\"}'::jsonb, '2026-08-01T00:00:00Z')");
    const normalized = normalizeMigrationBundle({
      kind: 'ordinary',
      bundle: ordinary({ Supplier: [supplier('src-supplier', 'LGNX'), supplier('other', 'ACME')] }),
    });

    const first = await buildMigrationPlan(normalized);
    const second = await buildMigrationPlan(normalized);
    expect(second.report.reconciliation).toEqual(first.report.reconciliation);
    expect(second.report.id_collisions).toEqual(first.report.id_collisions);
    expect(second.report.resolved_id_remaps).toEqual(first.report.resolved_id_remaps);
  });
});
