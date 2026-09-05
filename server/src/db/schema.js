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

    // W1-FLAGS (forge-pack/CONTRACT.md D2): is_sold, sold_at,
    // sale_price_effective, is_returned, returned_at, is_converted,
    // converted_at and conversion_type (server/src/schemas/entities/Lead.json,
    // computed by server/src/lib/leadFlags.js) are immutable, write-once
    // derived flags that money/GP/CPL/ROAS reporting reads instead of
    // final_status/lead_status. "Write-once" has to hold against every
    // caller, not just the ones that know about it: Repo.update() in
    // server/src/db/repo.js does a blind top-level JSONB merge for any
    // entity, so a status-sync webhook, a re-run of the backfill, or code
    // that does not exist yet could all overwrite these keys the same way
    // any other field is overwritten. A trigger is the one enforcement point
    // that covers all of them, including a raw SQL statement that never goes
    // through Repo at all.
    //
    // Semantics: once a protected key already holds a "set" value (true for
    // the three booleans, non-null for the rest), an UPDATE that tries to
    // change it has that one key silently pinned back to its original value;
    // every other column in the same UPDATE still applies normally. This is
    // a sticky latch, not a hard failure, so an ordinary Lead.update() call
    // that happens to also touch one of these keys (a stale mirrored patch,
    // for instance) does not lose its unrelated fields to a rolled back
    // transaction - only the protected key itself refuses to move. Additive:
    // CREATE OR REPLACE / DROP+CREATE TRIGGER, no data touched, safe to run
    // on every boot per invariant 7.
    if (entitySchemas.Lead) {
      const leadTable = tableName('Lead');
      await client.query(`
        CREATE OR REPLACE FUNCTION lead_flags_write_once() RETURNS trigger AS $BODY$
        DECLARE
          protected_key TEXT;
          old_val JSONB;
          new_val JSONB;
        BEGIN
          FOREACH protected_key IN ARRAY ARRAY[
            'is_sold', 'sold_at', 'sale_price_effective',
            'is_returned', 'returned_at',
            'is_converted', 'converted_at', 'conversion_type'
          ]
          LOOP
            old_val := OLD.data -> protected_key;
            new_val := NEW.data -> protected_key;

            IF old_val IS NULL OR old_val = 'null'::jsonb THEN
              CONTINUE; -- never set on the prior row: open for its first write
            END IF;

            IF jsonb_typeof(old_val) = 'boolean' AND old_val <> 'true'::jsonb THEN
              CONTINUE; -- boolean flag still false: open until it first flips true
            END IF;

            IF new_val IS DISTINCT FROM old_val THEN
              NEW.data := jsonb_set(NEW.data, ARRAY[protected_key], old_val, true);
            END IF;
          END LOOP;
          RETURN NEW;
        END;
        $BODY$ LANGUAGE plpgsql;
      `);
      await client.query(`DROP TRIGGER IF EXISTS lead_flags_write_once_trg ON ${leadTable};`);
      await client.query(`
        CREATE TRIGGER lead_flags_write_once_trg
          BEFORE UPDATE ON ${leadTable}
          FOR EACH ROW EXECUTE FUNCTION lead_flags_write_once();
      `);
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
