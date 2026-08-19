import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/* The owner migration preview, exercised over HTTP.
 *
 * In production the operator selected a valid encrypted package, entered the
 * passphrase, watched a spinner, and then watched the button go back to normal
 * with no preview, no success, and no error. Nothing in the route wrote a log
 * line for that, so afterwards there was nothing to read.
 *
 * These tests run the real router, with the real multer configuration and the
 * real multipart body the browser builds, against a disposable database. Every
 * ending the operator can hit is asserted to produce a status, a stable code,
 * and a safe message. The corresponding browser side lives in
 * client/src/lib/migrationImportStatus.test.js.
 *
 * The database is created and dropped here. No production data is read or
 * written, and no Base44 source is contacted.
 */

const TEST_DB = 'dashflo_migration_preview_route_test';
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

const OWNER = { id: 'owner-1', email: 'owner@example.test', base_role: 'owner' };
const PASSPHRASE = 'preview route passphrase 2026';

// Build a genuine encrypted owner package with the shipped crypto parameters.
// A fixture would drift from the exporter; this cannot.
function buildOwnerPackage(spec, records, overrides = {}) {
  const salt = crypto.randomBytes(spec.salt_bytes);
  const key = crypto.pbkdf2Sync(Buffer.from(PASSPHRASE, 'utf8'), salt, spec.iterations, spec.key_bits / 8, 'sha256');
  const chunks = [];
  const counts = {};
  for (const [entity, rows] of Object.entries(records)) {
    counts[entity] = rows.length;
    const payload = { entity, offset: 0, records: rows };
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const iv = crypto.randomBytes(spec.iv_bytes);
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
    format: spec.format,
    source_app: 'legenex-dashboard',
    target: 'dashflo',
    exported_at: new Date('2026-08-18T05:45:00.000Z').toISOString(),
    crypto: { ...spec, salt: salt.toString('base64') },
    counts,
    chunks,
    ...overrides,
  };
}

// Row counts for every entity table, so "preview wrote nothing" is checked
// against the whole database rather than the tables a test remembered to name.
async function businessRecordCounts(pool) {
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

describe.skipIf(!reachable)('owner migration preview over HTTP', () => {
  let pool;
  let server;
  let baseUrl;
  let cryptoSpec;
  let validPackage;
  const logLines = [];

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();

    ({ MIGRATION_CRYPTO: cryptoSpec } = await import('../src/functions/systemTransfer.generated.js'));
    validPackage = buildOwnerPackage(cryptoSpec, {
      Supplier: [{
        id: 'supplier-1', name: 'Preview Supplier', sid: 'PS1',
        created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z',
      }],
    });

    const express = (await import('express')).default;
    const { default: migrationRoutes } = await import('../src/routes/migrations.js');
    const app = express();
    app.use((req, _res, next) => { req.user = { ...OWNER }; next(); });
    app.use('/api/migrations', migrationRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logLines.length = 0;
  });

  function captureLogs() {
    logLines.length = 0;
    const sink = (...args) => { logLines.push(args.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
    vi.spyOn(console, 'error').mockImplementation(sink);
    return logLines;
  }

  // The browser appends kind, then the file, then the passphrase. The order is
  // reproduced because multipart field order has bitten multipart parsers
  // before, and this is the exact request production sends.
  async function preview({ bundle, passphrase = PASSPHRASE, mode = 'preview', bytes = null }) {
    const payload = bytes ?? Buffer.from(JSON.stringify(bundle), 'utf8');
    const form = new FormData();
    form.append('kind', 'owner');
    form.append('file', new Blob([payload], { type: 'application/json' }), 'legenex-dashflo-migration-2026-08-18-05-45.json.enc');
    form.append('passphrase', passphrase);
    const res = await fetch(`${baseUrl}/api/migrations/${mode}`, { method: 'POST', body: form });
    let body;
    try { body = JSON.parse(await res.text()); } catch { body = null; }
    return { status: res.status, body };
  }

  it('returns a complete preview for a valid owner package', async () => {
    const { status, body } = await preview({ bundle: validPackage });
    expect(status).toBe(200);
    expect(body.mode).toBe('preview');
    expect(body.kind).toBe('owner');
    expect(body.run_id).toMatch(/^[0-9a-f]{8,}$/i);
    expect(body.package_version).toBe(cryptoSpec.format);
    expect(body.entities_present).toContain('Supplier');
    expect(body.records_present).toBe(1);
    // Everything the panel reads has to be present, or it draws an empty card.
    for (const field of [
      'records_to_create', 'records_to_update', 'records_to_preserve', 'conflict_count', 'can_apply',
      'reconciliation', 'entity_reconciliation', 'explicit_exclusions', 'resolved_id_remaps',
      'id_collisions', 'id_collision_count', 'relationship_issues', 'relationship_issue_count',
      'relationship_alias_resolutions', 'relationship_alias_resolution_count',
      'unresolved_records', 'unresolved_count', 'hard_blockers', 'hard_blocker_count',
    ]) {
      expect(body, field).toHaveProperty(field);
    }
    // The reconciliation reaches the browser already balanced, so the panel
    // reports arithmetic rather than performing it.
    const r = body.reconciliation;
    expect(r.planned_creates + r.planned_updates + r.planned_preserves + r.explicit_exclusions + r.unresolved)
      .toBe(r.exported_records);
    expect(r.balanced).toBe(true);
  });

  it('never returns a decrypted credential value in the preview body', async () => {
    const secretive = buildOwnerPackage(cryptoSpec, {
      ApiKey: [{
        id: 'key-1', name: 'Preview key', supplier_id: 'supplier-1',
        key: 'lgnx_sup_preview_secret_value_do_not_leak',
        created_date: '2026-08-01T00:00:00.000Z', updated_date: '2026-08-02T00:00:00.000Z',
      }],
    });
    const { status, body } = await preview({ bundle: secretive });
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('lgnx_sup_preview_secret_value_do_not_leak');
    // The entity is named so the operator knows credentials are present.
    expect(Object.keys(body.credential_bearing_entities || {})).toContain('ApiKey');
  });

  it('refuses a wrong passphrase with a safe, stable, actionable code', async () => {
    const { status, body } = await preview({ bundle: validPackage, passphrase: 'an entirely wrong passphrase' });
    expect(status).toBe(400);
    expect(body.code).toBe('decrypt_failed');
    expect(body.error).toMatch(/passphrase/i);
    // Never says which of the two was wrong, and never echoes either.
    expect(body.error).not.toContain('an entirely wrong passphrase');
  });

  it('refuses a passphrase that is too short before touching the key derivation', async () => {
    const { status, body } = await preview({ bundle: validPackage, passphrase: 'short' });
    expect(status).toBe(400);
    expect(body.code).toBe('decrypt_failed');
  });

  it('refuses a malformed encrypted package', async () => {
    const { status, body } = await preview({ bundle: null, bytes: Buffer.from('this is not a migration package', 'utf8') });
    expect(status).toBe(400);
    expect(body.code).toBe('bad_upload');
    expect(body.error).toMatch(/not valid JSON/i);
  });

  it('refuses a package whose chunk list or envelope has been tampered with', async () => {
    const tampered = JSON.parse(JSON.stringify(validPackage));
    const raw = Buffer.from(tampered.chunks[0].ciphertext, 'base64');
    raw[0] ^= 0xff;
    tampered.chunks[0].ciphertext = raw.toString('base64');
    const { status, body } = await preview({ bundle: tampered });
    expect(status).toBe(400);
    expect(body.code).toBe('decrypt_failed');
  });

  it('reports schema validation failures distinctly from decryption failures', async () => {
    const wrongTarget = buildOwnerPackage(cryptoSpec, { Supplier: [] }, { target: 'somewhere-else' });
    const { status, body } = await preview({ bundle: wrongTarget });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
    expect(body.error).toMatch(/source or target/i);
  });

  it('rejects an unsupported package format', async () => {
    const wrongFormat = buildOwnerPackage(cryptoSpec, { Supplier: [] }, { format: 'something-else-v9' });
    const { status, body } = await preview({ bundle: wrongFormat });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });

  it('refuses a non-owner without disclosing anything about the package', async () => {
    const { default: migrationRoutes } = await import('../src/routes/migrations.js');
    const express = (await import('express')).default;
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'admin-1', base_role: 'admin', permissions: { set_export_import: true } };
      next();
    });
    app.use('/api/migrations', migrationRoutes);
    const other = app.listen(0);
    await new Promise((resolve) => other.once('listening', resolve));
    try {
      const form = new FormData();
      form.append('kind', 'owner');
      form.append('file', new Blob([Buffer.from(JSON.stringify(validPackage))]), 'pkg.json.enc');
      form.append('passphrase', PASSPHRASE);
      const res = await fetch(`http://127.0.0.1:${other.address().port}/api/migrations/preview`, { method: 'POST', body: form });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.code).toBe('unauthorized');
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('answers an unexpected server failure with a 500, a generic message, and a log line', async () => {
    // The database goes away underneath the request. This is the class of
    // failure that used to leave nothing behind at all.
    const logs = captureLogs();
    const spy = vi.spyOn(pool, 'query').mockRejectedValue(new Error('connection terminated unexpectedly'));
    let result;
    try {
      result = await preview({ bundle: validPackage });
    } finally {
      spy.mockRestore();
    }
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('internal');
    // Generic to the browser, specific in the log.
    expect(result.body.error).toBe('Migration import failed');
    expect(result.body.error).not.toContain('connection terminated');
    const failure = logs.find((l) => l.includes('[migration]') && l.includes('outcome=failed'));
    expect(failure, `no failure log line in: ${logs.join(' | ')}`).toBeTruthy();
    expect(failure).toContain('code=internal');
  });

  it('writes a structured log line for a start and for every ending', async () => {
    const logs = captureLogs();
    await preview({ bundle: validPackage });
    const started = logs.find((l) => l.includes('outcome=started'));
    const ok = logs.find((l) => l.includes('outcome=ok'));
    expect(started, 'no start line').toBeTruthy();
    expect(started).toContain('mode=preview');
    expect(started).toContain('kind=owner');
    expect(started).toMatch(/bytes=\d+/);
    expect(ok, 'no success line').toBeTruthy();
    expect(ok).toMatch(/run_id=\w+/);
    expect(ok).toMatch(/ms=\d+/);
  });

  it('never writes the passphrase to a log line', async () => {
    const logs = captureLogs();
    await preview({ bundle: validPackage });
    await preview({ bundle: validPackage, passphrase: 'another secret passphrase value' });
    const joined = logs.join('\n');
    expect(joined).not.toContain(PASSPHRASE);
    expect(joined).not.toContain('another secret passphrase value');
    expect(joined).not.toMatch(/passphrase=/i);
  });

  it('never persists the passphrase in the migration run record', async () => {
    await preview({ bundle: validPackage });
    const { rows } = await pool.query('SELECT * FROM migration_import_runs ORDER BY started_at DESC LIMIT 5');
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PASSPHRASE);
    // No field carries one either. The word itself does appear, inside the safe
    // refusal message the run records, which is the text an operator is meant to
    // read; what must never appear is a value under a key.
    expect(dump).not.toMatch(/"[a-z_]*passphrase[a-z_]*"\s*:/i);
    expect(dump).not.toMatch(/"[a-z_]*secret[a-z_]*"\s*:/i);
  });

  it('writes zero business records during a preview', async () => {
    const before = await businessRecordCounts(pool);
    await preview({ bundle: validPackage });
    await preview({ bundle: validPackage, passphrase: 'wrong passphrase entirely here' });
    const after = await businessRecordCounts(pool);
    expect(after).toEqual(before);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('refuses an apply that carries no fresh confirmation', async () => {
    // Preview and apply are separate decisions. An apply request without the
    // confirmation flag is refused before any record is written.
    const before = await businessRecordCounts(pool);
    const { status, body } = await preview({ bundle: validPackage, mode: 'apply' });
    expect(status).toBe(400);
    expect(body.code).toBe('not_confirmed');
    expect(await businessRecordCounts(pool)).toEqual(before);
  });
});
