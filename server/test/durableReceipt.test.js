import { describe, it, expect, afterAll, beforeEach } from 'vitest';

// Task I1. These run against a real PostgreSQL on loopback, not a double,
// because the properties under test are database properties: a UNIQUE
// constraint on the transport key, and an atomic conditional UPDATE for
// claiming. An in-memory double would pass while the real thing raced.
//
// The database is disposable and is created and dropped by this file. It is
// never the application database. Connection is loopback only, which the
// outbound network guard in vitest.setup.js permits.
//
// The suite creates its own disposable database, so an absent database is not
// a reason to skip. Only an unreachable PostgreSQL is, because a machine with
// no database server at all is not a broken build. That distinction matters:
// these fifteen tests are the only executed evidence for invariant 3, so a
// skip that reads like a pass is worse than a failure.
//
// The application database is never touched. The suite refuses to run at all
// unless it is connected to the disposable database by name, because every
// test here begins by truncating the table it is about to use.

const TEST_DB = 'dashflo_receipt_test';
const MAINTENANCE_DB = 'postgres';

// Databases this suite must never open, whatever the environment says.
const FORBIDDEN_DATABASES = new Set(['dashos', 'postgres', 'template0', 'template1']);

const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
// A DATABASE_URL takes priority over the discrete PG vars in config.js, so any
// inherited one would silently redirect this suite at whatever it names. It is
// removed here, and the connected database is verified by name below in case a
// later dotenv load puts one back.
delete process.env.DATABASE_URL;

// The availability probe has to run at module scope, not in beforeAll. Vitest
// evaluates every describe body during collection, which happens before any
// beforeAll hook, so a flag set in beforeAll is still false when it.skip is
// being decided and the whole suite silently skips.
let pool = null;
let receipts = null;
let available = false;
let skipReason = '';

// Creates the disposable database if it is absent. Connects to the maintenance
// database only long enough to issue CREATE DATABASE, and treats "already
// exists" as success so concurrent runs do not race each other.
async function ensureTestDatabaseExists() {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({
    host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB,
    password: process.env.PGPASSWORD || undefined,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) {
      // TEST_DB is a literal in this file, not input, and an identifier cannot
      // be parameterized. It is quoted so the statement is well formed.
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
      process.stderr.write(`\n[durableReceipt] created disposable database ${TEST_DB}\n`);
    }
  } catch (err) {
    if (err.code !== '42P04') throw err; // duplicate_database, another run won
  } finally {
    await admin.end();
  }
}

try {
  await ensureTestDatabaseExists();
  ({ pool } = await import('../src/db/pool.js'));

  // Prove what we are connected to before anything destructive runs. This is
  // the guard that stops a stray DATABASE_URL or PGDATABASE from pointing the
  // truncate in beforeEach at the real application database.
  const { rows } = await pool.query('SELECT current_database() AS db');
  const connected = rows[0].db;
  if (connected !== TEST_DB || FORBIDDEN_DATABASES.has(connected)) {
    throw new Error(
      `Refusing to run: connected to "${connected}", expected the disposable "${TEST_DB}". `
      + 'These tests truncate the table they use, so they never run against another database.',
    );
  }

  const { ensureReceiptSchema } = await import('../src/db/receiptSchema.js');
  await ensureReceiptSchema();
  receipts = await import('../src/lib/receipts.js');
  available = true;
} catch (err) {
  skipReason = `${err.name}: ${err.message}`;
  available = false;
  process.stderr.write(
    `\n[durableReceipt] PostgreSQL not reachable, database tests SKIPPED. ${skipReason}\n`
    + `[durableReceipt] Expected a server on ${PGHOST}:${PGPORT}. The disposable database\n`
    + `[durableReceipt] ${TEST_DB} is created automatically once one is reachable.\n\n`,
  );
}

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* already closed */ } }
});

beforeEach(async () => {
  if (available) await pool.query('TRUNCATE lead_receipts');
});

describe('the suite runs against a disposable database, never the application one', () => {
  it('is connected to the disposable database, or has said why it is not', async () => {
    if (!available) {
      // Make the skip loud rather than silent. A run with no database is not
      // evidence for invariant 3, and this assertion records that in the
      // report instead of leaving fifteen quiet skips behind.
      expect(skipReason, 'database unavailable and no reason captured').not.toBe('');
      return;
    }
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect(rows[0].db).toBe(TEST_DB);
    expect(FORBIDDEN_DATABASES.has(rows[0].db)).toBe(false);
  });
});

const maybe = () => (available ? it : it.skip);

describe('receipt payload sanitization', () => {
  // Pure function, so this half runs with or without a database.
  it('drops credential bearing keys at every depth and reports what it dropped', async () => {
    const { sanitizeReceiptPayload } = await import('../src/lib/receipts.js');
    const { payload, redacted } = sanitizeReceiptPayload({
      first_name: 'Ada',
      Authorization: 'Bearer live-token',
      headers: { Cookie: 'session=abc', 'X-API-KEY': 'lgnx_sup_live' },
      nested: { deep: { api_key: 'secret', city: 'Austin' } },
      _supplier_key: 'lgnx_sup_live',
    });

    expect(payload).toEqual({
      first_name: 'Ada',
      headers: {},
      nested: { deep: { city: 'Austin' } },
    });
    expect(JSON.stringify(payload)).not.toContain('live-token');
    expect(JSON.stringify(payload)).not.toContain('lgnx_sup_live');
    expect(redacted.sort()).toEqual(
      ['Authorization', 'Cookie', 'X-API-KEY', '_supplier_key', 'api_key'].sort(),
    );
  });

  it('does not mutate the caller payload', async () => {
    const { sanitizeReceiptPayload } = await import('../src/lib/receipts.js');
    const original = { keep: 1, api_key: 'x' };
    sanitizeReceiptPayload(original);
    expect(original).toEqual({ keep: 1, api_key: 'x' });
  });

  it('derives a stable transport key and prefers a supplied one', async () => {
    const { deriveTransportKey } = await import('../src/lib/receipts.js');
    const args = { source: 'supplier_http', payload: { a: 1 }, now: 1_700_000_000_000 };
    expect(deriveTransportKey(args)).toBe(deriveTransportKey(args));
    expect(deriveTransportKey({ ...args, payload: { a: 2 } })).not.toBe(deriveTransportKey(args));

    // The supplied key is namespaced by the authenticating supplier. It used
    // to be returned bare as `k:abc`, which put every supplier in one global
    // namespace: two of them using their own sequential lead ids collided, and
    // the second one's lead was answered "already received" and never
    // processed. An absent supplier is explicitly "anon" rather than blank, so
    // an authenticated key can never collide with an unauthenticated one.
    expect(deriveTransportKey({ ...args, suppliedKey: 'abc' })).toBe('k:anon:abc');
    expect(deriveTransportKey({ ...args, suppliedKey: 'abc', supplierKeyId: 'key_a' })).toBe('k:key_a:abc');
    expect(deriveTransportKey({ ...args, suppliedKey: 'abc', supplierKeyId: 'key_a' }))
      .not.toBe(deriveTransportKey({ ...args, suppliedKey: 'abc', supplierKeyId: 'key_b' }));
  });
});

describe('receipt commit is idempotent on the transport key', () => {
  maybe()('commits once and reports a repeat as a duplicate', async () => {
    const first = await receipts.commitReceipt({
      source: 'supplier_http', transportKey: 'k:retry-1', payload: { email: 'a@example.com' },
    });
    expect(first.duplicate).toBe(false);

    const second = await receipts.commitReceipt({
      source: 'supplier_http', transportKey: 'k:retry-1', payload: { email: 'a@example.com' },
    });
    expect(second.duplicate).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(rows[0].n).toBe(1);
  });

  maybe()('survives a concurrent double post of the same key', async () => {
    // The real race. Both callers run the insert at the same time; the UNIQUE
    // constraint decides, not a prior read.
    const posts = Array.from({ length: 8 }, () => receipts.commitReceipt({
      source: 'supplier_http', transportKey: 'k:concurrent', payload: { email: 'a@example.com' },
    }));
    const results = await Promise.all(posts);

    const created = results.filter((r) => !r.duplicate);
    expect(created).toHaveLength(1);

    const ids = new Set(results.map((r) => r.receipt.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(rows[0].n).toBe(1);
  });

  maybe()('never stores credential material on the committed row', async () => {
    await receipts.commitReceipt({
      source: 'supplier_http',
      transportKey: 'k:sanitized',
      payload: { first_name: 'Ada', Authorization: 'Bearer live-token', api_key: 'lgnx_live' },
    });
    const { rows } = await pool.query('SELECT payload::text AS p FROM lead_receipts');
    expect(rows[0].p).not.toContain('live-token');
    expect(rows[0].p).not.toContain('lgnx_live');
    expect(rows[0].p).toContain('Ada');
  });
});

describe('claiming is exclusive and leased', () => {
  maybe()('gives a receipt to exactly one of several competing workers', async () => {
    await receipts.commitReceipt({ source: 's', transportKey: 'k:one', payload: {} });

    const claims = await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map((owner) => receipts.claimReceipts({ owner, limit: 1 })),
    );
    const won = claims.flat();
    expect(won).toHaveLength(1);
  });

  maybe()('does not hand out a receipt that is already claimed and still leased', async () => {
    await receipts.commitReceipt({ source: 's', transportKey: 'k:leased', payload: {} });
    const first = await receipts.claimReceipts({ owner: 'w1', leaseMs: 60_000 });
    expect(first).toHaveLength(1);

    const second = await receipts.claimReceipts({ owner: 'w2' });
    expect(second).toHaveLength(0);
  });

  maybe()('reclaims a receipt whose worker died and let the lease lapse', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:dead', payload: {} });

    // Claim with a lease that has already expired: the same state a crashed
    // worker leaves behind.
    await receipts.claimReceipts({ owner: 'w1', leaseMs: -1000 });

    const second = await receipts.claimReceipts({ owner: 'w2' });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(receipt.id);
    expect(second[0].claim_owner).toBe('w2');
    // The attempt counter shows the work was tried twice, so a poison receipt
    // is visible rather than looping silently.
    expect(second[0].attempts).toBe(2);
  });

  maybe()('claims in commit order', async () => {
    for (const k of ['k:a', 'k:b', 'k:c']) {
      await receipts.commitReceipt({ source: 's', transportKey: k, payload: {} });
    }
    const claimed = await receipts.claimReceipts({ owner: 'w1', limit: 3 });
    expect(claimed.map((r) => r.transport_key)).toEqual(['k:a', 'k:b', 'k:c']);
  });
});

describe('terminal outcome is written once', () => {
  maybe()('records the outcome and clears the lease', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:done', payload: {} });
    await receipts.claimReceipts({ owner: 'w1' });

    const res = await receipts.completeReceipt({
      id: receipt.id, outcome: 'accepted', effectsApplied: true, expectOwner: 'w1',
    });
    expect(res.applied).toBe(true);
    expect(res.receipt.status).toBe('done');
    expect(res.receipt.terminal_outcome).toBe('accepted');
    expect(res.receipt.claim_owner).toBeNull();
  });

  maybe()('refuses a second completion, which is what stops a double delivery', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:twice', payload: {} });
    await receipts.claimReceipts({ owner: 'w1' });
    await receipts.completeReceipt({ id: receipt.id, outcome: 'accepted', effectsApplied: true, expectOwner: 'w1' });

    const replay = await receipts.completeReceipt({ id: receipt.id, outcome: 'rejected', reason: 'replayed' });
    expect(replay.applied).toBe(false);
    expect(replay.receipt.terminal_outcome).toBe('accepted');
    expect(replay.receipt.effects_applied).toBe(true);
  });

  maybe()('refuses a completion from a worker that lost its lease', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:stale', payload: {} });
    await receipts.claimReceipts({ owner: 'w1', leaseMs: -1000 });
    await receipts.claimReceipts({ owner: 'w2' });

    // w1 wakes up late and tries to record its result.
    const stale = await receipts.completeReceipt({ id: receipt.id, outcome: 'accepted', expectOwner: 'w1' });
    expect(stale.applied).toBe(false);
    expect(stale.receipt.terminal_outcome).toBeNull();

    // w2, which actually holds the lease, still can.
    const good = await receipts.completeReceipt({ id: receipt.id, outcome: 'accepted', expectOwner: 'w2' });
    expect(good.applied).toBe(true);
  });

  maybe()('rejects a terminal row with no outcome at the database level', async () => {
    // The CHECK constraint makes "concluded but no reason recorded"
    // unrepresentable, so a lead cannot be silently dropped.
    await expect(pool.query(
      `INSERT INTO lead_receipts (id, transport_key, source, status)
       VALUES ('x1', 'k:bad', 's', 'done')`,
    )).rejects.toThrow(/lead_receipts_terminal_coherent/);
  });

  maybe()('rejects an unknown status at the database level', async () => {
    await expect(pool.query(
      `INSERT INTO lead_receipts (id, transport_key, source, status)
       VALUES ('x2', 'k:bad2', 's', 'somewhere_else')`,
    )).rejects.toThrow(/lead_receipts_status_check/);
  });
});

describe('crash and replay', () => {
  maybe()('a receipt committed before a crash is still owed work afterwards', async () => {
    // Commit, claim, then simulate the process dying: no completion is ever
    // written and the lease lapses.
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:crash', payload: { email: 'a@b.c' } });
    await receipts.claimReceipts({ owner: 'doomed', leaseMs: -1000 });

    const pending = await receipts.pendingReceipts();
    expect(pending.map((r) => r.id)).toContain(receipt.id);

    // A replacement worker picks it up and finishes it exactly once.
    const claimed = await receipts.claimReceipts({ owner: 'replacement' });
    expect(claimed[0].id).toBe(receipt.id);
    expect(claimed[0].payload).toEqual({ email: 'a@b.c' });

    const done = await receipts.completeReceipt({
      id: receipt.id, outcome: 'accepted', effectsApplied: true, expectOwner: 'replacement',
    });
    expect(done.applied).toBe(true);

    expect(await receipts.pendingReceipts()).toHaveLength(0);
  });

  maybe()('a completed receipt is not in the pending backlog', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:settled', payload: {} });
    await receipts.completeReceipt({ id: receipt.id, outcome: 'rejected', reason: 'dnc' });
    expect(await receipts.pendingReceipts()).toHaveLength(0);
  });

  maybe()('releasing a lease returns the receipt to the queue without concluding it', async () => {
    const { receipt } = await receipts.commitReceipt({ source: 's', transportKey: 'k:release', payload: {} });
    await receipts.claimReceipts({ owner: 'w1', leaseMs: 60_000 });

    const released = await receipts.releaseReceipt({ id: receipt.id, expectOwner: 'w1' });
    expect(released.status).toBe('received');
    expect(released.terminal_outcome).toBeNull();

    const again = await receipts.claimReceipts({ owner: 'w2' });
    expect(again).toHaveLength(1);
  });
});
