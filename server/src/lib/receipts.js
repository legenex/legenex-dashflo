// Durable receipt capture, leasing and replay. Task I1.
//
// Contract, from the non-negotiable invariants:
//
//   2. authenticate, commit a sanitized durable receipt, then run business
//      validation
//   3. a committed receipt is replayable after a crash, and replay cannot
//      double-deliver or double-bill
//
// This module owns the receipt lifecycle and nothing else. It does not know
// what a lead is, does not validate one, and does not deliver or bill. Wiring
// it into the canonical pipeline is task I3, which is a serial integrator job.
//
// Lifecycle
// ---------
//   commitReceipt   received                (idempotent on transport_key)
//   claimReceipts   received -> claimed     (atomic, leased)
//   completeReceipt claimed  -> done|failed (terminal, set once)
//   releaseReceipt  claimed  -> received    (give the lease back, no outcome)
//
// The database enforces the parts that matter: transport_key is UNIQUE, and
// claiming is one conditional UPDATE rather than a read followed by a write.

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { RECEIPT_STATUS } from '../db/receiptSchema.js';

// Header and payload keys that must never be persisted on a receipt.
// Invariant 4: no authorization headers, cookies, raw API keys or secrets in
// lead payloads, logs, exports, fixtures, commits or prompts.
const FORBIDDEN_KEY_PATTERNS = [
  'authorization',
  'cookie',
  'x-api-key',
  'x_api_key',
  'apikey',
  'api_key',
  'secret',
  'password',
  'token',
  '_supplier_key',
];

function isForbiddenKey(key) {
  const k = String(key || '').toLowerCase().replace(/-/g, '_');
  return FORBIDDEN_KEY_PATTERNS.some((p) => k.includes(p.replace(/-/g, '_')));
}

// Strip credential-bearing keys at every depth. Returns a new object; the
// caller's payload is not modified.
//
// This is deliberately a denylist on key names rather than an allowlist on
// values, because the inbound field set is supplier-defined and an allowlist
// would silently drop real lead data. A key that looks like a credential is
// dropped and recorded in `redacted` so the loss is visible rather than silent.
export function sanitizeReceiptPayload(payload, redacted = []) {
  if (payload === null || payload === undefined) return { payload: {}, redacted };
  if (Array.isArray(payload)) {
    return {
      payload: payload.map((v) => sanitizeReceiptPayload(v, redacted).payload),
      redacted,
    };
  }
  if (typeof payload !== 'object') return { payload, redacted };

  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isForbiddenKey(key)) {
      redacted.push(key);
      continue;
    }
    if (value && typeof value === 'object') {
      out[key] = sanitizeReceiptPayload(value, redacted).payload;
    } else {
      out[key] = value;
    }
  }
  return { payload: out, redacted };
}

// Derive a transport key when the transport did not supply one.
//
// A supplier that sends its own idempotency header gets exact semantics. One
// that does not gets a content hash, which collapses a retry of a byte
// identical body into the same receipt. That is weaker (two genuinely distinct
// leads with identical content in the same window collapse too), so the source
// and a coarse time bucket are mixed in, and a supplier that needs exact
// behaviour should send a key.
export function deriveTransportKey({ source, suppliedKey, payload, bucketMs = 60_000, now = Date.now() }) {
  if (suppliedKey) return `k:${String(suppliedKey)}`;
  const bucket = Math.floor(now / bucketMs);
  const body = JSON.stringify(payload ?? {});
  const digest = crypto.createHash('sha256').update(`${source}|${bucket}|${body}`, 'utf8').digest('hex');
  return `h:${digest}`;
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function rowOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    transport_key: row.transport_key,
    source: row.source,
    supplier_key_id: row.supplier_key_id,
    payload: row.payload,
    status: row.status,
    claim_owner: row.claim_owner,
    claim_expires_at: row.claim_expires_at,
    attempts: row.attempts,
    terminal_outcome: row.terminal_outcome,
    terminal_reason: row.terminal_reason,
    terminal_at: row.terminal_at,
    effects_applied: row.effects_applied,
    created_date: row.created_date,
    updated_date: row.updated_date,
  };
}

// Commit a receipt. This is the durability point: after it returns, the lead
// exists and survives a crash.
//
// Idempotent on transport_key. A repeat returns the original receipt with
// duplicate: true and writes nothing, which is what makes a transport retry
// safe. The uniqueness is enforced by the database, not by a prior SELECT, so
// two concurrent posts of the same key cannot both insert.
export async function commitReceipt({ source, transportKey, suppliedKey, payload, supplierKeyId = null, db = pool }) {
  if (!source) throw new Error('commitReceipt requires a source');

  const { payload: clean, redacted } = sanitizeReceiptPayload(payload);
  const key = transportKey || deriveTransportKey({ source, suppliedKey, payload: clean });

  const insert = await db.query(
    `INSERT INTO lead_receipts (id, transport_key, source, supplier_key_id, payload, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (transport_key) DO NOTHING
     RETURNING *`,
    [newId(), key, source, supplierKeyId, JSON.stringify(clean), RECEIPT_STATUS.RECEIVED],
  );

  if (insert.rows.length > 0) {
    return { receipt: rowOut(insert.rows[0]), duplicate: false, redacted };
  }

  const existing = await db.query('SELECT * FROM lead_receipts WHERE transport_key = $1', [key]);
  return { receipt: rowOut(existing.rows[0]), duplicate: true, redacted };
}

// Claim work. One conditional UPDATE, so two workers running this at the same
// instant cannot both win the same row.
//
// A row is claimable when it is `received`, or when it is `claimed` but its
// lease has expired, which is how a worker that died mid-flight releases its
// work without any cleanup process.
export async function claimReceipts({ owner, limit = 1, leaseMs = 30_000, db = pool }) {
  if (!owner) throw new Error('claimReceipts requires an owner');

  const res = await db.query(
    `UPDATE lead_receipts
        SET status = $1,
            claim_owner = $2,
            claim_expires_at = now() + ($3 || ' milliseconds')::interval,
            attempts = attempts + 1,
            updated_date = now()
      WHERE id IN (
        SELECT id FROM lead_receipts
         WHERE status = $4
            OR (status = $1 AND claim_expires_at < now())
         ORDER BY seq ASC
         LIMIT $5
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [RECEIPT_STATUS.CLAIMED, owner, String(leaseMs), RECEIPT_STATUS.RECEIVED, limit],
  );

  // The ORDER BY in the subquery decides which rows are claimed, not the order
  // RETURNING emits them in, which is unspecified. Sort here so a batch is
  // handed to the caller oldest first, which is what FIFO processing needs.
  return res.rows.map(rowOut).sort((a, b) => Number(a.seq) - Number(b.seq));
}

// Record the terminal outcome. Set once.
//
// `expectOwner` makes a late worker harmless: a process that lost its lease,
// finished anyway, and tried to write its result is refused, because another
// worker may already have been given the same receipt. Without it, a stalled
// worker waking up could overwrite a completed outcome.
export async function completeReceipt({
  id, outcome, reason = null, effectsApplied = false, expectOwner = null, db = pool,
}) {
  if (!id) throw new Error('completeReceipt requires an id');
  if (!outcome) throw new Error('completeReceipt requires an outcome');

  const status = outcome === 'failed' ? RECEIPT_STATUS.FAILED : RECEIPT_STATUS.DONE;

  const res = await db.query(
    `UPDATE lead_receipts
        SET status = $1,
            terminal_outcome = $2,
            terminal_reason = $3,
            effects_applied = $4,
            claim_owner = NULL,
            claim_expires_at = NULL,
            terminal_at = now(),
            updated_date = now()
      WHERE id = $5
        AND terminal_outcome IS NULL
        AND ($6::text IS NULL OR claim_owner = $6)
      RETURNING *`,
    [status, outcome, reason, effectsApplied, id, expectOwner],
  );

  if (res.rows.length > 0) return { receipt: rowOut(res.rows[0]), applied: true };

  // Nothing updated. Either it was already terminal, which is the normal
  // replay case, or this caller no longer holds the lease.
  const current = await db.query('SELECT * FROM lead_receipts WHERE id = $1', [id]);
  return { receipt: rowOut(current.rows[0]), applied: false };
}

// Hand a lease back without concluding anything. Used when a worker decides it
// cannot finish now but the receipt is still perfectly valid work.
export async function releaseReceipt({ id, expectOwner = null, db = pool }) {
  const res = await db.query(
    `UPDATE lead_receipts
        SET status = $1, claim_owner = NULL, claim_expires_at = NULL, updated_date = now()
      WHERE id = $2
        AND terminal_outcome IS NULL
        AND ($3::text IS NULL OR claim_owner = $3)
      RETURNING *`,
    [RECEIPT_STATUS.RECEIVED, id, expectOwner],
  );
  return res.rows.length > 0 ? rowOut(res.rows[0]) : null;
}

export async function getReceipt(id, db = pool) {
  const res = await db.query('SELECT * FROM lead_receipts WHERE id = $1', [id]);
  return rowOut(res.rows[0]);
}

export async function getReceiptByTransportKey(key, db = pool) {
  const res = await db.query('SELECT * FROM lead_receipts WHERE transport_key = $1', [key]);
  return rowOut(res.rows[0]);
}

// Receipts that are committed but have not reached a terminal outcome. This is
// the backlog an operator and the readiness endpoint care about: a receipt in
// here is work that is owed, which is the observable form of "never silently
// dropped".
export async function pendingReceipts({ olderThanMs = 0, limit = 100, db = pool } = {}) {
  const res = await db.query(
    `SELECT * FROM lead_receipts
      WHERE terminal_outcome IS NULL
        AND created_date < now() - ($1 || ' milliseconds')::interval
      ORDER BY seq ASC
      LIMIT $2`,
    [String(olderThanMs), limit],
  );
  return res.rows.map(rowOut);
}

export default {
  RECEIPT_STATUS,
  sanitizeReceiptPayload,
  deriveTransportKey,
  commitReceipt,
  claimReceipts,
  completeReceipt,
  releaseReceipt,
  getReceipt,
  getReceiptByTransportKey,
  pendingReceipts,
};
