// Base44 to DashFlo migration sync.
//
// Direction is Base44 -> DashFlo, one way, always. There is deliberately no
// code path that writes to Base44, because a bidirectional sync between a
// system being retired and the system replacing it has no correct conflict
// answer, and the wrong answer loses paid leads.
//
// DashFlo is the source of truth. Base44 is a live source that has not been
// switched off yet. Everything below exists to encode that asymmetry:
//
//   - a record is never deleted because it vanished from Base44
//   - an older Base44 value never overwrites a newer DashFlo one
//   - a record an operator has edited in DashFlo is never silently overwritten
//   - credential fields are never rewritten by a sync, ever
//   - a failed pull leaves the previous DashFlo data exactly where it was
//
// The last one is the reason this module never truncates. The previous data
// refresh pipeline issued `DELETE FROM <table>` before reimporting, protected
// only by a total record count ratio. That turns any partial upstream failure
// into data loss. Here, a failing entity fails alone and changes nothing.

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { newId } from '../db/repo.js';
import { tableName, entityNames } from '../schemas/index.js';
import { ensureBase44SyncSchema, SYNC_ADVISORY_LOCK_ID, SYNC_STATUS } from '../db/base44SyncSchema.js';
import { Base44Source, base44ConfigFromEnv, isConfigured } from './base44Source.js';
import { hashApiKey } from './apiKeys.js';

// ---------------------------------------------------------------------------
// What is synced, and what is deliberately not
// ---------------------------------------------------------------------------

// Local authentication is not sourced from the old app. Importing Base44 users
// would import an authentication surface DashFlo does not control.
//
// The Meta sync run log is excluded because it is over 100,000 rows of
// operational telemetry that no cutover decision depends on, and pulling it
// every six hours would dominate the run for no benefit. It is a one time
// historical import, not a delta.
export const EXCLUDED_ENTITIES = new Set([
  'User',
  'MetaSyncRun',
]);

// User is never imported because DashFlo authentication is independent.
// MetaSyncRun is excluded only from the repeating default and may be named
// explicitly for a one-time historical import or final reconciliation.
export const NEVER_SYNCED_ENTITIES = new Set(['User']);

// Entities DashFlo owns at runtime. Base44 must never reset these, because the
// live values are produced by this system, not by the one being retired.
// Requirement: "never reset DashFlo runtime counters from stale Base44 data".
export const DASHFLO_OWNED_ENTITIES = new Set([
  'Counter',
  'CapCounter',
  'CapReservation',
  'BidAttempt',
  'RouteDecisionTrace',
  'DistributionAudit',
]);

// Fields that a sync may never write on a record that already exists locally.
//
// Supplier and buyer API keys authenticate live traffic. If a sync rewrote one,
// every supplier holding the old value would start failing authentication at a
// scheduled time with no human involved. These are import-once fields: they are
// set when a record is first created and never touched again.
export const IMMUTABLE_AFTER_IMPORT = {
  ApiKey: ['key', 'key_hash', 'key_prefix', 'request_count', 'last_used_at'],
  SystemKey: ['secret', 'client_id', 'request_count', 'last_used_at'],
  BuyerApiKey: ['key', 'key_prefix', 'request_count', 'last_used_at'],
  Buyer: ['buyer_api_key'],
  Supplier: [],
  InboundWebhookRoute: ['token_hash'],
};

// Meta columns handled outside the JSONB blob.
const META_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id']);

// Base44 bookkeeping that should not be copied into the DashFlo data blob.
const SOURCE_ONLY_FIELDS = new Set(['is_sample', 'created_by_id', 'sample_data']);

export function syncableEntities(names = entityNames) {
  return names.filter((n) => !EXCLUDED_ENTITIES.has(n) && !DASHFLO_OWNED_ENTITIES.has(n));
}

// ---------------------------------------------------------------------------
// Record shaping and fingerprinting
// ---------------------------------------------------------------------------

// Split a Base44 record into the meta columns and the JSONB data blob, dropping
// source-only bookkeeping.
export function shapeRecord(source) {
  const data = {};
  const meta = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (SOURCE_ONLY_FIELDS.has(k)) continue;
    if (META_FIELDS.has(k)) meta[k] = v;
    else data[k] = v;
  }
  return { meta, data };
}

// Stable hash of a data blob. Keys are sorted so property order never changes
// the fingerprint, which would otherwise make every record look edited.
export function fingerprint(data) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, k) => {
        acc[k] = stable(value[k]);
        return acc;
      }, {});
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(data ?? {}))).digest('hex');
}

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ApiKey is the one entity where the source carries a cleartext credential and
// DashFlo stores a hash. On first import we derive the hash so the record
// authenticates immediately, without changing the supplier's actual key.
function deriveApiKeyFields(data) {
  const out = { ...data };
  const raw = String(out.key || '').trim();
  if (raw && !out.key_hash) out.key_hash = hashApiKey(raw);
  if (raw && !out.key_prefix) out.key_prefix = raw.slice(0, 16);
  // Supplier authentication uses the hash. Keeping the imported cleartext in
  // JSONB would weaken the existing DashFlo hash-only storage model.
  delete out.key;
  return out;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class Base44Sync {
  constructor({ source = null, cfg = base44ConfigFromEnv(), logger = console } = {}) {
    this.cfg = cfg;
    this.source = source || new Base44Source(cfg);
    this.logger = logger;
  }

  // Take the cross process lock. Returns a release function, or null when
  // another run already holds it. A manual run that collides with the schedule
  // is reported as skipped, not queued, because the scheduled run is already
  // doing the same work.
  async #acquireLock() {
    const client = await pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [SYNC_ADVISORY_LOCK_ID]);
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [SYNC_ADVISORY_LOCK_ID]);
      } finally {
        client.release();
      }
    };
  }

  async run({ trigger = 'scheduled', entities = null, actor = null } = {}) {
    await ensureBase44SyncSchema();

    if (!isConfigured(this.cfg)) {
      return { status: SYNC_STATUS.SKIPPED, reason: 'not_configured', ...this.source.describe() };
    }
    if (trigger === 'scheduled' && !this.cfg.enabled) {
      return { status: SYNC_STATUS.SKIPPED, reason: 'disabled' };
    }

    const release = await this.#acquireLock();
    if (!release) {
      return { status: SYNC_STATUS.SKIPPED, reason: 'already_running' };
    }

    const runId = newId();
    const explicitlyRequested = Boolean(entities && entities.length);
    const targets = (explicitlyRequested ? entities : syncableEntities())
      .filter((n) => entityNames.includes(n) && !NEVER_SYNCED_ENTITIES.has(n) && !DASHFLO_OWNED_ENTITIES.has(n));

    const totals = {
      inspected: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0,
    };
    const perEntity = [];
    let entitiesFailed = 0;
    let entitiesHardFailed = 0;

    try {
      await pool.query(
        `INSERT INTO base44_sync_runs (id, trigger, status, entities_attempted)
         VALUES ($1, $2, 'running', $3)`,
        [runId, `${trigger}${actor ? `:${actor}` : ''}`, targets.length],
      );

      // Prove the source answers before touching anything. A dead source must
      // never be mistaken for an empty source.
      await this.source.ping();

      for (const entity of targets) {
        // Entity level isolation. One entity failing must not abort the rest
        // and must not roll back what already imported cleanly.
        const result = await this.#syncEntity(runId, entity).catch((err) => ({
          entity,
          status: 'failed',
          inspected: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0,
          error: err?.message || 'unknown error',
        }));

        perEntity.push(result);
        if (result.status === 'failed' || result.status === 'partial') entitiesFailed += 1;
        if (result.status === 'failed') entitiesHardFailed += 1;
        for (const k of Object.keys(totals)) totals[k] += result[k] || 0;
      }

      const status = entitiesFailed === 0
        ? SYNC_STATUS.SUCCESS
        : (entitiesHardFailed === targets.length ? SYNC_STATUS.FAILED : SYNC_STATUS.PARTIAL);

      const failedNames = perEntity
        .filter((e) => e.status === 'failed' || e.status === 'partial')
        .map((e) => e.entity);

      await pool.query(
        `UPDATE base44_sync_runs SET
           status = $2, finished_at = now(), entities_failed = $3,
           records_inspected = $4, records_created = $5, records_updated = $6,
           records_skipped = $7, records_conflicted = $8, records_failed = $9,
           error_summary = $10
         WHERE id = $1`,
        [runId, status, entitiesFailed, totals.inspected, totals.created, totals.updated,
          totals.skipped, totals.conflicted, totals.failed,
          failedNames.length ? `Failed entities: ${failedNames.join(', ')}` : null],
      );

      return { runId, status, trigger, totals, entities: perEntity };
    } catch (err) {
      await pool.query(
        `UPDATE base44_sync_runs SET status = 'failed', finished_at = now(), error_summary = $2 WHERE id = $1`,
        [runId, String(err?.message || 'unknown error').slice(0, 500)],
      ).catch(() => {});
      return { runId, status: SYNC_STATUS.FAILED, error: err?.message || 'unknown error', totals, entities: perEntity };
    } finally {
      await release();
    }
  }

  async #syncEntity(runId, entity) {
    const stats = {
      entity, status: 'success',
      inspected: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, failed: 0,
      sourceCount: null, watermark: null, error: null,
    };

    await pool.query(
      `INSERT INTO base44_sync_run_entities (run_id, entity, status) VALUES ($1, $2, 'running')
       ON CONFLICT (run_id, entity) DO NOTHING`,
      [runId, entity],
    );
    await pool.query(
      `INSERT INTO base44_sync_state (entity, last_attempt_at, last_status)
       VALUES ($1, now(), 'running')
       ON CONFLICT (entity) DO UPDATE SET last_attempt_at = now(), last_status = 'running'`,
      [entity],
    );

    const table = tableName(entity);
    let maxSourceUpdated = null;

    try {
      // The table has to exist locally. An entity present in Base44 but not in
      // the DashFlo schema is reported, not invented.
      const { rows: exists } = await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
      if (!exists[0]?.t) throw new Error(`No local table ${table} for entity ${entity}`);

      const { rows: cursorRows } = await pool.query(
        'SELECT watermark FROM base44_sync_state WHERE entity = $1',
        [entity],
      );
      const previousWatermark = cursorRows[0]?.watermark || null;
      const readPage = previousWatermark && typeof this.source.readAllSince === 'function'
        ? this.source.readAllSince.bind(this.source)
        : this.source.readAll.bind(this.source);
      const readArgs = previousWatermark ? [entity, previousWatermark] : [entity];

      await readPage(...readArgs, {
        onPage: async (rows) => {
          for (const source of rows) {
            stats.inspected += 1;
            try {
              const outcome = await this.#upsertRecord(entity, table, source);
              stats[outcome] += 1;
              const su = toDate(source.updated_date);
              if (su && (!maxSourceUpdated || su > maxSourceUpdated)) maxSourceUpdated = su;
            } catch (err) {
              stats.failed += 1;
              this.logger.warn?.(`[base44sync] ${entity} record failed: ${err?.message}`);
            }
          }
        },
      });

      stats.sourceCount = stats.inspected;
      stats.watermark = maxSourceUpdated ? maxSourceUpdated.toISOString() : null;
      if (stats.failed > 0) stats.status = 'partial';
    } catch (err) {
      // An entity DashFlo has and Base44 never had is not a failure. DncEntry
      // is the live example: global do-not-contact was built natively, so the
      // source app has no such schema. Reporting that as a failed entity would
      // make every run partial forever and train an operator to ignore the one
      // signal that is supposed to mean something.
      if (err?.notInSource) {
        stats.status = 'not_in_source';
        stats.error = null;
      } else {
        stats.status = 'failed';
        stats.error = String(err?.message || 'unknown error').slice(0, 500);
      }
    }

    await pool.query(
      `UPDATE base44_sync_run_entities SET
         status = $3, finished_at = now(), source_count = $4,
         records_inspected = $5, records_created = $6, records_updated = $7,
         records_skipped = $8, records_conflicted = $9, records_failed = $10,
         watermark = $11, error_summary = $12
       WHERE run_id = $1 AND entity = $2`,
      [runId, entity, stats.status, stats.sourceCount, stats.inspected, stats.created,
        stats.updated, stats.skipped, stats.conflicted, stats.failed, stats.watermark, stats.error],
    );

    // The cursor only advances on a clean pass. A partial pass keeps the old
    // watermark so the next run re-reads the window instead of stepping over
    // records it never imported.
    if (stats.status === 'success' || stats.status === 'not_in_source') {
      await pool.query(
        `UPDATE base44_sync_state SET
           watermark = COALESCE($2, watermark), last_success_at = now(),
           last_status = $4, last_source_count = $3, consecutive_failures = 0
         WHERE entity = $1`,
        [entity, stats.watermark, stats.inspected, stats.status],
      );
    } else {
      await pool.query(
        `UPDATE base44_sync_state SET
           last_status = $2, consecutive_failures = consecutive_failures + 1
         WHERE entity = $1`,
        [entity, stats.status],
      );
    }

    return stats;
  }

  // Returns one of: 'created' | 'updated' | 'skipped' | 'conflicted'
  async #upsertRecord(entity, table, source) {
    const base44Id = String(source?.id || '').trim();
    if (!base44Id) throw new Error('source record has no id');

    let { meta, data } = shapeRecord(source);
    if (entity === 'ApiKey') data = deriveApiKeyFields(data);

    const sourceUpdated = toDate(source.updated_date);
    const sourceFp = fingerprint(data);

    const { rows: provRows } = await pool.query(
      `SELECT dashflo_id, source_updated_date, dashflo_fingerprint, dashflo_modified
         FROM base44_record_provenance WHERE entity = $1 AND base44_id = $2`,
      [entity, base44Id],
    );
    const prov = provRows[0] || null;

    // ---- first time we have seen this Base44 record ------------------------
    if (!prov) {
      // Base44 ids are preserved as DashFlo ids. That is what keeps every
      // cross entity reference in the imported data valid without a rewrite.
      const { rows: existing } = await pool.query(`SELECT id, data FROM ${table} WHERE id = $1`, [base44Id]);

      if (existing.length === 0) {
        await pool.query(
          `INSERT INTO ${table} (id, data, created_by, created_date, updated_date)
           VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), now())
           ON CONFLICT (id) DO NOTHING`,
          [base44Id, JSON.stringify(data), meta.created_by ?? null, meta.created_date ?? null],
        );
        await this.#writeProvenance(entity, base44Id, base44Id, sourceUpdated, sourceFp, false);
        return 'created';
      }

      // The row already exists but we have no provenance for it, so this is an
      // adoption: DashFlo already had the record from an earlier import path.
      // Record provenance against what is actually stored and change nothing,
      // because we cannot prove the local copy is older.
      // Mark an adopted row as DashFlo-owned immediately. Recording it as an
      // untouched import would let the next scheduled run overwrite it even
      // though this sync never created or verified its contents.
      await this.#writeProvenance(
        entity, base44Id, base44Id, sourceUpdated, fingerprint(existing[0].data || {}), true,
      );
      return 'skipped';
    }

    // ---- we have imported this record before -------------------------------
    const { rows: localRows } = await pool.query(`SELECT id, data FROM ${table} WHERE id = $1`, [prov.dashflo_id]);

    // Gone locally. Requirement: never resurrect, never delete. An operator
    // removing a record in DashFlo is a DashFlo decision and Base44 does not
    // get to undo it.
    if (localRows.length === 0) return 'skipped';

    const localData = localRows[0].data || {};
    const localFp = fingerprint(localData);

    // DashFlo edited this record after import. Sticky from here on.
    const dashfloModified = prov.dashflo_modified || (prov.dashflo_fingerprint && localFp !== prov.dashflo_fingerprint);

    if (dashfloModified) {
      const sourceChanged = sourceFp !== prov.dashflo_fingerprint;
      await pool.query(
        `UPDATE base44_record_provenance SET
           dashflo_modified = true, last_synced_at = now(),
           source_updated_date = COALESCE($3::timestamptz, source_updated_date),
           conflict = $4,
           conflict_reason = CASE WHEN $4 THEN 'both_changed_since_import' ELSE conflict_reason END,
           conflict_at = CASE WHEN $4 THEN now() ELSE conflict_at END
         WHERE entity = $1 AND base44_id = $2`,
        [entity, base44Id, sourceUpdated, Boolean(sourceChanged)],
      );
      // Both sides changed is a conflict a human has to resolve. Only one side
      // changed and it was DashFlo, so there is nothing to do.
      return sourceChanged ? 'conflicted' : 'skipped';
    }

    // Untouched in DashFlo since import. Only write when the source actually
    // differs, so an unchanged record is not rewritten on every run.
    if (sourceFp === prov.dashflo_fingerprint) {
      await pool.query(
        `UPDATE base44_record_provenance SET last_synced_at = now() WHERE entity = $1 AND base44_id = $2`,
        [entity, base44Id],
      );
      return 'skipped';
    }

    // Refuse to move backwards in time. A source record older than what we
    // already imported is stale and never wins.
    const prevSourceUpdated = toDate(prov.source_updated_date);
    if (sourceUpdated && prevSourceUpdated && sourceUpdated < prevSourceUpdated) return 'skipped';

    // Credential and runtime counter fields are import-once. Keep whatever is
    // stored locally regardless of what the source now says.
    const preserve = IMMUTABLE_AFTER_IMPORT[entity] || [];
    const merged = { ...data };
    for (const field of preserve) {
      if (field in localData) merged[field] = localData[field];
      else delete merged[field];
    }

    await pool.query(
      `UPDATE ${table} SET data = $2::jsonb, updated_date = now() WHERE id = $1`,
      [prov.dashflo_id, JSON.stringify(merged)],
    );
    await this.#writeProvenance(entity, base44Id, prov.dashflo_id, sourceUpdated, fingerprint(merged), false);
    return 'updated';
  }

  async #writeProvenance(entity, base44Id, dashfloId, sourceUpdated, fp, modified) {
    await pool.query(
      `INSERT INTO base44_record_provenance
         (entity, base44_id, dashflo_id, source_updated_date, dashflo_fingerprint, dashflo_modified, last_synced_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, now())
       ON CONFLICT (entity, base44_id) DO UPDATE SET
         dashflo_id = EXCLUDED.dashflo_id,
         source_updated_date = EXCLUDED.source_updated_date,
         dashflo_fingerprint = EXCLUDED.dashflo_fingerprint,
         dashflo_modified = EXCLUDED.dashflo_modified,
         last_synced_at = now()`,
      [entity, base44Id, dashfloId, sourceUpdated, fp, modified],
    );
  }
}

// ---------------------------------------------------------------------------
// Status, for the owner facing surface
// ---------------------------------------------------------------------------

export async function syncStatus({ limit = 10 } = {}) {
  await ensureBase44SyncSchema();
  const cfg = base44ConfigFromEnv();

  const [{ rows: runs }, { rows: state }, { rows: conflicts }, { rows: successfulRuns }] = await Promise.all([
    pool.query(
      `SELECT id, trigger, status, started_at, finished_at, entities_attempted, entities_failed,
              records_inspected, records_created, records_updated, records_skipped,
              records_conflicted, records_failed, error_summary
         FROM base44_sync_runs ORDER BY started_at DESC LIMIT $1`, [limit],
    ),
    pool.query(
      `SELECT entity, watermark, last_attempt_at, last_success_at, last_status,
              last_source_count, consecutive_failures
         FROM base44_sync_state ORDER BY entity`,
    ),
    pool.query(
      `SELECT entity, count(*)::int AS conflicts
         FROM base44_record_provenance WHERE conflict = true GROUP BY entity ORDER BY entity`,
    ),
    pool.query(
      `SELECT id, trigger, status, started_at, finished_at, entities_attempted, entities_failed,
              records_inspected, records_created, records_updated, records_skipped,
              records_conflicted, records_failed, error_summary
         FROM base44_sync_runs WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`,
    ),
  ]);

  const lastSuccess = successfulRuns[0] || null;

  return {
    configured: isConfigured(cfg),
    enabled: Boolean(cfg.enabled),
    appId: cfg.appId || null,
    lastRun: runs[0] || null,
    lastSuccessfulRun: lastSuccess,
    runs,
    entities: state,
    conflicts,
  };
}

export default Base44Sync;
