import { pool } from './pool.js';
import { entitySchemas, tableName } from '../schemas/index.js';

// Create one table per entity plus the users/auth support tables.
// Each entity table stores standard metadata columns + a JSONB `data` blob
// holding all schema-defined properties. This faithfully mirrors the
// document-style store the app was built against.
export async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const name of Object.keys(entitySchemas)) {
      const table = tableName(name);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id           TEXT PRIMARY KEY,
          data         JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by   TEXT,
          created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${table}_data_gin ON ${table} USING gin (data jsonb_path_ops);`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${table}_created_idx ON ${table} (created_date DESC);`);
    }

    // Auth credentials live outside the entity blob (never returned to clients).
    // The User *entity* row holds profile fields; this table holds the secret.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_credentials (
        user_id       TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        otp_code      TEXT,
        otp_expires   TIMESTAMPTZ,
        reset_token   TEXT,
        reset_expires TIMESTAMPTZ,
        created_date  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS auth_credentials_email_idx ON auth_credentials (lower(email));`);

    // Federated identity and account state. Added additively: an existing
    // deployment gets the columns with NULL/false and keeps working exactly as
    // before, which is invariant 7.
    //
    // google_sub is Google's stable subject identifier and is the provider
    // identity of record. It is UNIQUE so one Google account can never end up
    // linked to two DashFlo accounts, which is the failure the linking policy
    // refuses in code and the database refuses underneath it.
    //
    // google_email records the address Google asserted at link time. It is
    // evidence for the audit trail, not a login key: resolution is by
    // google_sub, never by this column.
    //
    // disabled is the account state Master Admin needs in order to suspend
    // somebody without deleting them. Every login path honours it.
    for (const column of [
      'google_sub TEXT',
      'google_email TEXT',
      'google_linked_at TIMESTAMPTZ',
      'disabled BOOLEAN NOT NULL DEFAULT false',
    ]) {
      await client.query(`ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS ${column};`);
    }
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS auth_credentials_google_sub_idx
         ON auth_credentials (google_sub) WHERE google_sub IS NOT NULL;`
    );

    // CapCounter.scope_key is the ONE canonical lookup key the cap/reservation/
    // wallet-claim CAS primitives (capStore.js) all key on - cap window
    // counters, per-lead winner claims, per-attempt reservation claims, and
    // wallet debit claims are all just differently-prefixed scope_key values
    // on this one entity. Without a real uniqueness guarantee, two concurrent
    // FIRST-TIME callers on the same brand-new key (e.g. two racing accepts
    // both creating `winner:{leadId}`) can each see an empty pre-check filter
    // and both successfully INSERT their own row, defeating every
    // exactly-once guarantee built on top (reserve(), the lead-level winner
    // claim, wallet claimTxn) - the atomic updateMany CAS this store already
    // uses is only atomic against a SINGLE existing row; it does nothing to
    // stop two rows from being independently created. Confirmed zero existing
    // rows in production before adding this, so no backfill/migration risk.
    // capStore.js's ensureCounter() catches the resulting unique-violation and
    // re-reads the row the other concurrent caller won.
    if (entitySchemas.CapCounter) {
      const capCounterTable = tableName('CapCounter');
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${capCounterTable}_scope_key_idx
           ON ${capCounterTable} ((data->>'scope_key'));`
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default ensureSchema;
