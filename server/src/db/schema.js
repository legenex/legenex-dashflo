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

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default ensureSchema;
