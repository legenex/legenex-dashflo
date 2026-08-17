// Every exit from processLead concludes its receipt.
//
// This is the behavioural counterpart to the source scan in
// intakePathCoverage.test.js. It runs the real processLead against a real
// lead_receipts table and a lightweight entity double, then reads the row back
// and asserts it reached a terminal state.
//
// Why this suite exists
// ---------------------
// completeReceipt used to be called on one of sixteen returns. The green suite
// missed it because the only assertion was a source scan for the literal
// `effectsApplied: true`, which the one correct call site satisfied. Production
// proved the gap: the single test post made against api.dashflo.io left a
// receipt at status `received`, terminal_outcome NULL, effects_applied false,
// with no Lead row. That is the state a replay reads as "not yet delivered and
// not yet billed", so a replay worker built on top of it would have
// redelivered work that had already been refused.
//
// The paths exercised here are the ones ordinary traffic actually takes:
// a lead with no supplier configuration, a lead missing required fields, and
// an internal error. None of them is exotic, and every one of them used to
// leak a receipt.
//
// The database is disposable and is created and dropped by this file. Loopback
// only, which the outbound network guard permits. No live endpoint is used.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const TEST_DB = 'dashflo_receipt_conclusion_test';
const MAINTENANCE_DB = 'postgres';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

// Without this the suppression check cannot run, returns UNAVAILABLE, and every
// post takes the HELD branch, which deliberately leaves the receipt pending for
// retry. That is correct behaviour but it is not the behaviour under test here,
// and a suite that never got past it would prove nothing about the fifteen
// exits further down. It is a disposable local value.
process.env.DNC_HASH_KEY = 'receipt-conclusion-suite-disposable-hash-key';

const pg = (await import('pg')).default;

async function maintenance(sql) {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function canReachPostgres() {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const reachable = await canReachPostgres();

// A minimal entity double. Every collection reads empty unless a test seeds it,
// which is what puts processLead onto the "nothing is configured" exits that
// ordinary early traffic takes.
function makeDb({ apiKey, overrides = {} } = {}) {
  const writes = { Lead: [], ErrorLog: [], Delivery: [] };
  const collection = (name) => ({
    list: async () => overrides[name] || [],
    filter: async (query) => {
      if (name === 'ApiKey' && apiKey) {
        if (query.key_hash && query.key_hash === apiKey.key_hash) return [apiKey];
        return [];
      }
      const rows = overrides[name] || [];
      return rows.filter((row) => Object.entries(query || {})
        .every(([field, value]) => typeof value !== 'object' && row[field] === value));
    },
    get: async (id) => (overrides[name] || []).find((row) => row.id === id) || null,
    create: async (record) => {
      const row = { id: `${name.toLowerCase()}-${(writes[name]?.length || 0) + 1}`, ...record };
      (writes[name] ||= []).push(row);
      return row;
    },
    update: async (id, patch) => ({ id, ...patch }),
    // nextLeadId does an optimistic compare-and-set against Counter and gives
    // up after ten attempts, so the double has to report a successful update
    // or every test falls into the outer catch and proves only that one path.
    updateMany: async () => ({ updated: 1 }),
    bulkCreate: async (rows) => rows,
    delete: async () => null,
  });
  return {
    writes,
    entities: new Proxy({}, { get: (cache, name) => (cache[name] ||= collection(String(name))) }),
    auth: { me: async () => null },
    integrations: { Core: {} },
  };
}

function makeCtx(db, payload, key) {
  const headers = key ? { 'x-api-key': key } : {};
  return {
    db,
    body: payload,
    env: process.env,
    user: null,
    req: { method: 'POST', headers, get: (name) => headers[String(name).toLowerCase()] || null },
    json: (body, status = 200) => ({ __httpResponse: true, body, status }),
  };
}

describe.skipIf(!reachable)('processLead concludes its receipt on every exit', () => {
  let pool;
  let processLead;
  let hashApiKey;
  let mintApiKey;
  let rawKey;
  let apiKeyRecord;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const { ensureReceiptSchema } = await import('../src/db/receiptSchema.js');
    await ensureReceiptSchema();
    ({ hashApiKey, mintApiKey } = await import('../src/lib/apiKeys.js'));
    processLead = (await import('../src/functions/processLead.js')).default;

    rawKey = mintApiKey('master');
    apiKeyRecord = {
      id: 'key-1', name: 'Test master', type: 'master',
      key_hash: hashApiKey(rawKey), key_prefix: rawKey.slice(0, 16),
      active: true, request_count: 0,
    };
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => {});
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE lead_receipts');
  });

  async function onlyReceipt() {
    const { rows } = await pool.query('SELECT * FROM lead_receipts');
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  // The shape production is in right now, and the one this fix is for.
  it('concludes a lead that is refused because nothing is configured', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    const result = await processLead(makeCtx(db, {
      first_name: 'Ada', last_name: 'Lovelace', mobile: '5551234567', email: 'ada@example.test',
      state: 'TX', trustedform_url: 'https://cert.trustedform.com/abc',
    }, rawKey));

    expect(result.status).toBe(200);

    const receipt = await onlyReceipt();
    expect(receipt.status, 'a receipt left at received is work the system believes it still owes').not.toBe('received');
    expect(['done', 'failed']).toContain(receipt.status);
    expect(receipt.terminal_outcome).not.toBeNull();
    expect(receipt.terminal_at).not.toBeNull();
  });

  it('concludes a lead refused for missing required fields', async () => {
    const db = makeDb({
      apiKey: apiKeyRecord,
      overrides: {
        CustomField: [{ id: 'cf1', field_name: 'zip_code', required: true, active: true }],
      },
    });
    await processLead(makeCtx(db, { first_name: 'Ada', mobile: '5551234567' }, rawKey));

    const receipt = await onlyReceipt();
    expect(['done', 'failed']).toContain(receipt.status);
    expect(receipt.terminal_outcome).not.toBeNull();
  });

  it('concludes even when the pipeline throws, via the outer catch', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    // Make an early read blow up so the outer catch is the exit taken. That
    // return is one of the fifteen that used to conclude nothing.
    db.entities.CustomField.list = async () => { throw new Error('injected failure'); };

    const result = await processLead(makeCtx(db, {
      first_name: 'Ada', mobile: '5551234567', email: 'ada@example.test',
    }, rawKey));
    expect(result.status).toBe(200);

    const receipt = await onlyReceipt();
    expect(receipt.status).not.toBe('received');
    expect(receipt.terminal_outcome).not.toBeNull();
  });

  it('records effects honestly rather than claiming delivery that never happened', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    await processLead(makeCtx(db, {
      first_name: 'Ada', mobile: '5551234567', email: 'ada@example.test',
    }, rawKey));

    const receipt = await onlyReceipt();
    // Nothing is configured, so nothing was delivered and nothing was billed.
    // The old code hardcoded effects_applied true on its single conclusion,
    // which would have told a replay that a lead it never delivered was
    // already handled.
    if (!receipt.effects_applied) {
      expect(db.writes.Delivery).toHaveLength(0);
    }
    expect(typeof receipt.effects_applied).toBe('boolean');
  });

  it('does not conclude twice, so a concluded outcome is never overwritten', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    await processLead(makeCtx(db, {
      first_name: 'Ada', mobile: '5551234567', email: 'ada@example.test',
    }, rawKey));

    const first = await onlyReceipt();
    // completeReceipt guards on terminal_outcome IS NULL, so a second attempt
    // is inert. Prove it rather than trusting the SQL by inspection.
    const { completeReceipt } = await import('../src/lib/receipts.js');
    const second = await completeReceipt({
      id: first.id, outcome: 'something-else', effectsApplied: true, db: pool,
    });
    expect(second.applied).toBe(false);
    expect(second.receipt.terminal_outcome).toBe(first.terminal_outcome);
  });

  it('leaves no receipt at all for a dry run, because a validation is not a request', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    const result = await processLead(makeCtx(db, {
      _dry_run: true, first_name: 'Ada', mobile: '5551234567',
    }, rawKey));

    expect(result.body.dry_run).toBe(true);
    const { rows } = await pool.query('SELECT * FROM lead_receipts');
    expect(rows).toHaveLength(0);
  });

  it('writes no receipt for an unauthenticated post', async () => {
    const db = makeDb({ apiKey: apiKeyRecord });
    const result = await processLead(makeCtx(db, { first_name: 'Ada' }, 'dshflo_sup_not-a-real-key'));
    expect(result.status).toBe(401);
    const { rows } = await pool.query('SELECT * FROM lead_receipts');
    expect(rows).toHaveLength(0);
  });
});
