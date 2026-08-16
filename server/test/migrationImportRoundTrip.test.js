import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DB = 'dashflo_migration_import_test';
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

const OWNER = { id: 'owner-1', email: 'owner@example.test', base_role: 'owner', role: 'admin' };
const PASSPHRASE = 'round trip passphrase 2026';
const SUPPLIER_KEY = 'lgnx_sup_round_trip_existing_value';
const BUYER_KEY = 'lgnx_byr_round_trip_existing_value';

describe.skipIf(!reachable)('real encrypted owner bundle round trip', () => {
  let pool;
  let runMigrationImport;
  let resolveApiKey;
  let hashApiKey;
  let migrationOrder;
  let cryptoSpec;
  let bundle;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    ({ runMigrationImport } = await import('../src/lib/migrationImport.js'));
    ({ resolveApiKey, hashApiKey } = await import('../src/lib/apiKeys.js'));
    const catalog = await import('../src/functions/systemTransfer.generated.js');
    migrationOrder = catalog.MIGRATION_ENTITY_ORDER;
    cryptoSpec = catalog.MIGRATION_CRYPTO;

    const records = {
      Supplier: [{ id: 'supplier-1', name: 'Round Trip Supplier', sid: 'RT1', active: true, created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      Buyer: [{ id: 'buyer-1', company_name: 'Round Trip Buyer', buyer_code: 'RB1', buyer_api_key: BUYER_KEY, active: true, created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      User: [{ id: OWNER.id, email: OWNER.email, base_role: 'owner', password_hash: 'excluded', session_token: 'excluded', refresh_token: 'excluded', created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      ApiKey: [{ id: 'supplier-key-1', name: 'Existing supplier key', supplier_id: 'supplier-1', supplier_name: 'Round Trip Supplier', key: SUPPLIER_KEY, active: true, request_count: 7, created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      SystemKey: [{ id: 'system-key-1', name: 'Meta App Credentials', provider: 'meta', client_id: 'meta-client-id', secret: 'meta-app-secret', owner_user_id: OWNER.id, active: true, created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      BuyerApiKey: [{ id: 'buyer-key-1', buyer_id: 'buyer-1', buyer_name: 'Round Trip Buyer', name: 'Existing buyer key', key: BUYER_KEY, key_prefix: BUYER_KEY.slice(0, 16), active: true, created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' }],
      KeyAuditEvent: [{ id: 'audit-1', subject_type: 'supplier', subject_id: 'supplier-key-1', subject_name: 'Existing supplier key', action: 'created', at: '2026-08-01T00:00:00.000Z', created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-01T00:00:00.000Z' }],
      IntegrationConfig: [
        { id: 'meta-app-config', name: 'meta_app', config: JSON.stringify({ app_id: 'legacy-id', app_secret: 'legacy-secret' }), created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' },
        { id: 'oauth-state', name: 'meta_oauth_state', config: 'transient', created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z' },
      ],
    };

    const salt = crypto.randomBytes(cryptoSpec.salt_bytes);
    const key = crypto.pbkdf2Sync(PASSPHRASE, salt, cryptoSpec.iterations, cryptoSpec.key_bits / 8, 'sha256');
    const chunks = [];
    for (const entity of migrationOrder) {
      const entityRecords = (records[entity] || []).filter((row) => !(entity === 'IntegrationConfig' && row.name === 'meta_oauth_state'));
      if (!entityRecords.length) continue;
      const plaintext = Buffer.from(JSON.stringify({ entity, offset: 0, records: entityRecords }));
      const iv = crypto.randomBytes(cryptoSpec.iv_bytes);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      chunks.push({
        entity, offset: 0, records: entityRecords.length, iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      });
    }
    bundle = {
      format: cryptoSpec.format,
      source_app: 'legenex-dashboard',
      target: 'dashflo',
      exported_at: '2026-08-16T12:00:00.000Z',
      crypto: { ...cryptoSpec, salt: salt.toString('base64') },
      counts: Object.fromEntries(migrationOrder.map((name) => [name, records[name]?.length || 0])),
      chunks,
    };
  });

  afterAll(async () => {
    await pool?.end?.();
    if (reachable) {
      await maintenance(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`);
      await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    }
  });

  it('previews, applies and preserves IDs, relationships and durable credentials', async () => {
    const preview = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle, passphrase: PASSPHRASE, user: OWNER });
    expect(preview.can_apply).toBe(true);
    expect(preview.entities_present).toHaveLength(93);
    expect(preview.records_present).toBe(8);
    expect(preview.credential_bearing_entities).toHaveProperty('ApiKey');
    expect(JSON.stringify(preview)).not.toContain(SUPPLIER_KEY);
    expect(JSON.stringify(preview)).not.toContain(BUYER_KEY);

    const applied = await runMigrationImport({ kind: 'owner', mode: 'apply', bundle, passphrase: PASSPHRASE, user: OWNER, confirmed: true });
    expect(applied.result).toBe('success');
    expect(applied.applied.created).toBe(8);
    expect(applied.applied.failed).toBe(0);

    const supplierKey = (await pool.query("SELECT id, data FROM e_api_key WHERE id = 'supplier-key-1'")).rows[0];
    expect(supplierKey.data.supplier_id).toBe('supplier-1');
    expect(supplierKey.data.key_hash).toBe(hashApiKey(SUPPLIER_KEY));
    expect(supplierKey.data.key).toBeUndefined();
    const authenticated = await resolveApiKey({ entities: { ApiKey: {
      filter: async (query) => (await pool.query('SELECT id, data, created_date, updated_date FROM e_api_key WHERE data->>\'key_hash\' = $1', [query.key_hash])).rows.map((row) => ({ id: row.id, ...row.data })),
      update: async () => null,
    } } }, SUPPLIER_KEY);
    expect(authenticated.record?.id).toBe('supplier-key-1');
    expect(authenticated.matchedBy).toBe('hash');

    expect((await pool.query("SELECT data->>'key' AS value FROM e_buyer_api_key WHERE id = 'buyer-key-1'")).rows[0].value).toBe(BUYER_KEY);
    expect((await pool.query("SELECT data->>'secret' AS value FROM e_system_key WHERE id = 'system-key-1'")).rows[0].value).toBe('meta-app-secret');
    expect((await pool.query("SELECT data->>'buyer_api_key' AS value FROM e_buyer WHERE id = 'buyer-1'")).rows[0].value).toBe(BUYER_KEY);
    expect((await pool.query("SELECT count(*)::int AS n FROM e_integration_config WHERE data->>'name' = 'meta_oauth_state'")).rows[0].n).toBe(0);
    const importedUser = (await pool.query("SELECT data FROM e_user WHERE id = 'owner-1'")).rows[0].data;
    expect(importedUser).not.toHaveProperty('password_hash');
    expect(importedUser).not.toHaveProperty('session_token');
    expect(importedUser).not.toHaveProperty('refresh_token');
  });

  it('ordinary redacted re-import cannot destroy imported credentials', async () => {
    const ordinary = {
      manifest: { bundle_version: 1, source_app: 'legenex-dashboard', exported_at: '2026-08-17T12:00:00.000Z', counts: { ApiKey: 1, Buyer: 1 } },
      entities: {
        ApiKey: [{ id: 'supplier-key-1', name: 'Renamed without rotating', supplier_id: 'supplier-1', key: '__REDACTED__', updated_date: '2026-08-17T12:00:00.000Z' }],
        Buyer: [{ id: 'buyer-1', company_name: 'Round Trip Buyer', buyer_code: 'RB1', buyer_api_key: '', updated_date: '2026-08-17T12:00:00.000Z' }],
      },
    };
    const applied = await runMigrationImport({ kind: 'ordinary', mode: 'apply', bundle: ordinary, user: OWNER, confirmed: true });
    expect(applied.result).toBe('success');
    expect((await pool.query("SELECT data->>'key_hash' AS value FROM e_api_key WHERE id = 'supplier-key-1'")).rows[0].value).toBe(hashApiKey(SUPPLIER_KEY));
    expect((await pool.query("SELECT data->>'buyer_api_key' AS value FROM e_buyer WHERE id = 'buyer-1'")).rows[0].value).toBe(BUYER_KEY);
  });

  it('imports an owner credential intentionally without rolling back a newer local timestamp', async () => {
    const localTimestamp = '2026-08-20T12:00:00.000Z';
    await pool.query(
      `UPDATE e_system_key
         SET data = jsonb_set(data, '{secret}', '"local-temporary-value"'::jsonb), updated_date = $2
       WHERE id = $1`,
      ['system-key-1', localTimestamp],
    );

    const applied = await runMigrationImport({ kind: 'owner', mode: 'apply', bundle, passphrase: PASSPHRASE, user: OWNER, confirmed: true });
    expect(applied.result).toBe('success');
    const restored = (await pool.query(
      `SELECT data->>'secret' AS secret, updated_date FROM e_system_key WHERE id = 'system-key-1'`,
    )).rows[0];
    expect(restored.secret).toBe('meta-app-secret');
    expect(restored.updated_date.toISOString()).toBe(localTimestamp);
    const provenance = (await pool.query(
      `SELECT dashflo_modified FROM base44_record_provenance WHERE entity = 'SystemKey' AND base44_id = 'system-key-1'`,
    )).rows[0];
    expect(provenance.dashflo_modified).toBe(true);
  });

  it('writes durable migration audit history without secret payloads', async () => {
    const { rows } = await pool.query('SELECT status, kind, mode, credential_entities::text AS credentials, errors::text AS errors FROM migration_import_runs ORDER BY started_at');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => ['validated', 'success'].includes(row.status))).toBe(true);
    const audit = JSON.stringify(rows);
    expect(audit).not.toContain(SUPPLIER_KEY);
    expect(audit).not.toContain(BUYER_KEY);
    expect(audit).not.toContain(PASSPHRASE);
  });
});
