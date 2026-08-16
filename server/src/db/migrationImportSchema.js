import { pool } from './pool.js';

// Durable audit history for ordinary and owner migration imports. Bundle data,
// decrypted records, passphrases and credential values are deliberately absent.
export async function ensureMigrationImportSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_import_runs (
      id                    TEXT PRIMARY KEY,
      kind                  TEXT NOT NULL,
      mode                  TEXT NOT NULL,
      status                TEXT NOT NULL,
      source_application    TEXT,
      source_bundle_timestamp TIMESTAMPTZ,
      bundle_version        TEXT,
      importing_user_id     TEXT,
      importing_user_email  TEXT,
      started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at          TIMESTAMPTZ,
      entities_processed    INTEGER NOT NULL DEFAULT 0,
      records_present       INTEGER NOT NULL DEFAULT 0,
      records_created       INTEGER NOT NULL DEFAULT 0,
      records_updated       INTEGER NOT NULL DEFAULT 0,
      records_preserved     INTEGER NOT NULL DEFAULT 0,
      records_skipped       INTEGER NOT NULL DEFAULT 0,
      conflict_count        INTEGER NOT NULL DEFAULT 0,
      failed_count          INTEGER NOT NULL DEFAULT 0,
      credential_entities   JSONB NOT NULL DEFAULT '{}'::jsonb,
      entity_results        JSONB NOT NULL DEFAULT '{}'::jsonb,
      errors                JSONB NOT NULL DEFAULT '[]'::jsonb,
      CONSTRAINT migration_import_kind_check CHECK (kind IN ('ordinary', 'owner')),
      CONSTRAINT migration_import_mode_check CHECK (mode IN ('preview', 'apply')),
      CONSTRAINT migration_import_status_check CHECK (status IN ('running', 'validated', 'success', 'failed'))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS migration_import_runs_started_idx
      ON migration_import_runs (started_at DESC)
  `);
}

export default ensureMigrationImportSchema;
