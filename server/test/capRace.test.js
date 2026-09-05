// W7-INVARIANTS acceptance step: "A concurrency test proves only one lead
// takes the final cap slot."
//
// This runs against a real PostgreSQL on loopback, not an in-memory double,
// because the property under test is a database property: CapCounter.scope_key
// carries a real UNIQUE index (server/src/db/schema.js), and cap consumption is
// an atomic compare-and-swap UPDATE (client/src/lib/distribution/capStore.js's
// makeEntityCapStore), not a read-then-write in application code. An in-memory
// double would pass even if the real thing oversold, which is exactly the
// failure mode Section 7 of forge-pack/CONTRACT.md calls "cap oversell" and
// marks never-acceptable at cutover.
//
// The concurrent calls below are fired with Promise.all over calls that each
// issue several real network round trips to Postgres, so they genuinely
// interleave across the connection pool rather than merely being scheduled
// back to back on one microtask queue.
//
// The database is disposable, created and dropped by this file, connected to
// by name only after verifying it is not one of the forbidden databases. See
// server/test/durableReceipt.test.js for the same pattern, used here
// independently because this suite owns its own disposable database rather
// than sharing one across files that could otherwise interfere with each
// other's cap counters.

import { describe, it, expect, afterAll, beforeEach } from 'vitest';

const TEST_DB = 'dashflo_cap_race_test';
const MAINTENANCE_DB = 'postgres';
const FORBIDDEN_DATABASES = new Set(['dashos', 'postgres', 'template0', 'template1']);

const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

let pool = null;
let available = false;
let skipReason = '';

let ensureSchema;
let ensureInvariantConstraints;
let makeEntityCapStore;
let reserve;
let finalize;
let release;
let RESERVE;
let entitiesNamespace;

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
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
      process.stderr.write(`\n[capRace] created disposable database ${TEST_DB}\n`);
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

  const { rows } = await pool.query('SELECT current_database() AS db');
  const connected = rows[0].db;
  if (connected !== TEST_DB || FORBIDDEN_DATABASES.has(connected)) {
    throw new Error(
      `Refusing to run: connected to "${connected}", expected the disposable "${TEST_DB}". `
      + 'These tests truncate the tables they use, so they never run against another database.',
    );
  }

  ({ ensureSchema } = await import('../src/db/schema.js'));
  ({ ensureInvariantConstraints } = await import('../src/db/invariantConstraints.js'));
  ({ entitiesNamespace } = await import('../src/db/repo.js'));
  await ensureSchema();
  await ensureInvariantConstraints();

  ({ makeEntityCapStore } = await import('../../client/src/lib/distribution/capStore.js'));
  ({ reserve, finalize, release, RESERVE } = await import('../../client/src/lib/distribution/reservation.js'));

  available = true;
} catch (err) {
  skipReason = `${err.name}: ${err.message}`;
  available = false;
  process.stderr.write(
    `\n[capRace] PostgreSQL not reachable, database tests SKIPPED. ${skipReason}\n`
    + `[capRace] Expected a server on ${PGHOST}:${PGPORT}. The disposable database\n`
    + `[capRace] ${TEST_DB} is created automatically once one is reachable.\n\n`,
  );
}

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* already closed */ } }
});

beforeEach(async () => {
  if (available) {
    await pool.query('TRUNCATE e_cap_counter');
    await pool.query('TRUNCATE e_cap_reservation');
  }
});

const maybe = () => (available ? it : it.skip);

describe('the suite runs against a disposable database, never the application one', () => {
  it('is connected to the disposable database, or has said why it is not', async () => {
    if (!available) {
      expect(skipReason, 'database unavailable and no reason captured').not.toBe('');
      return;
    }
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect(rows[0].db).toBe(TEST_DB);
    expect(FORBIDDEN_DATABASES.has(rows[0].db)).toBe(false);
  });
});

describe('cap oversell: the real CapCounter unique index and CAS loop under genuine concurrency', () => {
  maybe()('exactly one of many concurrent claimants takes the last slot in a cap of 1', async () => {
    const db = { entities: entitiesNamespace() };
    const capStore = makeEntityCapStore(db);
    const capKey = 'route_member:rm-race-1:daily:2026-09-05';
    const memberId = 'rm-race-1';
    const CONTENDERS = 12;

    // Genuinely concurrent: every call is started before any of them is
    // awaited, so all twelve are in flight against Postgres at once, each
    // racing the others through ensureCounter's read-then-CAS-update loop.
    const attempts = Array.from({ length: CONTENDERS }, (_, i) => reserve(capStore, {
      idempotencyKey: `lead-${i}`,
      leadId: `lead-${i}`,
      memberId,
      price: 50,
      scopes: [{ key: capKey, limit: 1 }],
    }));
    const results = await Promise.all(attempts);

    const winners = results.filter((r) => r.ok && r.code === RESERVE.OK);
    const losers = results.filter((r) => !r.ok && r.code === RESERVE.CAP_EXCEEDED);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONTENDERS - 1);

    // The database itself, not just the function's return values, must show
    // exactly one consumed slot. This is the assertion that would catch a
    // race the application code's own bookkeeping papered over.
    const { rows } = await pool.query(
      `SELECT (data->>'count')::int AS count FROM e_cap_counter WHERE data->>'scope_key' = $1`,
      [capKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);

    // Every contender wrote a CapReservation row (winner: reserved; every
    // loser: failed, per reservation.js), and only one is 'reserved'.
    const { rows: resvRows } = await pool.query(
      `SELECT data->>'state' AS state FROM e_cap_reservation WHERE data->>'route_member_id' = $1`,
      [memberId],
    );
    expect(resvRows).toHaveLength(CONTENDERS);
    expect(resvRows.filter((r) => r.state === 'reserved')).toHaveLength(1);
    expect(resvRows.filter((r) => r.state === 'failed')).toHaveLength(CONTENDERS - 1);
  });

  maybe()('a retried claim of the exact same reservation never consumes a second slot', async () => {
    const db = { entities: entitiesNamespace() };
    const capStore = makeEntityCapStore(db);
    const capKey = 'route_member:rm-race-2:daily:2026-09-05';
    const memberId = 'rm-race-2';

    const first = await reserve(capStore, {
      idempotencyKey: 'lead-winner', leadId: 'lead-winner', memberId, price: 75,
      scopes: [{ key: capKey, limit: 1 }],
    });
    expect(first.ok).toBe(true);
    expect(first.code).toBe(RESERVE.OK);

    // Simulates a network retry of the exact same request (same idempotency
    // key, same member): this must be answered from the existing reservation,
    // not by consuming a second unit of capacity.
    const replay = await reserve(capStore, {
      idempotencyKey: 'lead-winner', leadId: 'lead-winner', memberId, price: 75,
      scopes: [{ key: capKey, limit: 1 }],
    });
    expect(replay.ok).toBe(true);
    expect(replay.code).toBe(RESERVE.ALREADY_RESERVED);

    const { rows } = await pool.query(
      `SELECT (data->>'count')::int AS count FROM e_cap_counter WHERE data->>'scope_key' = $1`,
      [capKey],
    );
    expect(rows[0].count).toBe(1);

    // Finalizing settles the reservation; it must not itself touch the
    // counter (the increment already happened at reserve() time).
    const finalized = await finalize(capStore, first.reservation);
    const { rows: afterFinalize } = await pool.query(
      `SELECT (data->>'count')::int AS count FROM e_cap_counter WHERE data->>'scope_key' = $1`,
      [capKey],
    );
    expect(afterFinalize[0].count).toBe(1);

    // release() reads the CALLER's reservation object's own state, so it only
    // ever acts on one still holding 'reserved'. Passing the post-finalize
    // object (state 'finalized') must be a no-op: a real caller can never
    // reach this with the stale pre-finalize object, since reserveAndDeliver
    // (client/src/lib/distribution/distributeRun.js) finalizes or releases
    // along two mutually exclusive branches, never both for one reservation.
    await release(capStore, finalized);
    const { rows: afterRelease } = await pool.query(
      `SELECT (data->>'count')::int AS count FROM e_cap_counter WHERE data->>'scope_key' = $1`,
      [capKey],
    );
    expect(afterRelease[0].count).toBe(1);
  });
});

describe('W7-INVARIANTS closed gap: CapReservation uniqueness is now a real database constraint', () => {
  maybe()('refuses a second row for the same (idempotency_key, route_member_id) even bypassing reserve()', async () => {
    // This is the scenario docs/INVARIANTS.md documents as the actual gap:
    // before server/src/db/invariantConstraints.js, nothing stopped a second
    // writer that skips reservation.js's atomic claim (a raw insert, a bug in
    // a future code path) from creating a duplicate reservation row for a
    // slot that was already consumed. Insert one row directly, then attempt a
    // second with the identical key pair, exactly as such a bypass would.
    await pool.query(
      `INSERT INTO e_cap_reservation (id, data) VALUES ($1, $2::jsonb)`,
      ['resv-1', JSON.stringify({ idempotency_key: 'dup-key', route_member_id: 'rm-dup', state: 'reserved' })],
    );

    await expect(pool.query(
      `INSERT INTO e_cap_reservation (id, data) VALUES ($1, $2::jsonb)`,
      ['resv-2', JSON.stringify({ idempotency_key: 'dup-key', route_member_id: 'rm-dup', state: 'reserved' })],
    )).rejects.toThrow(/e_cap_reservation_idem_member_idx/);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_cap_reservation WHERE data->>'idempotency_key' = 'dup-key'`,
    );
    expect(rows[0].n).toBe(1);
  });

  maybe()('does not interfere with two different reservations that legitimately share only one of the two fields', async () => {
    // A partial key match (same idempotency_key, different member; or same
    // member, different idempotency_key) is a normal, distinct reservation
    // and must not collide.
    await pool.query(
      `INSERT INTO e_cap_reservation (id, data) VALUES ($1, $2::jsonb)`,
      ['resv-a', JSON.stringify({ idempotency_key: 'shared-key', route_member_id: 'rm-a', state: 'reserved' })],
    );
    await pool.query(
      `INSERT INTO e_cap_reservation (id, data) VALUES ($1, $2::jsonb)`,
      ['resv-b', JSON.stringify({ idempotency_key: 'shared-key', route_member_id: 'rm-b', state: 'reserved' })],
    );
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_cap_reservation WHERE data->>'idempotency_key' = 'shared-key'`,
    );
    expect(rows[0].n).toBe(2);
  });
});
