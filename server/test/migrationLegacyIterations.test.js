import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* A package sealed the way the supported exporter actually seals one.
 *
 * migrationImportRoundTrip covers the full apply against a bundle built from
 * MIGRATION_CRYPTO, which is 600000 iterations. That is not what any real export
 * carries, which is precisely how the incompatibility survived: the only
 * end-to-end coverage used the importer's own constant on both sides, so
 * exporter and importer agreed in the test and disagreed in production.
 *
 * These build the package at 100000 iterations instead, the value the legacy
 * Legenex dashboard exporter writes, and drive it through the real preview path.
 * If the importer ever goes back to deriving with a hardcoded work factor, the
 * first test here fails with decrypt_failed rather than passing quietly.
 */

const TEST_DB = 'dashflo_migration_legacy_iterations_test';
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

async function businessRowCount(pool) {
  const { rows } = await pool.query(`
    SELECT relname AS table_name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'`);
  let total = 0;
  for (const row of rows) {
    const { rows: [count] } = await pool.query(`SELECT count(*)::int AS n FROM ${row.table_name}`);
    total += count.n;
  }
  return total;
}

// Test-only credentials. Nothing here is or resembles a production value.
const OWNER = { id: 'owner-legacy', email: 'owner@example.test', base_role: 'owner', role: 'admin' };
const ADMIN = { id: 'admin-legacy', email: 'admin@example.test', base_role: 'admin', role: 'admin' };
const PASSPHRASE = 'legacy iteration passphrase 2026';
const LEGACY_ITERATIONS = 100000;

describe.skipIf(!reachable)('owner migration sealed at the exporter iteration count', () => {
  let pool;
  let runMigrationImport;
  let normalizeMigrationBundle;
  let sealPackage;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    ({ runMigrationImport, normalizeMigrationBundle } = await import('../src/lib/migrationImport.js'));

    // Builds a package exactly as an exporter would at a given work factor.
    sealPackage = (iterations, mutate = (b) => b) => {
      const salt = crypto.randomBytes(16);
      const key = crypto.pbkdf2Sync(PASSPHRASE, salt, iterations, 32, 'sha256');
      const records = [
        {
          id: 'supplier-legacy-1', name: 'Legacy Supplier', sid: 'LG1', active: true,
          created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z',
        },
      ];
      const plaintext = Buffer.from(JSON.stringify({ entity: 'Supplier', offset: 0, records }));
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

      return mutate({
        format: 'legenex-migration-v1',
        source_app: 'legenex-dashboard',
        target: 'dashflo',
        exported_at: '2026-08-18T18:13:39.484Z',
        crypto: {
          format: 'legenex-migration-v1',
          kdf: 'PBKDF2-SHA256',
          iterations,
          cipher: 'AES-GCM',
          key_bits: 256,
          salt_bytes: 16,
          iv_bytes: 12,
          salt: salt.toString('base64'),
        },
        counts: { Supplier: records.length },
        chunks: [{
          entity: 'Supplier',
          offset: 0,
          records: records.length,
          iv: iv.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
        }],
      });
    };
  });

  afterAll(async () => {
    await pool?.end?.();
    if (reachable) {
      await maintenance(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`);
      await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    }
  });

  it('decrypts and previews a package sealed at 100000 iterations', async () => {
    const preview = await runMigrationImport({
      kind: 'owner', mode: 'preview', bundle: sealPackage(LEGACY_ITERATIONS), passphrase: PASSPHRASE, user: OWNER,
    });
    expect(preview.records_present).toBe(1);
    expect(preview.package_version).toBe('legenex-migration-v1');
  });

  it('still decrypts a package sealed at the stronger current work factor', async () => {
    const preview = await runMigrationImport({
      kind: 'owner', mode: 'preview', bundle: sealPackage(600000), passphrase: PASSPHRASE, user: OWNER,
    });
    expect(preview.records_present).toBe(1);
  });

  it('writes no business record during preview', async () => {
    const before = await businessRowCount(pool);
    await runMigrationImport({
      kind: 'owner', mode: 'preview', bundle: sealPackage(LEGACY_ITERATIONS), passphrase: PASSPHRASE, user: OWNER,
    });
    expect(await businessRowCount(pool)).toBe(before);
  });

  it('fails safely on the wrong passphrase without saying which part was wrong', async () => {
    const bundle = sealPackage(LEGACY_ITERATIONS);
    await expect(runMigrationImport({
      kind: 'owner', mode: 'preview', bundle, passphrase: 'a different passphrase entirely', user: OWNER,
    })).rejects.toMatchObject({ code: 'decrypt_failed' });

    await expect(runMigrationImport({
      kind: 'owner', mode: 'preview', bundle, passphrase: 'a different passphrase entirely', user: OWNER,
    })).rejects.toThrow(/Check the passphrase and file integrity/);
  });

  it('fails safely when the ciphertext has been tampered with', async () => {
    const bundle = sealPackage(LEGACY_ITERATIONS, (pkg) => {
      const raw = Buffer.from(pkg.chunks[0].ciphertext, 'base64');
      raw[8] ^= 0xff;
      pkg.chunks[0].ciphertext = raw.toString('base64');
      return pkg;
    });
    await expect(runMigrationImport({
      kind: 'owner', mode: 'preview', bundle, passphrase: PASSPHRASE, user: OWNER,
    })).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('refuses a package downgraded below the accepted work factor', () => {
    expect(() => normalizeMigrationBundle({
      kind: 'owner', bundle: sealPackage(1000), passphrase: PASSPHRASE,
    })).toThrow(/weaker key derivation/i);
  });

  it('never returns the passphrase or a decrypted credential in the preview', async () => {
    const preview = await runMigrationImport({
      kind: 'owner', mode: 'preview', bundle: sealPackage(LEGACY_ITERATIONS), passphrase: PASSPHRASE, user: OWNER,
    });
    expect(JSON.stringify(preview)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(preview)).not.toContain('passphrase');
  });

  it('keeps owner migration owner only at the route authorization gate', async () => {
    const { authorized } = await import('../src/routes/migrations.js');
    expect(authorized(OWNER, 'owner')).toBe(true);
    expect(authorized(ADMIN, 'owner')).toBe(false);
    expect(authorized({ ...ADMIN, permissions: { set_export_import: true } }, 'owner')).toBe(false);
    expect(authorized(null, 'owner')).toBe(false);
  });
});
