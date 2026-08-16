import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// Base44 to DashFlo sync. These are the source-of-truth invariants, and they
// are database properties, so they run against a real disposable PostgreSQL
// rather than a double. The Base44 side is a plain in-process fake injected
// into the engine, so no test touches the network at all; the outbound guard in
// vitest.setup.js would block it anyway.
//
// The properties under test are the ones whose failure loses data:
//
//   - Base44 ids survive the import, so cross entity references stay valid
//   - a record edited in DashFlo is never overwritten by Base44
//   - both sides changing is reported as a conflict, not silently resolved
//   - a record disappearing from Base44 never deletes the DashFlo row
//   - supplier key material is never rewritten by a sync
//   - a failing entity changes nothing and does not stop the others
//   - two runs cannot overlap

const TEST_DB = 'dashflo_base44sync_test';
const MAINTENANCE_DB = 'postgres';
const FORBIDDEN_DATABASES = new Set(['dashos', 'postgres', 'template0', 'template1', 'dashflo_staging']);

const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

// The engine reads its configuration from the environment at construction, so
// these have to be set before the module is imported.
process.env.BASE44_APP_ID = 'test_app';
process.env.BASE44_MIGRATE_SECRET = 'test-secret-not-a-real-credential';
process.env.BASE44_SYNC_ENABLED = '1';

const pg = (await import('pg')).default;

async function canReachPostgres() {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = await canReachPostgres();

async function withMaintenance(fn) {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

if (reachable) {
  await withMaintenance(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await c.query(`CREATE DATABASE ${TEST_DB}`);
  });
}

// A fake Base44. `pages` maps entity -> array of source records.
class FakeSource {
  constructor(pages = {}) {
    this.pages = pages;
    this.failEntities = new Set();
    this.pingCalls = 0;
  }

  describe() { return { appId: 'test_app', secretConfigured: true, enabled: true }; }

  async ping() { this.pingCalls += 1; return { ok: true }; }

  async readAll(entity, { onPage }) {
    if (this.failEntities.has(entity)) throw new Error(`simulated upstream failure for ${entity}`);
    await onPage(this.pages[entity] || [], { skip: 0, page: 0 });
  }

  async readAllSince(entity, since, { onPage }) {
    if (this.failEntities.has(entity)) throw new Error(`simulated upstream failure for ${entity}`);
    const rows = (this.pages[entity] || []).filter((r) => !r.updated_date || r.updated_date >= since);
    await onPage(rows, { skip: 0, page: 0 });
  }

  async ids(entity) {
    return (this.pages[entity] || []).map((r) => ({ id: r.id, updated_date: r.updated_date }));
  }
}

describe.skipIf(!reachable)('Base44 to DashFlo sync', () => {
  let pool; let Base44Sync; let ensureBase44SyncSchema; let fingerprint; let hashApiKey;

  beforeAll(async () => {
    ({ pool } = await import('../src/db/pool.js'));

    const connected = await pool.query('SELECT current_database() AS db');
    const db = connected.rows[0].db;
    if (db !== TEST_DB || FORBIDDEN_DATABASES.has(db)) {
      throw new Error(`Refusing to run: connected to "${db}", expected the disposable "${TEST_DB}".`);
    }

    const schema = await import('../src/db/schema.js');
    await (schema.ensureSchema || schema.default)();
    ({ ensureBase44SyncSchema } = await import('../src/db/base44SyncSchema.js'));
    await ensureBase44SyncSchema();
    ({ Base44Sync, fingerprint } = await import('../src/lib/base44Sync.js'));
    ({ hashApiKey } = await import('../src/lib/apiKeys.js'));
  });

  afterAll(async () => {
    await pool?.end?.();
    if (reachable) {
      await withMaintenance(async (c) => {
        await c.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [TEST_DB],
        );
        await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      });
    }
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE base44_record_provenance, base44_sync_run_entities, base44_sync_runs, base44_sync_state');
    await pool.query('TRUNCATE e_supplier, e_api_key');
  });

  const supplier = (over = {}) => ({
    id: 'b44supplier000000000001',
    name: 'TriggerFish',
    supplier_type: 'External',
    active: true,
    created_date: '2026-07-01T00:00:00.000Z',
    updated_date: '2026-07-01T00:00:00.000Z',
    ...over,
  });

  it('imports new records under their Base44 id so references stay valid', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });

    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.status).toBe('success');
    expect(res.totals.created).toBe(1);

    const { rows } = await pool.query('SELECT id, data FROM e_supplier');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('b44supplier000000000001');
    expect(rows[0].data.name).toBe('TriggerFish');
  });

  it('is idempotent: a second run over unchanged data writes nothing', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });

    await sync.run({ trigger: 'manual', entities: ['Supplier'] });
    const second = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(second.totals.created).toBe(0);
    expect(second.totals.updated).toBe(0);
    expect(second.totals.skipped).toBe(1);
  });

  it('applies a genuine Base44 change to a record DashFlo has not touched', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });
    await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    source.pages.Supplier = [supplier({ name: 'TriggerFish Media', updated_date: '2026-08-01T00:00:00.000Z' })];
    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.totals.updated).toBe(1);
    const { rows } = await pool.query("SELECT data->>'name' AS name FROM e_supplier");
    expect(rows[0].name).toBe('TriggerFish Media');
  });

  it('never overwrites a record DashFlo edited after import', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });
    await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    // An operator renames the supplier in DashFlo.
    await pool.query(`UPDATE e_supplier SET data = jsonb_set(data, '{name}', '"Renamed In DashFlo"')`);

    // Base44 still holds the old value and has not changed.
    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    const { rows } = await pool.query("SELECT data->>'name' AS name FROM e_supplier");
    expect(rows[0].name).toBe('Renamed In DashFlo');
    expect(res.totals.updated).toBe(0);

    const { rows: prov } = await pool.query('SELECT dashflo_modified FROM base44_record_provenance');
    expect(prov[0].dashflo_modified).toBe(true);
  });

  it('reports a conflict when both sides changed, and still does not overwrite', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });
    await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    await pool.query(`UPDATE e_supplier SET data = jsonb_set(data, '{name}', '"DashFlo Wins"')`);
    source.pages.Supplier = [supplier({ name: 'Base44 Changed Too', updated_date: '2026-08-10T00:00:00.000Z' })];

    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.totals.conflicted).toBe(1);
    const { rows } = await pool.query("SELECT data->>'name' AS name FROM e_supplier");
    expect(rows[0].name).toBe('DashFlo Wins');

    const { rows: prov } = await pool.query('SELECT conflict, conflict_reason FROM base44_record_provenance');
    expect(prov[0].conflict).toBe(true);
    expect(prov[0].conflict_reason).toBe('both_changed_since_import');
  });

  it('never deletes a DashFlo record just because it vanished from Base44', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });
    await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    source.pages.Supplier = [];
    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.status).toBe('success');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_supplier');
    expect(rows[0].n).toBe(1);
  });

  it('an upstream failure changes nothing and leaves the imported data in place', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });
    await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    source.failEntities.add('Supplier');
    const res = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.status).toBe('failed');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_supplier');
    expect(rows[0].n).toBe(1);
  });

  it('isolates a failing entity so the others still import', async () => {
    const source = new FakeSource({
      Supplier: [supplier()],
      Brand: [{ id: 'b44brand00000000000001', name: 'Acme', updated_date: '2026-07-01T00:00:00.000Z' }],
    });
    source.failEntities.add('Supplier');
    const sync = new Base44Sync({ source });

    const res = await sync.run({ trigger: 'manual', entities: ['Supplier', 'Brand'] });

    expect(res.status).toBe('partial');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_brand');
    expect(rows[0].n).toBe(1);
  });

  it('reports a partial run when an individual record fails', async () => {
    const source = new FakeSource({ Supplier: [supplier(), { name: 'Missing id' }] });
    const res = await new Base44Sync({ source }).run({ trigger: 'manual', entities: ['Supplier'] });

    expect(res.status).toBe('partial');
    expect(res.totals.created).toBe(1);
    expect(res.totals.failed).toBe(1);
  });

  it('adopts a pre-existing DashFlo row as locally owned and never overwrites it later', async () => {
    await pool.query(
      `INSERT INTO e_supplier (id, data) VALUES ($1, $2::jsonb)`,
      ['b44supplier000000000001', JSON.stringify({ name: 'DashFlo Existing', active: true })],
    );
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });

    const first = await sync.run({ trigger: 'manual', entities: ['Supplier'] });
    expect(first.totals.skipped).toBe(1);

    source.pages.Supplier = [supplier({ name: 'Changed Upstream', updated_date: '2026-08-10T00:00:00.000Z' })];
    const second = await sync.run({ trigger: 'manual', entities: ['Supplier'] });
    const { rows } = await pool.query("SELECT data->>'name' AS name FROM e_supplier");

    expect(rows[0].name).toBe('DashFlo Existing');
    expect(second.totals.updated).toBe(0);
    expect(second.totals.conflicted).toBe(1);
  });

  describe('supplier key material', () => {
    const apiKey = (over = {}) => ({
      id: 'b44apikey00000000000001',
      name: 'TriggerFish Key',
      type: 'supplier',
      supplier_name: 'TriggerFish',
      key: 'lgnx_ext_testkeyvalue000000000000',
      key_prefix: 'lgnx_ext_testke',
      active: true,
      request_count: 7,
      updated_date: '2026-07-01T00:00:00.000Z',
      ...over,
    });

    it('derives key_hash on first import and does not retain cleartext', async () => {
      const source = new FakeSource({ ApiKey: [apiKey()] });
      await new Base44Sync({ source }).run({ trigger: 'manual', entities: ['ApiKey'] });

      const { rows } = await pool.query("SELECT data->>'key' AS key, data->>'key_hash' AS hash FROM e_api_key");
      expect(rows[0].key).toBeNull();
      expect(rows[0].hash).toBe(hashApiKey('lgnx_ext_testkeyvalue000000000000'));
    });

    it('never rewrites key material or usage counters on a later sync', async () => {
      const source = new FakeSource({ ApiKey: [apiKey()] });
      const sync = new Base44Sync({ source });
      await sync.run({ trigger: 'manual', entities: ['ApiKey'] });

      // DashFlo has since counted real traffic against this key.
      await pool.query(`UPDATE e_api_key SET data = data || '{"request_count": 412}'::jsonb`);

      // Base44 rotates the key and reports a stale counter.
      source.pages.ApiKey = [apiKey({
        key: 'lgnx_ext_ROTATED_UPSTREAM_000000',
        name: 'TriggerFish Key Renamed',
        request_count: 7,
        updated_date: '2026-08-12T00:00:00.000Z',
      })];
      await sync.run({ trigger: 'manual', entities: ['ApiKey'] });

      const { rows } = await pool.query(
        "SELECT data->>'key' AS key, data->>'key_hash' AS hash, data->>'request_count' AS n FROM e_api_key",
      );
      expect(rows[0].key).toBeNull();
      expect(rows[0].hash).toBe(hashApiKey('lgnx_ext_testkeyvalue000000000000'));
      expect(rows[0].n).toBe('412');
    });
  });

  it('prevents overlapping runs', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    const sync = new Base44Sync({ source });

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = new FakeSource({ Supplier: [supplier()] });
    slow.readAll = async (entity, { onPage }) => {
      await gate;
      await onPage([supplier()], { skip: 0, page: 0 });
    };

    const first = new Base44Sync({ source: slow }).run({ trigger: 'scheduled', entities: ['Supplier'] });
    // Give the first run time to take the advisory lock.
    await new Promise((r) => setTimeout(r, 250));
    const second = await sync.run({ trigger: 'manual', entities: ['Supplier'] });

    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('already_running');

    release();
    await first;
  });

  it('records durable run history an operator can read', async () => {
    const source = new FakeSource({ Supplier: [supplier()] });
    await new Base44Sync({ source }).run({ trigger: 'manual', entities: ['Supplier'] });

    const { rows } = await pool.query(
      'SELECT trigger, status, records_created, entities_attempted FROM base44_sync_runs',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].records_created).toBe(1);
    expect(rows[0].trigger).toBe('manual');
  });

  it('fingerprint ignores property order', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });
});
