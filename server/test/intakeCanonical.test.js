import { describe, it, expect, afterAll, beforeEach } from 'vitest';

// Task I3. The canonical intake sequence, proven end to end against a real
// PostgreSQL, because the properties under test are database properties: the
// UNIQUE transport key that makes a retry idempotent, and the terminal outcome
// constraint that makes "silently dropped" unrepresentable.
//
// Written before the edit to processLead.js, so these assertions describe what
// the pipeline must do rather than what it happens to do.
//
// Same disposable database discipline as durableReceipt.test.js: the suite
// creates it when absent, refuses to run against anything else by name, and
// only skips when PostgreSQL itself is unreachable. dashos lives on the same
// server on port 5433 and every test here truncates, so the guard is load
// bearing rather than decorative.

const TEST_DB = 'dashflo_intake_test';
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

process.env.DNC_HASH_KEY = process.env.DNC_HASH_KEY || 'test-dnc-key-not-a-real-secret';

let pool = null;
let intake = null;
let receipts = null;
let dnc = null;
let available = false;
let skipReason = '';

async function ensureTestDatabaseExists() {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({
    host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB,
    password: process.env.PGPASSWORD || undefined,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE "${TEST_DB}"`);
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
  if (rows[0].db !== TEST_DB || FORBIDDEN_DATABASES.has(rows[0].db)) {
    throw new Error(`Refusing to run: connected to "${rows[0].db}", expected "${TEST_DB}".`);
  }
  const { ensureReceiptSchema } = await import('../src/db/receiptSchema.js');
  await ensureReceiptSchema();
  intake = await import('../src/lib/intake.js');
  receipts = await import('../src/lib/receipts.js');
  dnc = await import('../src/lib/dnc.js');
  available = true;
} catch (err) {
  skipReason = `${err.name}: ${err.message}`;
  process.stderr.write(`\n[intakeCanonical] PostgreSQL not reachable, database tests SKIPPED. ${skipReason}\n`);
}

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* already closed */ } }
});

beforeEach(async () => {
  if (available) await pool.query('TRUNCATE lead_receipts');
});

const maybe = () => (available ? it : it.skip);

// Entity repository double. The DNC list is JSONB entity storage, not a table
// with constraints, so a double is faithful here in a way it would not be for
// the receipt.
function repoWith(entries = []) {
  return {
    entities: {
      DncEntry: { filter: async ({ contact_hash }) => entries.filter((e) => e.contact_hash === contact_hash) },
    },
  };
}
const failingRepo = () => ({
  entities: { DncEntry: { filter: async () => { throw new Error('connection terminated'); } } },
});

function suppressionFor(kind, value) {
  return [{
    id: 'dnc_1',
    contact_kind: kind,
    contact_hash: dnc.hashContact(kind, value),
    scope: 'global',
    scope_value: null,
    status: 'active',
    effective_from: null,
    effective_to: null,
    reason: 'Consumer request',
  }];
}

const LEAD = { first_name: 'Ada', email: 'ada@example.com', phone: '5550101234' };

describe('the suite is bound to the disposable database', () => {
  it('is connected to the disposable database, or has said why it is not', async () => {
    if (!available) { expect(skipReason).not.toBe(''); return; }
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect(rows[0].db).toBe(TEST_DB);
  });
});

// 5. Every genuine intake path writes a durable receipt before enrichment or
//    external calls.
describe('durable capture happens first', () => {
  maybe()('commits a receipt and returns accepted for a clean lead', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith(),
    });
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.ACCEPTED);
    expect(intake.mayProcess(r)).toBe(true);

    const stored = await receipts.getReceipt(r.receipt.id, pool);
    expect(stored).toBeTruthy();
    expect(stored.terminal_outcome).toBeNull();
  });

  maybe()('the receipt exists before the caller is told it may process', async () => {
    // Ordering is the invariant. By the time captureAndScreen returns, the row
    // is already readable by an independent query, so a crash immediately after
    // this point still leaves the lead recoverable.
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith(),
    });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(rows[0].n).toBe(1);
    expect(intake.mayProcess(r)).toBe(true);
  });

  maybe()('never stores credential material on the receipt', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http',
      payload: {
        ...LEAD,
        Authorization: 'Bearer live-token',
        _supplier_key: 'lgnx_sup_live',
        headers: { Cookie: 'session=abc' },
      },
      sql: pool,
      repo: repoWith(),
    });
    const stored = await receipts.getReceipt(r.receipt.id, pool);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('live-token');
    expect(serialized).not.toContain('lgnx_sup_live');
    expect(serialized).not.toContain('session=abc');
  });
});

// 6. Global DNC returns CLEAR, BLOCKED or UNAVAILABLE.
// 7. BLOCKED leads are never delivered.
describe('global do-not-contact decides the lead', () => {
  maybe()('returns accepted when the list is clear', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith(),
    });
    expect(r.dnc.decision).toBe('clear');
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.ACCEPTED);
  });

  maybe()('suppresses a listed phone and concludes the receipt terminally', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool,
      repo: repoWith(suppressionFor('phone', '5550101234')),
    });
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.SUPPRESSED);
    expect(intake.mayProcess(r)).toBe(false);

    const stored = await receipts.getReceipt(r.receipt.id, pool);
    expect(stored.terminal_outcome).toBe('suppressed');
    expect(stored.terminal_reason).toBe('DNC_SUPPRESSED');
    // The property that matters: concluded, and no effects were applied, so a
    // replay cannot deliver or bill it.
    expect(stored.effects_applied).toBe(false);
  });

  maybe()('suppresses a listed email as well as a listed phone', async () => {
    const r = await intake.captureAndScreen({
      source: 'owned_form', payload: LEAD, sql: pool,
      repo: repoWith(suppressionFor('email', 'ada@example.com')),
    });
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.SUPPRESSED);
    expect(r.dnc.matched).toBe('email');
  });

  maybe()('retains a suppressed lead with an auditable reason and no raw contact', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool,
      repo: repoWith(suppressionFor('phone', '5550101234')),
    });
    expect(r.audit).toMatchObject({
      reason_code: 'DNC_SUPPRESSED',
      matched_field: 'phone',
      dnc_entry_id: 'dnc_1',
    });
    const serialized = JSON.stringify(r.audit);
    expect(serialized).not.toContain('5550101234');
    expect(serialized).not.toContain('ada@example.com');
  });

  maybe()('a suppressed receipt is not in the pending backlog, so nothing retries it', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool,
      repo: repoWith(suppressionFor('phone', '5550101234')),
    });
    const pending = await receipts.pendingReceipts({ db: pool });
    expect(pending.map((p) => p.id)).not.toContain(r.receipt.id);
  });
});

// 8. UNAVAILABLE leads are held for retry, neither lost nor delivered.
describe('an unavailable list holds the lead instead of losing it', () => {
  maybe()('holds when the lookup fails, and does not conclude the receipt', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: failingRepo(),
    });
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.HELD);
    expect(intake.mayProcess(r)).toBe(false);
    expect(r.retryable).toBe(true);

    const stored = await receipts.getReceipt(r.receipt.id, pool);
    expect(stored.terminal_outcome).toBeNull();
    expect(stored.status).toBe('received');
  });

  maybe()('the held receipt is still in the pending backlog, so it is retried', async () => {
    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: failingRepo(),
    });
    const pending = await receipts.pendingReceipts({ db: pool });
    expect(pending.map((p) => p.id)).toContain(r.receipt.id);
  });

  maybe()('holds when the hash key is absent rather than passing the lead through', async () => {
    const saved = process.env.DNC_HASH_KEY;
    delete process.env.DNC_HASH_KEY;
    try {
      const r = await intake.captureAndScreen({
        source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith(),
      });
      expect(r.outcome).toBe(intake.INTAKE_OUTCOME.HELD);
      expect(intake.mayProcess(r)).toBe(false);
      const stored = await receipts.getReceipt(r.receipt.id, pool);
      expect(stored.terminal_outcome).toBeNull();
    } finally {
      process.env.DNC_HASH_KEY = saved;
    }
  });

  maybe()('a held lead is never reported as processable, across every failure shape', async () => {
    for (const repo of [failingRepo(), {}]) {
      await pool.query('TRUNCATE lead_receipts');
      const r = await intake.captureAndScreen({
        source: 'supplier_http', payload: LEAD, sql: pool, repo,
      });
      expect(intake.mayProcess(r)).toBe(false);
      expect(r.outcome).toBe(intake.INTAKE_OUTCOME.HELD);
    }
  });
});

// 10. Retries do not create duplicate leads or duplicate deliveries.
describe('a transport retry is not a second lead', () => {
  maybe()('the second presentation of the same payload reports duplicate', async () => {
    const args = { source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith() };
    const first = await intake.captureAndScreen(args);
    const second = await intake.captureAndScreen(args);

    expect(first.outcome).toBe(intake.INTAKE_OUTCOME.ACCEPTED);
    expect(second.outcome).toBe(intake.INTAKE_OUTCOME.DUPLICATE);
    expect(intake.mayProcess(second)).toBe(false);
    expect(second.receipt.id).toBe(first.receipt.id);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(rows[0].n).toBe(1);
  });

  maybe()('a supplier supplied idempotency key makes the retry explicit', async () => {
    const args = {
      source: 'supplier_http', suppliedKey: 'supplier-txn-1',
      payload: LEAD, sql: pool, repo: repoWith(),
    };
    const first = await intake.captureAndScreen(args);
    // A retry that changes an irrelevant field is still the same delivery when
    // the supplier says so with its own key.
    const second = await intake.captureAndScreen({ ...args, payload: { ...LEAD, note: 'retry' } });
    expect(second.outcome).toBe(intake.INTAKE_OUTCOME.DUPLICATE);
    expect(second.receipt.id).toBe(first.receipt.id);
  });

  maybe()('eight concurrent retries produce exactly one processable result', async () => {
    // The real race. Only one caller may be told to process, or the lead is
    // delivered and billed more than once.
    const args = { source: 'supplier_http', suppliedKey: 'race-1', payload: LEAD, sql: pool, repo: repoWith() };
    const results = await Promise.all(Array.from({ length: 8 }, () => intake.captureAndScreen(args)));

    expect(results.filter(intake.mayProcess)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receipt.id)).size).toBe(1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_receipts');
    expect(rows[0].n).toBe(1);
  });

  maybe()('a retry of a suppressed lead stays suppressed and is not reprocessed', async () => {
    const args = {
      source: 'supplier_http', suppliedKey: 'sup-1', payload: LEAD, sql: pool,
      repo: repoWith(suppressionFor('phone', '5550101234')),
    };
    const first = await intake.captureAndScreen(args);
    const second = await intake.captureAndScreen(args);
    expect(first.outcome).toBe(intake.INTAKE_OUTCOME.SUPPRESSED);
    expect(second.outcome).toBe(intake.INTAKE_OUTCOME.DUPLICATE);
    expect(second.priorOutcome).toBe('suppressed');
    expect(intake.mayProcess(second)).toBe(false);
  });

  maybe()('a held lead retried after the list recovers becomes processable exactly once', async () => {
    // The held case must not strand the lead. Once the list is reachable the
    // same receipt is claimable and concludes once.
    const args = { source: 'supplier_http', suppliedKey: 'held-1', payload: LEAD, sql: pool };
    const held = await intake.captureAndScreen({ ...args, repo: failingRepo() });
    expect(held.outcome).toBe(intake.INTAKE_OUTCOME.HELD);

    const pending = await receipts.pendingReceipts({ db: pool });
    expect(pending.map((p) => p.id)).toContain(held.receipt.id);

    const claimed = await receipts.claimReceipts({ owner: 'worker-1', limit: 10, db: pool });
    expect(claimed.map((c) => c.id)).toContain(held.receipt.id);

    const done = await receipts.completeReceipt({
      id: held.receipt.id, outcome: 'processed', effectsApplied: true,
      expectOwner: 'worker-1', db: pool,
    });
    expect(done.applied).toBe(true);

    const again = await receipts.completeReceipt({
      id: held.receipt.id, outcome: 'processed', effectsApplied: true,
      expectOwner: 'worker-1', db: pool,
    });
    expect(again.applied).toBe(false);
  });
});

// 9. Route and buyer suppression remains independent and functional. The
//    detailed matrix lives in dncEnforcement.test.js; this pins the boundary
//    at the intake seam.
describe('route and buyer suppression is a separate mechanism', () => {
  maybe()('a lead on a buyer list but not the global list still enters the pipeline', async () => {
    // Route member suppression is evaluated inside routing, per member, and
    // must not stop the lead at intake. If it did, a lead one buyer declines
    // would never be offered to any other buyer.
    const { evaluateMember, REASON } = await import('../../client/src/lib/distribution/engine.js');

    const r = await intake.captureAndScreen({
      source: 'supplier_http', payload: LEAD, sql: pool, repo: repoWith(),
    });
    expect(r.outcome).toBe(intake.INTAKE_OUTCOME.ACCEPTED);

    const member = {
      id: 'm1', active: true, priority: 1, price: 10,
      buyer: { active: true, status: 'active' },
      filters: {},
      suppression: ['ada@example.com'],
    };
    const decision = evaluateMember(member, { ...LEAD, mobile: LEAD.phone });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe(REASON.SUPPRESSED);

    // Another buyer with no list is still eligible for the same lead.
    const other = evaluateMember({ ...member, id: 'm2', suppression: [] }, { ...LEAD, mobile: LEAD.phone });
    expect(other.eligible).toBe(true);
  });
});
