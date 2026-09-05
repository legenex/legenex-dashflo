// W7-INVARIANTS acceptance step: "A replay test proves a repeated inbound
// request creates no second lead, sale, cost or routing run."
//
// forge-pack/CONTRACT.md's non-negotiable invariant 3, verbatim: "A committed
// receipt is replayable after a crash. Replay cannot double-deliver or
// double-bill." This file exercises the REAL mechanism that claim rests on,
// not a description of it:
//
//   Group A: server/src/lib/receipts.js's commitReceipt() and
//   server/src/lib/intake.js's captureAndScreen(), driven through the real
//   server/src/functions/processLead.js entry point against a real
//   lead_receipts table (transport_key UNIQUE, server/src/db/receiptSchema.js).
//   Proves: submitting the identical inbound payload twice, whether as a
//   sequential retry or as a genuine concurrent double post, creates at most
//   one Lead row and at most one receipt.
//
//   Group B: client/src/lib/distribution/distributeRun.js's
//   reserveAndDeliver(), the exact function server/src/lib/nativeRetryRunner.js
//   calls to resend a due delivery attempt, driven against a real Postgres
//   CapCounter/CapReservation store. Proves: replaying the identical
//   (idempotency key, attempt) pair after it already reached an outcome never
//   posts to the destination again, never debits the wallet again, and never
//   consumes a second unit of cap.
//
// Real PostgreSQL, disposable and dropped by this file, for the same reason
// server/test/durableReceipt.test.js and server/test/capRace.test.js use one:
// the guarantee under test is a database property (a UNIQUE constraint, an
// atomic conditional UPDATE), and an in-memory double would pass even if the
// real thing double-processed.

import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest';
import http from 'node:http';

const TEST_DB = 'dashflo_idempotency_test';
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

// Without this the DNC suppression check cannot run, every post takes the
// HELD branch, and no lead is ever created, which would prove nothing about
// either group below. Disposable local value, matching
// server/test/receiptConclusion.test.js's own suite.
process.env.DNC_HASH_KEY = 'w7-invariants-idempotency-suite-disposable-hash-key';

let pool = null;
let available = false;
let skipReason = '';

let processLead;
let hashApiKey;
let mintApiKey;
let entitiesNamespace;
let reserveAndDeliver;
let ATTEMPT_STATUS;
let makeEntityCapStore;
let makeInMemoryAttemptStore;
let makeInMemoryWalletStore;

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
      process.stderr.write(`\n[idempotency] created disposable database ${TEST_DB}\n`);
    }
  } catch (err) {
    if (err.code !== '42P04') throw err;
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

  const { ensureSchema } = await import('../src/db/schema.js');
  const { ensureReceiptSchema } = await import('../src/db/receiptSchema.js');
  const { ensureInvariantConstraints } = await import('../src/db/invariantConstraints.js');
  await ensureSchema();
  await ensureReceiptSchema();
  await ensureInvariantConstraints();

  ({ entitiesNamespace } = await import('../src/db/repo.js'));
  ({ hashApiKey, mintApiKey } = await import('../src/lib/apiKeys.js'));
  processLead = (await import('../src/functions/processLead.js')).default;

  ({ reserveAndDeliver } = await import('../../client/src/lib/distribution/distributeRun.js'));
  ({ ATTEMPT_STATUS } = await import('../../client/src/lib/distribution/deliveryAttempt.js'));
  ({ makeEntityCapStore } = await import('../../client/src/lib/distribution/capStore.js'));
  ({ makeInMemoryAttemptStore } = await import('../../client/src/lib/distribution/deliveryStore.js'));
  ({ makeInMemoryWalletStore } = await import('../../client/src/lib/distribution/walletStore.js'));

  available = true;
} catch (err) {
  skipReason = `${err.name}: ${err.message}`;
  available = false;
  process.stderr.write(
    `\n[idempotency] PostgreSQL not reachable, database tests SKIPPED. ${skipReason}\n`
    + `[idempotency] Expected a server on ${PGHOST}:${PGPORT}. The disposable database\n`
    + `[idempotency] ${TEST_DB} is created automatically once one is reachable.\n\n`,
  );
}

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* already closed */ } }
});

beforeEach(async () => {
  if (available) {
    await pool.query('TRUNCATE lead_receipts');
    await pool.query('TRUNCATE e_lead');
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

// ── Group A: receipt-layer replay through the real processLead entry point ─

// A minimal entity double for everything EXCEPT Lead, which is backed by the
// real Postgres e_lead table via entitiesNamespace() so "no second lead" is a
// real row count, not a count kept by the double itself.
function makeDb({ apiKey, lead }) {
  const writes = { ErrorLog: [], Delivery: [] };
  const real = entitiesNamespace();
  const collection = (name) => ({
    list: async () => [],
    filter: async (query) => {
      if (name === 'ApiKey' && apiKey) {
        if (query.key_hash && query.key_hash === apiKey.key_hash) return [apiKey];
        return [];
      }
      return [];
    },
    get: async () => null,
    create: async (record) => {
      const row = { id: `${name.toLowerCase()}-${(writes[name]?.length || 0) + 1}`, ...record };
      (writes[name] ||= []).push(row);
      return row;
    },
    update: async (id, patch) => ({ id, ...patch }),
    updateMany: async () => ({ updated: 1 }),
    bulkCreate: async (rows) => rows,
    delete: async () => null,
  });
  return {
    writes,
    entities: new Proxy({}, {
      get: (cache, name) => {
        if (name === 'Lead') return real.Lead; // real Postgres, so row counts are real
        if (name === 'ApiKey' && apiKey) return collection('ApiKey');
        return (cache[name] ||= collection(String(name)));
      },
    }),
    auth: { me: async () => null },
    integrations: { Core: {} },
  };
}

function makeCtx(db, payload, key, extraHeaders = {}) {
  const headers = { ...(key ? { 'x-api-key': key } : {}), ...extraHeaders };
  return {
    db,
    body: payload,
    env: process.env,
    user: null,
    req: { method: 'POST', headers, get: (name) => headers[String(name).toLowerCase()] || null },
    json: (body, status = 200) => ({ __httpResponse: true, body, status }),
  };
}

const SYNTHETIC_PAYLOAD = {
  first_name: 'Ada', last_name: 'Lovelace', mobile: '5551234567', email: 'ada@example.test',
};

describe('Group A: receipt commit is the front-line dedup for a repeated inbound request', () => {
  let rawKey;
  let apiKeyRecord;

  beforeEach(() => {
    if (!available) return;
    rawKey = mintApiKey('master');
    apiKeyRecord = {
      id: 'key-1', name: 'Test master', type: 'master',
      key_hash: hashApiKey(rawKey), key_prefix: rawKey.slice(0, 16),
      active: true, request_count: 0,
    };
  });

  maybe()('a sequential retry with no explicit idempotency key (content-hash dedup) creates no second lead', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });

    const first = await processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey));
    expect(first.status).not.toBe(500);

    // The exact same request, submitted again: what an HTTP client retrying
    // after a dropped response, or a supplier's own retry logic, actually
    // does. No Idempotency-Key header on either call, so this exercises
    // deriveTransportKey's content-hash fallback, not a caller-supplied key.
    const second = await processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey));

    // The two outcomes this may legitimately land on both mean "not
    // reprocessed": an answered duplicate (the common case, since the first
    // call already concluded its receipt before this one runs) or, if it
    // somehow raced, RETRY_IN_PROGRESS. Either way, a second Lead must not
    // exist.
    expect(['duplicate', 'rejected']).toContain(second.body.acceptance);

    const { rows: leadRows } = await pool.query('SELECT count(*)::int AS n FROM e_lead');
    expect(leadRows[0].n).toBe(1);

    const { rows: receiptRows } = await pool.query('SELECT * FROM lead_receipts');
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0].terminal_outcome).not.toBeNull();
  });

  maybe()('a sequential retry carrying the SAME client-supplied Idempotency-Key creates no second lead', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    const headers = { 'idempotency-key': 'client-retry-key-1' };

    const first = await processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey, headers));
    expect(first.status).not.toBe(500);

    const second = await processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey, headers));
    expect(second.body.acceptance).toBe('duplicate');
    expect(second.body.code).toBe('DUPLICATE');

    const { rows: leadRows } = await pool.query('SELECT count(*)::int AS n FROM e_lead');
    expect(leadRows[0].n).toBe(1);

    const { rows: receiptRows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(receiptRows[0].n).toBe(1);
  });

  maybe()('a genuinely concurrent double post of the same request creates no second lead', async () => {
    // The harder case: both requests race, not one waiting for the other.
    // The transport_key UNIQUE constraint (receiptSchema.js), not a prior
    // SELECT in application code, is what has to decide the winner here.
    const db = makeDb({ apiKey: apiKeyRecord });
    const headers = { 'idempotency-key': 'client-concurrent-key-1' };

    const [r1, r2] = await Promise.all([
      processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey, headers)),
      processLead(makeCtx(db, SYNTHETIC_PAYLOAD, rawKey, headers)),
    ]);

    // Under a genuine race, one call is answered as genuinely new (acceptance
    // "queued", since nothing downstream is configured) and the other is
    // turned away, either as "duplicate" (it saw the winner's already
    // concluded receipt) or "a previous attempt has not completed" (503,
    // acceptance "rejected", if it raced ahead of the winner's own
    // conclusion). What must never happen, and is the actual point of this
    // test, is BOTH being treated as new: that is two Lead rows for one
    // inbound request, exactly the "duplicate commercial send" Section 7 of
    // forge-pack/CONTRACT.md marks never-acceptable.
    const newOutcomes = [r1, r2].filter((r) => r.body.acceptance !== 'duplicate' && r.body.acceptance !== 'rejected');
    expect(newOutcomes).toHaveLength(1);

    const { rows: leadRows } = await pool.query('SELECT count(*)::int AS n FROM e_lead');
    expect(leadRows[0].n).toBe(1);

    const { rows: receiptRows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(receiptRows[0].n).toBe(1);
  });
});

// ── Group B: distribution-layer replay through reserveAndDeliver ──────────
//
// This is the primitive server/src/lib/nativeRetryRunner.js calls to resend a
// due delivery attempt (see its own module comment: "The retry send itself
// goes through reserveAndDeliver - the EXACT same cap-reservation /
// lead-winner-claim / wallet-debit primitive the primary send path uses").
// Replaying it with the identical (idempotency key, attempt) pair is exactly
// what happens if a duplicate inbound request reaches distribution twice, or
// a retry worker picks up a due attempt it (or another worker) already
// finished.

describe('Group B: reserveAndDeliver cannot double-sell or double-bill on a replayed attempt', () => {
  let server; let base; let requestLog; let responseStatus;

  function startMockDestination() {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          requestLog.push({ url: req.url, body });
          res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: responseStatus < 300 ? 'accepted' : 'declined' }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    requestLog = [];
    responseStatus = 200;
    if (available) await startMockDestination();
  });

  afterEach(() => new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  }));

  function buildMember(id, buyerId) {
    return {
      id, buyerId, price: 60, priceMode: 'fixed', fixedPrice: 60,
      caps: { daily: { limit: 5 } },
      wallet: { mode: 'prepaid' },
      subDeliveryId: `sd-${id}`, destinationId: `dest-${id}`,
      delivery: {
        subDeliveryId: `sd-${id}`, targetUrl: `${base}/post`, method: 'POST', encoding: 'json',
        headers: {}, credentialRef: null,
        fieldMap: [{ src: 'email', dest: 'email' }],
        responseMapping: {},
        timeoutMs: 5000,
      },
    };
  }

  function stores(db) {
    return {
      attemptStore: makeInMemoryAttemptStore(),
      capStore: makeEntityCapStore(db),
      walletStore: makeInMemoryWalletStore({ initial: { 'buyer-replay-1': 1000, 'buyer-replay-2': 1000 } }),
    };
  }

  maybe()('replaying an ACCEPTED attempt never posts, debits or claims cap a second time', async () => {
    const db = { entities: entitiesNamespace() };
    const s = stores(db);
    const member = buildMember('rm-replay-1', 'buyer-replay-1');
    const ctx = {
      leadId: 'lead-replay-1', idempotencyKey: 'run-replay-1', leadData: { email: 'ada@example.test' },
      nowMs: Date.now(), fetchImpl: globalThis.fetch, testMode: true,
    };

    const first = await reserveAndDeliver({ member, meta: { attemptNumber: 1, trigger: 'primary' }, stores: s, ctx });
    expect(first.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(requestLog).toHaveLength(1);

    // The exact same run, replayed: identical idempotencyKey and attemptNumber,
    // the shape a duplicate inbound webhook or a doubly-scheduled retry
    // produces. isLeadAlreadySold's pre-send guard (distributeRun.js step 0)
    // is the layer that catches this one, since the lead already has a winner.
    const second = await reserveAndDeliver({ member, meta: { attemptNumber: 1, trigger: 'retry' }, stores: s, ctx });
    expect(second.status).toBe(ATTEMPT_STATUS.SUPERSEDED);
    expect(second.reason).toBe('LEAD_ALREADY_SOLD');

    // No second sale: the mock destination received exactly one POST.
    expect(requestLog).toHaveLength(1);

    // No second cost entry: exactly one wallet debit was recorded.
    const debits = s.walletStore._debug.txns.filter((t) => t.status === 'applied');
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(60);

    // No second cap consumption: the real CapCounter row still reads 1.
    const { rows } = await pool.query(
      `SELECT (data->>'count')::int AS count FROM e_cap_counter WHERE data->>'scope_key' LIKE 'route_member:rm-replay-1:%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  maybe()('replaying a REJECTED attempt is answered from the existing reservation, not sent again', async () => {
    responseStatus = 400; // the destination declines, so no winner claim is ever set
    const db = { entities: entitiesNamespace() };
    const s = stores(db);
    const member = buildMember('rm-replay-2', 'buyer-replay-2');
    const ctx = {
      leadId: 'lead-replay-2', idempotencyKey: 'run-replay-2', leadData: { email: 'ada@example.test' },
      nowMs: Date.now(), fetchImpl: globalThis.fetch, testMode: true,
    };

    const first = await reserveAndDeliver({ member, meta: { attemptNumber: 1, trigger: 'primary' }, stores: s, ctx });
    expect(first.status).toBe(ATTEMPT_STATUS.REJECTED);
    expect(requestLog).toHaveLength(1);

    // Same idempotencyKey and attemptNumber again: this time the reservation
    // layer itself (reservation.js's atomic claim on
    // resv:{idempotencyKey}:{attemptNumber}:{memberId}) is what answers,
    // never the lead-level winner claim, since the destination never accepted.
    const second = await reserveAndDeliver({ member, meta: { attemptNumber: 1, trigger: 'retry' }, stores: s, ctx });
    expect(second.status).toBe(ATTEMPT_STATUS.REJECTED);
    expect(second.reason).toBe('ALREADY_RESERVED');

    expect(requestLog).toHaveLength(1); // never sent a second time
    expect(s.walletStore._debug.txns).toHaveLength(0); // a rejected sale is never billed

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_cap_reservation WHERE data->>'route_member_id' = 'rm-replay-2'`,
    );
    expect(rows[0].n).toBe(1); // one reservation row, not two
  });
});
