import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* Buyer identity resolution for relationship references.
 *
 * The real package's second preview, after the generic natural-key alias fix,
 * still carried 8 hard blockers concentrated on BuyerStateCpl.buyer_id, and
 * "Resolved relationship aliases: 0" in that same preview proved the generic
 * fix never even fired: nothing in the package matched Buyer.buyer_code either,
 * for the passing rows or the failing ones. That rules out buyer_code as the
 * identity form entirely and points at something else BuyerStateCpl.buyer_id
 * may legitimately hold.
 *
 * The Buyer schema documents the answer directly: `leadbyte_bid` is
 * "LeadByte buyer id. Nullable. Defaults to the buyer_code value when a code
 * is allocated" -- meaning it usually equals buyer_code and sometimes does
 * not. lib/buyerIdentity.js already resolves Lead.buyer_id through exactly
 * this field, in exactly this priority (record id, then buyer_code, then
 * leadbyte_bid), for exactly this reason. `identityAliasFields('Buyer')`
 * reuses that same field, in that same position, rather than inventing a new
 * rule: record identity and collision detection are entirely unaffected,
 * since they still use NATURAL_KEYS.Buyer (buyer_code) alone.
 *
 * What follows proves the mechanism holds every guarantee the primary natural
 * key alias already had -- deterministic, fails closed on ambiguity, never
 * fuzzy, never guesses -- now across two fields tried in strict order, and
 * proves the actual identity of the real package's blockers remains provable
 * even if leadbyte_bid is not the cause: every field tried, and its result,
 * survives into the reported reason.
 */

const TEST_DB = 'dashflo_migration_buyer_identity_test';
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

describe.skipIf(!reachable)('Buyer identity resolution', () => {
  let pool;
  let runMigrationImport;
  let identityAliasFields;

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
    ({ runMigrationImport } = await import('../src/lib/migrationImport.js'));
    ({ identityAliasFields } = await import('../src/lib/migrationPlan.js'));
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

  const buyer = (id, code, extra = {}) => ({
    id, buyer_code: code, company_name: `Buyer ${code}`, updated_date: '2026-08-10T00:00:00.000Z', ...extra,
  });
  const cpl = (id, buyerId, extra = {}) => ({
    id, buyer_id: buyerId, vertical: 'MVA', state: 'TX', cpl: 10, updated_date: '2026-08-10T00:00:00.000Z', ...extra,
  });

  // ── Every supported identity form, in priority order ─────────────────────

  it('declares Buyer\'s identity fields as buyer_code then leadbyte_bid, and nothing else', () => {
    expect(identityAliasFields('Buyer')).toEqual(['buyer_code', 'leadbyte_bid']);
  });

  it('resolves BuyerStateCpl.buyer_id by Buyer source record id', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1')],
      BuyerStateCpl: [cpl('src-cpl', 'src-buyer')],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_issue_count).toBe(0);
    expect(report.relationship_alias_resolution_count).toBe(0);
    expect(report.relationship_resolved.resolved_in_package).toBe(1);
  });

  it('resolves BuyerStateCpl.buyer_id by Buyer.buyer_code when it is not the source id', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1')],
      BuyerStateCpl: [cpl('src-cpl', 'B1')],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_alias_resolutions[0]).toMatchObject({ natural_key_field: 'buyer_code', resolved_target_id: 'src-buyer' });
  });

  it('resolves BuyerStateCpl.buyer_id by Buyer.leadbyte_bid when neither the id nor buyer_code matches', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', 'LB-9001')],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_alias_resolutions[0]).toMatchObject({ natural_key_field: 'leadbyte_bid', resolved_target_id: 'src-buyer', via: 'package' });
  });

  it('resolves against a leadbyte_bid that exists only in DashFlo, not in the package', async () => {
    await pool.query(
      "INSERT INTO e_buyer (id, data) VALUES ('dashflo-buyer', '{\"buyer_code\":\"B1\",\"leadbyte_bid\":\"LB-9001\"}'::jsonb)",
    );
    const report = await preview({ BuyerStateCpl: [cpl('src-cpl', 'LB-9001')] });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_alias_resolutions[0]).toMatchObject({ natural_key_field: 'leadbyte_bid', resolved_target_id: 'dashflo-buyer', via: 'dashflo' });
  });

  // ── Priority: a higher field is tried to exhaustion before a lower one ───

  it('never tries leadbyte_bid when buyer_code already resolved it', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'DIFFERENT-VALUE' })],
      BuyerStateCpl: [cpl('src-cpl', 'B1')],
    });
    expect(report.relationship_alias_resolutions[0].natural_key_field).toBe('buyer_code');
  });

  it('does not fall through to leadbyte_bid when buyer_code is ambiguous', async () => {
    // Two buyers share a code (a package-level duplicate) and one of them also
    // carries a leadbyte_bid equal to the reference value. If the resolver
    // fell through past the ambiguity it would silently pick that buyer;
    // instead the ambiguity at the higher-priority field must be the final
    // answer.
    const report = await preview({
      Buyer: [
        buyer('src-buyer-a', 'DUP'),
        buyer('src-buyer-b', 'DUP', { leadbyte_bid: 'DUP' }),
      ],
      BuyerStateCpl: [cpl('src-cpl', 'DUP')],
    });
    expect(report.can_apply).toBe(false);
    expect(report.relationship_issues[0].status).toBe('referenced_record_ambiguous_alias');
    expect(report.relationship_issues[0].identity_attempts).toEqual([
      { field: 'buyer_code', checked_in: 'package', result: 'ambiguous' },
    ]);
  });

  // ── The write path stores the resolved target id, never the legacy value ─

  it('applies a leadbyte_bid resolution and writes the final Buyer record id, not the bid', async () => {
    await apply({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', 'LB-9001')],
    });
    const stored = (await pool.query("SELECT data->>'buyer_id' AS v FROM e_buyer_state_cpl WHERE id = 'src-cpl'")).rows[0].v;
    expect(stored).toBe('src-buyer');
    expect(stored).not.toBe('LB-9001');
  });

  it('applies a leadbyte_bid resolution against a remapped Buyer and writes the remapped target id', async () => {
    // The Buyer itself collides by buyer_code with a DashFlo-native buyer, so
    // its own id moves. BuyerStateCpl references the collided buyer only by
    // leadbyte_bid, never by any id at all, so the relationship path exercised
    // here is purely the alias, landing on a record that was also remapped.
    await pool.query(
      "INSERT INTO e_buyer (id, data, updated_date) VALUES ('dashflo-buyer', '{\"buyer_code\":\"B1\"}'::jsonb, '2026-08-01T00:00:00Z')",
    );
    await apply({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', 'LB-9001')],
    });
    const stored = (await pool.query("SELECT data->>'buyer_id' AS v FROM e_buyer_state_cpl WHERE id = 'src-cpl'")).rows[0].v;
    expect(stored).toBe('dashflo-buyer');
  });

  // ── Case sensitivity: unchanged from the established codes-are-not-folded policy ──

  it('does not fold case for leadbyte_bid, matching the existing codes-are-not-folded policy', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', 'lb-9001')],
    });
    // Neither field resolves it: buyer_code plainly does not match, and
    // leadbyte_bid is compared exactly, not case-insensitively.
    expect(report.can_apply).toBe(false);
    const attempts = report.relationship_issues[0].identity_attempts.map((a) => `${a.field}:${a.checked_in}`);
    expect(attempts).toEqual(['buyer_code:package', 'leadbyte_bid:package', 'buyer_code:dashflo', 'leadbyte_bid:dashflo']);
  });

  it('trims whitespace but never lowercases a leadbyte_bid value', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', '  LB-9001  ')],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_alias_resolutions[0].natural_key_field).toBe('leadbyte_bid');
  });

  // ── Missing and ambiguous remain hard blockers, named precisely ──────────

  it('keeps a genuinely missing Buyer identity as a hard blocker naming every field tried', async () => {
    const report = await preview({ BuyerStateCpl: [cpl('src-cpl', 'nothing-matches-this')] });
    expect(report.can_apply).toBe(false);
    const blocker = report.hard_blockers.find((b) => b.entity === 'BuyerStateCpl');
    expect(blocker.identity_attempts).toEqual([
      { field: 'buyer_code', checked_in: 'package', result: 'no_match' },
      { field: 'leadbyte_bid', checked_in: 'package', result: 'no_match' },
      { field: 'buyer_code', checked_in: 'dashflo', result: 'no_match' },
      { field: 'leadbyte_bid', checked_in: 'dashflo', result: 'no_match' },
    ]);
    expect(blocker.detail).toContain('Buyer.buyer_code or Buyer.leadbyte_bid');
  });

  it('keeps an ambiguous leadbyte_bid as a hard blocker', async () => {
    const report = await preview({
      Buyer: [
        buyer('src-buyer-a', 'A1', { leadbyte_bid: 'SHARED' }),
        buyer('src-buyer-b', 'A2', { leadbyte_bid: 'SHARED' }),
      ],
      BuyerStateCpl: [cpl('src-cpl', 'SHARED')],
    });
    expect(report.can_apply).toBe(false);
    expect(report.relationship_issues[0]).toMatchObject({ status: 'referenced_record_ambiguous_alias' });
    expect(report.relationship_issues[0].identity_attempts).toEqual([
      { field: 'buyer_code', checked_in: 'package', result: 'no_match' },
      { field: 'leadbyte_bid', checked_in: 'package', result: 'ambiguous' },
    ]);
  });

  it('keeps an ambiguous leadbyte_bid found in DashFlo as a hard blocker', async () => {
    await pool.query("INSERT INTO e_buyer (id, data) VALUES ('a', '{\"buyer_code\":\"A1\",\"leadbyte_bid\":\"SHARED\"}'::jsonb)");
    await pool.query("INSERT INTO e_buyer (id, data) VALUES ('b', '{\"buyer_code\":\"A2\",\"leadbyte_bid\":\"SHARED\"}'::jsonb)");
    const report = await preview({ BuyerStateCpl: [cpl('src-cpl', 'SHARED')] });
    expect(report.can_apply).toBe(false);
    expect(report.relationship_issues[0].status).toBe('referenced_record_ambiguous_alias');
    expect(report.relationship_issues[0].identity_attempts.at(-1)).toMatchObject({ field: 'leadbyte_bid', checked_in: 'dashflo', result: 'ambiguous', candidate_count: 2 });
  });

  // ── Never fuzzy, never a name, never a credential ────────────────────────

  it('never uses Buyer.company_name to resolve a relationship', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { company_name: 'The One True Buyer' })],
      BuyerStateCpl: [cpl('src-cpl', 'The One True Buyer')],
    });
    // The exact company name is the reference value, yet nothing resolves it:
    // name is not one of Buyer's identity fields.
    expect(report.can_apply).toBe(false);
    expect(identityAliasFields('Buyer')).not.toContain('company_name');
  });

  it('never uses Buyer.buyer_api_key as an identity field or exposes it in diagnostics', async () => {
    const report = await preview({
      Buyer: [buyer('src-buyer', 'B1', { buyer_api_key: 'do-not-leak-this-buyer-key', leadbyte_bid: 'LB-1' })],
      BuyerStateCpl: [cpl('src-cpl', 'LB-1')],
    });
    expect(identityAliasFields('Buyer')).not.toContain('buyer_api_key');
    expect(JSON.stringify(report)).not.toContain('do-not-leak-this-buyer-key');
  });

  // ── The full 94-record mixed-form scenario, end to end ───────────────────

  it('reconciles a realistic 94-record BuyerStateCpl set across id, buyer_code, leadbyte_bid and genuine orphans', async () => {
    const buyers = Array.from({ length: 13 }, (_, i) => buyer(`buyer-${i}`, `B${i}`, {
      leadbyte_bid: i < 10 ? `B${i}` : `LB-OLD-${i}`,
    }));
    const records = [];
    for (let i = 0; i < 60; i += 1) records.push(cpl(`cpl-id-${i}`, `buyer-${i % 13}`));
    for (let i = 0; i < 20; i += 1) records.push(cpl(`cpl-code-${i}`, `B${i % 13}`));
    for (let i = 0; i < 6; i += 1) records.push(cpl(`cpl-bid-${i}`, `LB-OLD-${10 + (i % 3)}`));
    for (let i = 0; i < 8; i += 1) records.push(cpl(`cpl-orphan-${i}`, `no-such-buyer-${i}`));
    expect(records).toHaveLength(94);

    const report = await preview({ Buyer: buyers, BuyerStateCpl: records });

    expect(report.can_apply).toBe(false);
    expect(report.hard_blocker_count).toBe(8);
    expect(report.reconciliation.exported_records).toBe(13 + 94);
    expect(report.reconciliation.planned_creates).toBe(13 + 94);
    expect(report.reconciliation.balanced).toBe(true);
    expect(report.reconciliation.unresolved).toBe(0);
    // Records are never dropped to clear a blocker: even the orphaned rows are
    // still planned as creates. Only the relationship is blocked.
    expect(report.entity_reconciliation.find((e) => e.entity === 'BuyerStateCpl').create).toBe(94);
    expect(report.relationship_resolved.resolved_in_package).toBe(60);
    // Alias resolutions are grouped by distinct referenced value, not by
    // occurrence: the 20 buyer_code rows cycle through all 13 codes (i % 13),
    // and the 6 leadbyte_bid rows cycle through 3 distinct bids (i % 3).
    expect(report.relationship_alias_resolution_count).toBe(13 + 3);
    expect(report.relationship_resolved.resolved_by_natural_key_alias).toBe(20 + 6);
  });

  it('applies the same 94-record set once resolvable and creates zero orphans as buyers', async () => {
    const buyers = Array.from({ length: 13 }, (_, i) => buyer(`buyer-${i}`, `B${i}`, { leadbyte_bid: `B${i}` }));
    const records = [];
    for (let i = 0; i < 60; i += 1) records.push(cpl(`cpl-id-${i}`, `buyer-${i % 13}`));
    for (let i = 0; i < 34; i += 1) records.push(cpl(`cpl-code-${i}`, `B${i % 13}`));

    const applied = await apply({ Buyer: buyers, BuyerStateCpl: records });
    expect(applied.result).toBe('success');
    expect(applied.applied.created).toBe(13 + 94);
    expect(applied.applied.failed).toBe(0);

    const { rows } = await pool.query("SELECT data->>'buyer_id' AS buyer_id FROM e_buyer_state_cpl");
    const validIds = new Set(buyers.map((b) => b.id));
    expect(rows.every((r) => validIds.has(r.buyer_id))).toBe(true);
  });

  // ── Optional buyer references stay warnings, not blockers ────────────────

  it('leaves an optional unresolved Buyer reference as a warning, not a blocker', async () => {
    // BuyerOnboarding.buyer_id is nullable in the DashFlo schema: null until a
    // Buyer is created from the submission. An unresolved value here is a
    // legitimate historical state, not a defect.
    const report = await preview({
      BuyerOnboarding: [{ id: 'src-onboarding', buyer_id: 'never-existed', updated_date: '2026-08-10T00:00:00.000Z' }],
    });
    expect(report.can_apply).toBe(true);
    expect(report.relationship_issues[0]).toMatchObject({ entity: 'BuyerOnboarding', severity: 'warning' });
    expect(report.reconciliation.planned_creates).toBe(1);
  });

  // ── Read only, owner only, explicit ───────────────────────────────────────

  it('preview performs no write while resolving BuyerStateCpl through leadbyte_bid', async () => {
    const before = await tableCounts(pool);
    await preview({
      Buyer: [buyer('src-buyer', 'B1', { leadbyte_bid: 'LB-9001' })],
      BuyerStateCpl: [cpl('src-cpl', 'LB-9001')],
    });
    expect(await tableCounts(pool)).toEqual(before);
  });

  it('still requires explicit confirmation to apply a BuyerStateCpl-bearing bundle', async () => {
    const before = await tableCounts(pool);
    await expect(runMigrationImport({
      kind: 'ordinary', mode: 'apply',
      bundle: ordinary({ Buyer: [buyer('src-buyer', 'B1')], BuyerStateCpl: [cpl('src-cpl', 'src-buyer')] }),
      user: OWNER,
    })).rejects.toThrow(/confirmation is required/i);
    expect(await tableCounts(pool)).toEqual(before);
  });
});
