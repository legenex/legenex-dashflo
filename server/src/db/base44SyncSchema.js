// Base44 to DashFlo migration sync: provenance, watermarks and run history.
//
// Why these are real tables and not entities
// ------------------------------------------
// Every business record in this system lives in an `e_<name>` table as a JSONB
// blob. That is right for configuration a human edits. It is wrong here for
// three reasons:
//
//   - Two sync runs must never overlap. That is an atomicity property, so it
//     belongs in the database as an advisory lock, not in application code that
//     reads then writes.
//   - Provenance is queried by (entity, base44_id) on every single upserted
//     record. That needs a real index, not a JSONB scan.
//   - Run history is an audit record. It must survive even when the entity
//     layer is what failed.
//
// Provenance lives in its own table rather than as extra fields on every
// business table. `docs/REQUIREMENTS.md` requires additive schema evolution,
// and adding six migration columns to forty entity tables is neither additive
// nor reversible. One side table keyed on (entity, base44_id) answers every
// question the migration needs and can be dropped whole after cutover.
//
// Source of truth
// ---------------
// DashFlo is authoritative. These tables exist to let the sync tell the
// difference between "Base44 changed this" and "DashFlo changed this since we
// imported it", so an older Base44 value can never overwrite a newer DashFlo
// one. `dashflo_fingerprint` is what makes that decision possible: it is the
// hash of the record as this sync last wrote it, so any later divergence is by
// definition a DashFlo-side edit.

import { pool } from './pool.js';

// One advisory lock id for the whole sync. Two runs, scheduled or manual, take
// the same lock, so overlap is prevented by the database rather than by hoping
// the schedule does not drift.
export const SYNC_ADVISORY_LOCK_ID = 4471001;

export const SYNC_STATUS = {
  RUNNING: 'running',
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export async function ensureBase44SyncSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- run history -------------------------------------------------------
    // One row per attempted run, written before any entity is touched so a
    // crashed run is still visible as `running` rather than disappearing.
    await client.query(`
      CREATE TABLE IF NOT EXISTS base44_sync_runs (
        id                TEXT PRIMARY KEY,
        trigger           TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'running',
        started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at       TIMESTAMPTZ,

        entities_attempted INTEGER NOT NULL DEFAULT 0,
        entities_failed    INTEGER NOT NULL DEFAULT 0,

        records_inspected INTEGER NOT NULL DEFAULT 0,
        records_created   INTEGER NOT NULL DEFAULT 0,
        records_updated   INTEGER NOT NULL DEFAULT 0,
        records_skipped   INTEGER NOT NULL DEFAULT 0,
        records_conflicted INTEGER NOT NULL DEFAULT 0,
        records_failed    INTEGER NOT NULL DEFAULT 0,

        -- Short human summary only. Never a payload, never a credential.
        error_summary     TEXT,

        CONSTRAINT base44_sync_runs_status_check
          CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped'))
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS base44_sync_runs_started_idx
        ON base44_sync_runs (started_at DESC);
    `);

    // ---- per entity result for a run --------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS base44_sync_run_entities (
        run_id            TEXT NOT NULL REFERENCES base44_sync_runs(id) ON DELETE CASCADE,
        entity            TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'running',
        started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at       TIMESTAMPTZ,

        source_count      INTEGER,
        records_inspected INTEGER NOT NULL DEFAULT 0,
        records_created   INTEGER NOT NULL DEFAULT 0,
        records_updated   INTEGER NOT NULL DEFAULT 0,
        records_skipped   INTEGER NOT NULL DEFAULT 0,
        records_conflicted INTEGER NOT NULL DEFAULT 0,
        records_failed    INTEGER NOT NULL DEFAULT 0,

        -- The cursor this entity advanced to, so a later run can resume.
        watermark         TEXT,
        error_summary     TEXT,

        PRIMARY KEY (run_id, entity)
      );
    `);

    // ---- per entity durable cursor ----------------------------------------
    // Only advanced on a clean entity pass. A partial pass leaves the previous
    // watermark in place so the next run re-reads the window rather than
    // stepping over records it never actually imported.
    await client.query(`
      CREATE TABLE IF NOT EXISTS base44_sync_state (
        entity             TEXT PRIMARY KEY,
        watermark          TEXT,
        last_attempt_at    TIMESTAMPTZ,
        last_success_at    TIMESTAMPTZ,
        last_status        TEXT,
        last_source_count  INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        enabled            BOOLEAN NOT NULL DEFAULT true
      );
    `);

    // ---- per record provenance --------------------------------------------
    // The whole point of this table is the last three columns. Without
    // dashflo_fingerprint there is no way to distinguish a record DashFlo has
    // edited since import from one that is still exactly as imported, and
    // without that distinction every sync is free to clobber operator work.
    await client.query(`
      CREATE TABLE IF NOT EXISTS base44_record_provenance (
        entity              TEXT NOT NULL,
        base44_id           TEXT NOT NULL,
        dashflo_id          TEXT NOT NULL,

        -- updated_date as reported by Base44 at the last successful import.
        source_updated_date TIMESTAMPTZ,

        first_imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Hash of the record exactly as this sync last wrote it. If the stored
        -- record no longer hashes to this, DashFlo changed it after import.
        dashflo_fingerprint TEXT,

        -- Sticky. Once an operator has edited an imported record, later Base44
        -- values never silently overwrite it again.
        dashflo_modified    BOOLEAN NOT NULL DEFAULT false,

        conflict            BOOLEAN NOT NULL DEFAULT false,
        conflict_reason     TEXT,
        conflict_at         TIMESTAMPTZ,

        PRIMARY KEY (entity, base44_id)
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS base44_record_provenance_dashflo_idx
        ON base44_record_provenance (entity, dashflo_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS base44_record_provenance_conflict_idx
        ON base44_record_provenance (entity, conflict) WHERE conflict = true;
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default ensureBase44SyncSchema;
