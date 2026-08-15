// Durable lead receipts. Task I1.
//
// Why this is not a generic entity
// --------------------------------
// Every other record in this system lives in an `e_<name>` table as a JSONB
// blob with no constraints beyond the primary key. That is fine for
// configuration. It is not fine here.
//
// The invariants this table has to hold are:
//
//   - a transport that retries must not create a second receipt
//   - two workers must not process the same receipt at once
//   - a worker that dies mid-flight must not strand its receipt forever
//   - a receipt reaches exactly one terminal outcome, or stays visibly
//     retryable
//
// The first two are uniqueness and atomicity properties. Enforcing them in
// application code means enforcing them in a read-then-write, which is exactly
// the race they are supposed to prevent. They belong in the database:
// `transport_key` carries a UNIQUE constraint, and claiming is a single
// conditional UPDATE that returns the rows it won.
//
// Sanitization
// ------------
// `payload` is the sanitized inbound body. Invariant 4 forbids storing
// authorization headers, cookies, raw API keys or secrets in lead payloads, so
// the caller sanitizes before committing and `sanitizeReceiptPayload` in
// lib/receipts.js is the one place that does it.

import { pool } from './pool.js';

export const RECEIPT_STATUS = {
  RECEIVED: 'received',
  CLAIMED: 'claimed',
  DONE: 'done',
  FAILED: 'failed',
};

export async function ensureReceiptSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_receipts (
        id             TEXT PRIMARY KEY,

        -- Monotonic arrival order. created_date is not a total order: several
        -- receipts committed in the same instant tie, and ORDER BY on a tie is
        -- arbitrary, so claiming would hand out work in an unpredictable order
        -- under exactly the load where fairness matters. This is the tiebreak.
        seq            BIGSERIAL NOT NULL,

        -- Transport level idempotency key. Two posts carrying the same key are
        -- the same delivery attempt of the same lead, no matter what else
        -- differs. UNIQUE is the whole point of this column.
        transport_key  TEXT NOT NULL UNIQUE,

        source         TEXT NOT NULL,
        supplier_key_id TEXT,

        -- Sanitized inbound body. Never the raw request.
        payload        JSONB NOT NULL DEFAULT '{}'::jsonb,

        status         TEXT NOT NULL DEFAULT 'received',

        -- Worker lease. claim_owner is who holds it, claim_expires_at is when
        -- the lease lapses so a dead worker's receipt becomes claimable again.
        claim_owner    TEXT,
        claim_expires_at TIMESTAMPTZ,

        attempts       INTEGER NOT NULL DEFAULT 0,

        -- Set exactly once, when the receipt reaches a business conclusion.
        terminal_outcome TEXT,
        terminal_reason  TEXT,
        terminal_at      TIMESTAMPTZ,

        -- Set when the receipt has produced its delivery and billing effects,
        -- so a replay can tell "already done" from "not yet done".
        effects_applied  BOOLEAN NOT NULL DEFAULT false,

        created_date   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_date   TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT lead_receipts_status_check
          CHECK (status IN ('received', 'claimed', 'done', 'failed')),

        -- A terminal receipt must say what happened. A non-terminal one must
        -- not claim an outcome. This makes "silently dropped" unrepresentable.
        CONSTRAINT lead_receipts_terminal_coherent
          CHECK (
            (status IN ('done', 'failed') AND terminal_outcome IS NOT NULL)
            OR (status IN ('received', 'claimed') AND terminal_outcome IS NULL)
          )
      );
    `);

    // Additive upgrade for a table created before seq existed.
    await client.query('ALTER TABLE lead_receipts ADD COLUMN IF NOT EXISTS seq BIGSERIAL;');

    // Claim scans hit status plus lease expiry, so index the pair.
    await client.query(`
      CREATE INDEX IF NOT EXISTS lead_receipts_claimable_idx
        ON lead_receipts (status, claim_expires_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS lead_receipts_seq_idx
        ON lead_receipts (seq);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS lead_receipts_created_idx
        ON lead_receipts (created_date DESC);
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default ensureReceiptSchema;
