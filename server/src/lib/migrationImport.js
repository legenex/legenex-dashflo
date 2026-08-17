import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { tableName } from '../schemas/index.js';
import { entityExists, newId } from '../db/repo.js';
import { ensureMigrationImportSchema } from '../db/migrationImportSchema.js';
import { ensureBase44SyncSchema } from '../db/base44SyncSchema.js';
import { hashApiKey, keyPrefixOf, translateCredentialNamespace, isLegacyNamespace } from './apiKeys.js';
import { fingerprint } from './base44Sync.js';
import {
  ALL_ENTITIES,
  ENTITY_ORDER,
  IMPORT_FORCE,
  MIGRATION_CRYPTO,
  MIGRATION_DROP_FIELDS,
  MIGRATION_DROP_RECORD,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_SECRETS_EXPECTED,
  NATURAL_KEYS,
  REFS,
  REDACTED,
} from '../functions/systemTransfer.generated.js';

const MAX_RECORDS = 1_000_000;
const MAX_CHUNKS = 20_000;
const SAMPLE_LIMIT = 50;
const IMPORT_LOCK_ID = 4471002;
const META_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id']);
const SECRET_KEY_PATTERN = /(auth|key|secret|token|password|passwd|pwd|bearer|sig|signature|credential)/i;

export class MigrationValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MigrationValidationError';
    this.status = status;
  }
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function decodeBase64(value, label) {
  const input = String(value || '');
  if (!input || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new MigrationValidationError(`${label} is not valid base64`);
  }
  const out = Buffer.from(input, 'base64');
  if (!out.length) throw new MigrationValidationError(`${label} is empty`);
  return out;
}

function assertOwnerCrypto(bundle) {
  const spec = bundle?.crypto || {};
  const exact = [
    ['format', MIGRATION_CRYPTO.format],
    ['kdf', MIGRATION_CRYPTO.kdf],
    ['iterations', MIGRATION_CRYPTO.iterations],
    ['cipher', MIGRATION_CRYPTO.cipher],
    ['key_bits', MIGRATION_CRYPTO.key_bits],
    ['salt_bytes', MIGRATION_CRYPTO.salt_bytes],
    ['iv_bytes', MIGRATION_CRYPTO.iv_bytes],
  ];
  if (bundle?.format !== MIGRATION_CRYPTO.format) {
    throw new MigrationValidationError(`Unsupported migration package format: ${String(bundle?.format || 'missing')}`);
  }
  for (const [field, expected] of exact) {
    if (spec[field] !== expected) {
      throw new MigrationValidationError(`Unsupported migration crypto parameter: ${field}`);
    }
  }
  const salt = decodeBase64(spec.salt, 'Migration salt');
  if (salt.length !== MIGRATION_CRYPTO.salt_bytes) {
    throw new MigrationValidationError('Migration salt has the wrong length');
  }
  return salt;
}

function decryptChunk(chunk, key) {
  const iv = decodeBase64(chunk?.iv, 'Chunk IV');
  if (iv.length !== MIGRATION_CRYPTO.iv_bytes) throw new MigrationValidationError('Chunk IV has the wrong length');
  const sealed = decodeBase64(chunk?.ciphertext, 'Chunk ciphertext');
  if (sealed.length <= 16) throw new MigrationValidationError('Chunk ciphertext is truncated');

  try {
    const body = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    const digest = crypto.createHash('sha256').update(plaintext).digest('hex');
    if (digest !== String(chunk.plaintext_sha256 || '').toLowerCase()) {
      throw new MigrationValidationError('Chunk integrity digest does not match');
    }
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    if (error instanceof MigrationValidationError) throw error;
    throw new MigrationValidationError('Could not decrypt migration package. Check the passphrase and file integrity.');
  }
}

function normalizeOwner(bundle, passphrase) {
  if (String(passphrase || '').length < 16) {
    throw new MigrationValidationError('The migration passphrase must be at least 16 characters');
  }
  if (!Array.isArray(bundle?.chunks) || bundle.chunks.length > MAX_CHUNKS) {
    throw new MigrationValidationError('Migration package has an invalid chunk list');
  }
  if (bundle.source_app !== 'legenex-dashboard' || bundle.target !== 'dashflo') {
    throw new MigrationValidationError('Migration package source or target is not DashFlo-compatible');
  }
  if (!safeDate(bundle.exported_at)) throw new MigrationValidationError('Migration package export timestamp is invalid');
  const salt = assertOwnerCrypto(bundle);
  const key = crypto.pbkdf2Sync(
    Buffer.from(String(passphrase), 'utf8'),
    salt,
    MIGRATION_CRYPTO.iterations,
    MIGRATION_CRYPTO.key_bits / 8,
    'sha256',
  );

  const entities = {};
  for (const name of Object.keys(bundle.counts || {})) entities[name] = [];
  let total = 0;
  const positions = new Set();
  for (const chunk of bundle.chunks) {
    const envelopeEntity = String(chunk?.entity || '');
    if (!MIGRATION_ENTITY_ORDER.includes(envelopeEntity)) {
      throw new MigrationValidationError(`Migration chunk names unsupported entity ${envelopeEntity || '(missing)'}`);
    }
    const position = `${envelopeEntity}:${Number(chunk.offset) || 0}`;
    if (positions.has(position)) throw new MigrationValidationError(`Duplicate migration chunk position: ${position}`);
    positions.add(position);

    const payload = decryptChunk(chunk, key);
    if (payload?.entity !== envelopeEntity || Number(payload?.offset || 0) !== Number(chunk.offset || 0)) {
      throw new MigrationValidationError('Chunk envelope does not match its encrypted payload');
    }
    if (!Array.isArray(payload.records) || payload.records.length !== Number(chunk.records)) {
      throw new MigrationValidationError(`Chunk record count does not match for ${envelopeEntity}`);
    }
    entities[envelopeEntity] ||= [];
    entities[envelopeEntity].push(...payload.records);
    total += payload.records.length;
    if (total > MAX_RECORDS) throw new MigrationValidationError('Migration package record limit exceeded', 413);
  }

  const countDiscrepancies = [];
  for (const [name, expected] of Object.entries(bundle.counts || {})) {
    const actual = (entities[name] || []).length;
    if (Number(expected) >= 0 && actual !== Number(expected)) {
      // Counts are captured by the Base44 begin call before chunks are read.
      // IntegrationConfig can lose excluded OAuth state rows, and secret export
      // audit events can be added before KeyAuditEvent is paged. Report these
      // races; chunk authentication and record validation remain authoritative.
      countDiscrepancies.push({ entity: name, declared: Number(expected), decrypted: actual });
    }
  }

  return {
    kind: 'owner',
    packageVersion: bundle.format,
    sourceApplication: String(bundle.source_app || ''),
    exportedAt: String(bundle.exported_at || ''),
    entities,
    declaredCounts: bundle.counts || {},
    countDiscrepancies,
  };
}

function normalizeOrdinary(bundle) {
  if (!bundle?.manifest || !bundle?.entities || Array.isArray(bundle.entities)) {
    throw new MigrationValidationError('Not an ordinary Base44 system export bundle');
  }
  const version = Number(bundle.manifest.bundle_version);
  if (version !== 1) throw new MigrationValidationError(`Unsupported ordinary export version: ${String(bundle.manifest.bundle_version)}`);
  if (bundle.manifest.source_app !== 'legenex-dashboard') {
    throw new MigrationValidationError('Ordinary export source application is not supported');
  }
  if (!safeDate(bundle.manifest.exported_at)) throw new MigrationValidationError('Ordinary export timestamp is invalid');
  let total = 0;
  const entities = {};
  for (const [name, records] of Object.entries(bundle.entities)) {
    if (!Array.isArray(records)) throw new MigrationValidationError(`${name} records are not an array`);
    entities[name] = records;
    total += records.length;
    if (total > MAX_RECORDS) throw new MigrationValidationError('Import bundle record limit exceeded', 413);
  }
  return {
    kind: 'ordinary',
    packageVersion: String(version),
    sourceApplication: String(bundle.manifest.source_app || ''),
    exportedAt: String(bundle.manifest.exported_at || ''),
    entities,
    declaredCounts: bundle.manifest.counts || {},
    countDiscrepancies: [],
  };
}

export function normalizeMigrationBundle({ kind, bundle, passphrase = '' }) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new MigrationValidationError('Migration file is not a JSON object');
  }
  if (kind === 'owner') return normalizeOwner(bundle, passphrase);
  if (kind === 'ordinary') return normalizeOrdinary(bundle);
  throw new MigrationValidationError('Unknown migration package type');
}

export function isProtectedPlaceholder(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return true;
  if (s === REDACTED) return true;
  if (/^(null|undefined|redacted|masked|placeholder|change[_ -]?me|not[_ -]?set|n\/a)$/i.test(s)) return true;
  if (/^[*•xX_-]{4,}$/.test(s)) return true;
  if (/^<[^>]*(secret|token|key|credential)[^>]*>$/i.test(s)) return true;
  return false;
}

function parseJsonString(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function restoreProtectedValue(incoming, existing) {
  if (isProtectedPlaceholder(incoming)) return existing;
  if (Array.isArray(incoming)) {
    if (!Array.isArray(existing)) return incoming;
    return incoming.map((value, index) => restoreProtectedValue(value, existing[index]));
  }
  if (incoming && typeof incoming === 'object') {
    const prior = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const out = { ...incoming };
    for (const [key, oldValue] of Object.entries(prior)) {
      if (!(key in incoming)) {
        if (SECRET_KEY_PATTERN.test(key)) out[key] = oldValue;
      } else {
        out[key] = restoreProtectedValue(incoming[key], oldValue);
      }
    }
    return out;
  }
  const incomingJson = parseJsonString(incoming);
  const existingJson = parseJsonString(existing);
  if (incomingJson && existingJson) {
    return JSON.stringify(restoreProtectedValue(incomingJson, existingJson));
  }
  if (typeof incoming === 'string' && typeof existing === 'string' && incoming.includes(REDACTED)) {
    return existing;
  }
  return incoming;
}

export function mergeOrdinarySecrets(entity, incoming, existing = {}) {
  const out = { ...incoming };
  let preserved = false;
  for (const field of MIGRATION_SECRETS_EXPECTED[entity] || []) {
    if (!(field in incoming)) {
      if (field in existing) { out[field] = existing[field]; preserved = true; }
      continue;
    }
    const restored = restoreProtectedValue(incoming[field], existing[field]);
    if (restored !== incoming[field]) preserved = true;
    if (restored === undefined) delete out[field]; else out[field] = restored;
  }
  return { record: out, preserved };
}

function stripTransient(entity, record) {
  if (typeof MIGRATION_DROP_RECORD[entity] === 'function' && MIGRATION_DROP_RECORD[entity](record)) return null;
  const out = { ...record };
  for (const field of MIGRATION_DROP_FIELDS[entity] || []) delete out[field];
  return out;
}

function splitRecord(record) {
  const meta = {};
  const data = {};
  for (const [field, value] of Object.entries(record || {})) {
    if (field === 'is_sample' || field === 'sample_data') continue;
    if (META_FIELDS.has(field)) meta[field] = value;
    else data[field] = value;
  }
  meta.created_by = meta.created_by_id || meta.created_by || null;
  return { meta, data };
}

function ownerSecretPatch(entity, incoming) {
  const patch = {};
  if (entity === 'ApiKey' && incoming.key_hash) {
    patch.key_hash = incoming.key_hash;
    if (incoming.key_prefix) patch.key_prefix = incoming.key_prefix;
    return patch;
  }
  for (const field of MIGRATION_SECRETS_EXPECTED[entity] || []) {
    if (field in incoming && !isProtectedPlaceholder(incoming[field])) patch[field] = incoming[field];
  }
  return patch;
}

// ── Credential namespace translation on import ──────────────────────────────
//
// Base44 is the migration source; DashFlo is the canonical system, so the
// DashFlo namespace wins. A credential arriving as `lgnx_mst_<material>` is
// stored as `dshflo_mst_<material>`: the record relationship, its id, its
// active or revoked state and its usage metadata are all preserved, and only
// the namespace changes.
//
// Why a prefix swap is the correct canonical conversion here, rather than
// minting a fresh secret:
//
//   - The stored credential of record is the SHA-256 of the whole string. The
//     hash is recomputed from the translated value, so it stays valid.
//   - key_prefix is a display slice of that same string and is recomputed too.
//   - There is no checksum, length rule or HMAC in which the prefix
//     participates, so swapping it cannot invalidate anything downstream.
//   - The secret material after the tag is unchanged, so the credential keeps
//     the entropy it was issued with.
//
// The important property is determinism. translateCredentialNamespace maps a
// value to exactly one output and is a no-op on an already-translated value,
// so the second run of the same bundle produces the same key, the same hash
// and the same prefix. The record therefore compares equal and is preserved
// rather than rewritten. This is what stops a rerun rotating a credential.
//
// The raw value never survives the call: `key` is deleted from the record
// before it is written, so the old Legenex value is not readable afterwards
// and the new one is only ever held as a hash.

const CREDENTIAL_ENTITIES = new Set(['ApiKey', 'BuyerApiKey']);

// Which field carries the cleartext, and where the derived values go.
const CREDENTIAL_SHAPE = {
  ApiKey: { raw: 'key', hash: 'key_hash', prefix: 'key_prefix', dropRaw: true },
  // BuyerApiKey is read back through its own service function, which masks it,
  // and callers still compare the stored value directly. It keeps cleartext
  // for now, so the translated value is written back rather than dropped.
  BuyerApiKey: { raw: 'key', hash: null, prefix: 'key_prefix', dropRaw: false },
};

// Set on a record whose credential was moved into the DashFlo namespace, so
// the run can report it and an operator can see it happened. It is a flag, not
// a value: no credential material is recorded anywhere.
export const NAMESPACE_MIGRATED_FIELD = 'credential_namespace_migrated_at';

function applyCredentialNamespace(kind, entity, data, existingData = {}, meta = {}) {
  const shape = CREDENTIAL_SHAPE[entity];
  if (!shape) return false;

  const incoming = String(data[shape.raw] ?? '').trim();
  const usable = incoming && !isProtectedPlaceholder(incoming);

  // An ordinary (redacted) export carries no usable credential. Keep whatever
  // DashFlo already holds rather than overwriting a live secret with a mask.
  if (kind !== 'owner' || !usable) {
    if (shape.dropRaw) delete data[shape.raw];
    else if (!usable && existingData[shape.raw] !== undefined) data[shape.raw] = existingData[shape.raw];
    if (shape.hash && existingData[shape.hash]) data[shape.hash] = existingData[shape.hash];
    if (existingData[shape.prefix] && isProtectedPlaceholder(data[shape.prefix])) {
      data[shape.prefix] = existingData[shape.prefix];
    }
    return false;
  }

  const wasLegacy = isLegacyNamespace(incoming);
  const translated = translateCredentialNamespace(incoming);

  if (shape.hash) data[shape.hash] = hashApiKey(translated);
  data[shape.prefix] = keyPrefixOf(translated);
  if (shape.dropRaw) delete data[shape.raw];
  else data[shape.raw] = translated;

  if (wasLegacy) {
    // Stamped from the source record's own timestamp, not from the clock, so
    // rerunning the same bundle writes the same value and the record still
    // compares equal. A wall-clock stamp here would make every rerun look like
    // an update and defeat the idempotency this whole path exists for.
    data[NAMESPACE_MIGRATED_FIELD] = existingData[NAMESPACE_MIGRATED_FIELD]
      || String(meta.updated_date || meta.created_date || 'migrated');
  }
  return wasLegacy;
}

export function prepareMigrationRecord(kind, entity, source, existingData = {}) {
  const stripped = stripTransient(entity, source);
  if (!stripped) return null;
  let { meta, data } = splitRecord(stripped);
  let preserved = false;

  if (kind === 'ordinary') {
    ({ record: data, preserved } = mergeOrdinarySecrets(entity, data, existingData));
    data = { ...data, ...(IMPORT_FORCE[entity] || {}) };
  }

  let namespaceMigrated = false;
  if (CREDENTIAL_ENTITIES.has(entity)) {
    namespaceMigrated = applyCredentialNamespace(kind, entity, data, existingData, meta);
  }

  return { meta, data, preserved, namespaceMigrated };
}

function recordIds(value, kind) {
  if (value == null || value === '') return [];
  if (kind === 'id') return [String(value)];
  if (kind !== 'idsJson') return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function publicCredentialCounts(normalized) {
  const counts = {};
  for (const [entity, records] of Object.entries(normalized.entities)) {
    const fields = MIGRATION_SECRETS_EXPECTED[entity] || [];
    if (!fields.length) continue;
    let recordsWithCredentials = 0;
    const fieldCounts = {};
    for (const record of records) {
      let found = false;
      for (const field of fields) {
        if (field in record && !isProtectedPlaceholder(record[field])) {
          fieldCounts[field] = (fieldCounts[field] || 0) + 1;
          found = true;
        }
      }
      if (found) recordsWithCredentials += 1;
    }
    if (recordsWithCredentials) counts[entity] = { records: recordsWithCredentials, fields: fieldCounts };
  }
  return counts;
}

function rowToExisting(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_by: row.created_by,
    created_date: row.created_date,
    updated_date: row.updated_date,
    data: row.data || {},
  };
}

async function loadExisting(queryable, entity, ids) {
  if (!ids.length) return new Map();
  const { rows } = await queryable.query(
    `SELECT id, data, created_by, created_date, updated_date FROM ${tableName(entity)} WHERE id = ANY($1::text[])`,
    [ids],
  );
  return new Map(rows.map((row) => [String(row.id), rowToExisting(row)]));
}

function valuesDiffer(a, b) {
  return fingerprint(a || {}) !== fingerprint(b || {});
}

export async function analyzeMigration(normalized, queryable = pool) {
  const expected = normalized.kind === 'owner' ? MIGRATION_ENTITY_ORDER : ALL_ENTITIES;
  const presentNames = Object.keys(normalized.entities);
  const schemaIncompatibilities = [];
  const duplicateIds = [];
  const idCollisions = [];
  const newerConflicts = [];
  const relationshipProblems = [];
  const entityResults = {};
  const bundleIds = new Map();
  let recordsPresent = 0;
  let recordsToCreate = 0;
  let recordsToUpdate = 0;
  let recordsToPreserve = 0;
  let skipped = 0;

  for (const entity of presentNames) {
    const records = normalized.entities[entity] || [];
    recordsPresent += records.length;
    if (!expected.includes(entity) || !entityExists(entity)) {
      schemaIncompatibilities.push({ entity, reason: 'entity is not supported by this DashFlo schema' });
      continue;
    }
    const ids = new Set();
    for (const record of records) {
      const id = String(record?.id || '').trim();
      if (!id) schemaIncompatibilities.push({ entity, reason: 'record is missing its source id' });
      else if (ids.has(id)) duplicateIds.push({ entity, id });
      else ids.add(id);
    }
    bundleIds.set(entity, ids);
  }

  for (const entity of presentNames.filter((name) => expected.includes(name) && entityExists(name))) {
    const records = normalized.entities[entity] || [];
    const ids = records.map((record) => String(record?.id || '')).filter(Boolean);
    const existing = await loadExisting(queryable, entity, ids);
    const stats = { present: records.length, create: 0, update: 0, preserve: 0, skip: 0, conflict: 0 };

    const naturalKey = NATURAL_KEYS[entity];
    if (naturalKey) {
      const values = [...new Set(records.map((r) => r?.[naturalKey]).filter((v) => v != null && String(v) !== '').map(String))];
      if (values.length) {
        const { rows } = await queryable.query(
          `SELECT id, data->>$1 AS natural_value FROM ${tableName(entity)} WHERE data->>$1 = ANY($2::text[])`,
          [naturalKey, values],
        );
        const sourceByValue = new Map(records.map((r) => [String(r[naturalKey] || ''), String(r.id || '')]));
        for (const row of rows) {
          const sourceId = sourceByValue.get(String(row.natural_value));
          if (sourceId && sourceId !== String(row.id)) {
            idCollisions.push({ entity, field: naturalKey, source_id: sourceId, existing_id: String(row.id) });
          }
        }
      }
    }

    for (const source of records) {
      const id = String(source?.id || '').trim();
      if (!id) { stats.skip += 1; skipped += 1; continue; }
      const current = existing.get(id);
      const shaped = prepareMigrationRecord(normalized.kind, entity, source, current?.data || {});
      if (!shaped) { stats.skip += 1; skipped += 1; continue; }
      if (!current) {
        stats.create += 1;
        recordsToCreate += 1;
        continue;
      }
      if (shaped.preserved) { stats.preserve += 1; recordsToPreserve += 1; }
      const sourceDate = safeDate(source.updated_date);
      const currentDate = safeDate(current.updated_date);
      const newer = !sourceDate || (currentDate && currentDate > sourceDate);
      if (newer && valuesDiffer(shaped.data, current.data)) {
        stats.conflict += 1;
        newerConflicts.push({ entity, id, reason: 'DashFlo record is newer than the source record' });
        if (normalized.kind === 'owner' && Object.keys(ownerSecretPatch(entity, shaped.data)).length) {
          stats.update += 1;
          recordsToUpdate += 1;
        } else {
          stats.skip += 1;
          skipped += 1;
        }
      } else if (valuesDiffer(shaped.data, current.data)) {
        stats.update += 1;
        recordsToUpdate += 1;
      } else {
        stats.preserve += 1;
        recordsToPreserve += 1;
      }
    }
    entityResults[entity] = stats;
  }

  const unresolvedByTarget = new Map();
  for (const [entity, records] of Object.entries(normalized.entities)) {
    if (!entityExists(entity)) continue;
    for (const record of records) {
      for (const [field, ref] of Object.entries(REFS[entity] || {})) {
        if (ref.kind !== 'id' && ref.kind !== 'idsJson') continue;
        for (const id of recordIds(record[field], ref.kind)) {
          if (bundleIds.get(ref.target)?.has(id)) continue;
          const set = unresolvedByTarget.get(ref.target) || new Set();
          set.add(id);
          unresolvedByTarget.set(ref.target, set);
        }
      }
    }
  }
  for (const [target, ids] of unresolvedByTarget) {
    if (!entityExists(target)) continue;
    const existing = await loadExisting(queryable, target, [...ids]);
    for (const id of ids) {
      if (!existing.has(id)) relationshipProblems.push({ target, id, reason: 'referenced record is absent from both bundle and DashFlo' });
    }
  }

  const hardErrors = schemaIncompatibilities.length + duplicateIds.length + idCollisions.length + relationshipProblems.length;
  const credentialEntities = publicCredentialCounts(normalized);
  return {
    package_version: normalized.packageVersion,
    source_application: normalized.sourceApplication,
    export_timestamp: normalized.exportedAt,
    entities_present: presentNames,
    entities_missing: expected.filter((name) => !presentNames.includes(name)),
    records_present: recordsPresent,
    records_to_create: recordsToCreate,
    records_to_update: recordsToUpdate,
    records_to_preserve: recordsToPreserve,
    records_to_skip: skipped,
    credential_bearing_entities: credentialEntities,
    relationship_problems: relationshipProblems.slice(0, SAMPLE_LIMIT),
    schema_incompatibilities: schemaIncompatibilities.slice(0, SAMPLE_LIMIT),
    duplicate_ids: duplicateIds.slice(0, SAMPLE_LIMIT),
    id_collisions: idCollisions.slice(0, SAMPLE_LIMIT),
    conflicts_with_newer_dashflo_data: newerConflicts.slice(0, SAMPLE_LIMIT),
    conflict_count: newerConflicts.length,
    entity_results: entityResults,
    declared_count_discrepancies: normalized.countDiscrepancies || [],
    can_apply: hardErrors === 0,
  };
}

async function writeProvenance(client, entity, id, updatedDate, data, modified = false) {
  await client.query(
    `INSERT INTO base44_record_provenance
       (entity, base44_id, dashflo_id, source_updated_date, dashflo_fingerprint, dashflo_modified, last_synced_at)
     VALUES ($1, $2, $2, $3::timestamptz, $4, $5, now())
     ON CONFLICT (entity, base44_id) DO UPDATE SET
       dashflo_id = EXCLUDED.dashflo_id,
       source_updated_date = EXCLUDED.source_updated_date,
       dashflo_fingerprint = EXCLUDED.dashflo_fingerprint,
       dashflo_modified = EXCLUDED.dashflo_modified,
       conflict = false,
       conflict_reason = null,
       conflict_at = null,
       last_synced_at = now()`,
    [entity, id, safeDate(updatedDate)?.toISOString() || null, fingerprint(data), modified],
  );
}

async function applyNormalized(normalized, report) {
  if (!report.can_apply) throw new MigrationValidationError('Migration cannot be applied until validation errors are resolved', 409);
  const result = {
    created: 0, updated: 0, preserved: 0, skipped: 0, conflicts: 0, failed: 0,
    // How many credentials were moved out of the legacy Legenex namespace on
    // this run. On a rerun of the same bundle this stays above zero (the
    // translation still applies) while created and updated fall to zero, which
    // is what "converted once, not rotated again" looks like in the numbers.
    credentials_namespaced: 0,
    entities: {},
  };

  await ensureBase44SyncSchema();
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_ID]);
    const ordered = [...Object.keys(normalized.entities)].sort((a, b) => {
      const order = normalized.kind === 'owner' ? MIGRATION_ENTITY_ORDER : ENTITY_ORDER;
      return order.indexOf(a) - order.indexOf(b);
    });

    for (const entity of ordered) {
      if (!entityExists(entity)) continue;
      const table = tableName(entity);
      const stats = { created: 0, updated: 0, preserved: 0, skipped: 0, conflicts: 0, failed: 0, credentials_namespaced: 0 };
      for (const source of normalized.entities[entity] || []) {
        const id = String(source?.id || '').trim();
        if (!id) { stats.skipped += 1; result.skipped += 1; continue; }
        const { rows } = await client.query(
          `SELECT id, data, created_by, created_date, updated_date FROM ${table} WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = rowToExisting(rows[0]);
        const shaped = prepareMigrationRecord(normalized.kind, entity, source, current?.data || {});
        if (!shaped) { stats.skipped += 1; result.skipped += 1; continue; }
        if (shaped.namespaceMigrated) { stats.credentials_namespaced += 1; result.credentials_namespaced += 1; }

        let data = shaped.data;
        let action = current ? 'updated' : 'created';
        let localNewerConflict = false;
        if (current) {
          const sourceDate = safeDate(source.updated_date);
          const currentDate = safeDate(current.updated_date);
          const newer = !sourceDate || (currentDate && currentDate > sourceDate);
          if (newer && valuesDiffer(data, current.data)) {
            localNewerConflict = true;
            stats.conflicts += 1;
            result.conflicts += 1;
            if (normalized.kind === 'owner') {
              const secrets = ownerSecretPatch(entity, data);
              if (!Object.keys(secrets).length) {
                stats.skipped += 1; result.skipped += 1; continue;
              }
              data = { ...current.data, ...secrets };
              // Belt and braces. prepareMigrationRecord already translated and
              // dropped the cleartext, so this branch should never see a raw
              // key. If a future change reintroduces one, it is translated
              // here too rather than being hashed in the old namespace.
              if (CREDENTIAL_ENTITIES.has(entity) && data.key) {
                const translated = translateCredentialNamespace(String(data.key));
                data.key_hash = hashApiKey(translated);
                data.key_prefix = keyPrefixOf(translated);
                delete data.key;
              }
            } else {
              stats.skipped += 1; result.skipped += 1; continue;
            }
          } else {
            data = { ...current.data, ...data };
          }
          if (!valuesDiffer(data, current.data)) action = 'preserved';
        }

        if (action === 'created') {
          await client.query(
            `INSERT INTO ${table} (id, data, created_by, created_date, updated_date)
             VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))`,
            [id, JSON.stringify(data), shaped.meta.created_by, safeDate(source.created_date)?.toISOString() || null,
              safeDate(source.updated_date)?.toISOString() || null],
          );
          stats.created += 1; result.created += 1;
        } else if (action === 'updated') {
          await client.query(
            `UPDATE ${table} SET data = $2::jsonb,
               created_by = COALESCE($3, created_by),
               created_date = COALESCE($4::timestamptz, created_date),
               updated_date = COALESCE($5::timestamptz, updated_date)
             WHERE id = $1`,
            [id, JSON.stringify(data), shaped.meta.created_by, safeDate(source.created_date)?.toISOString() || null,
              localNewerConflict
                ? safeDate(current.updated_date)?.toISOString() || null
                : safeDate(source.updated_date)?.toISOString() || null],
          );
          stats.updated += 1; result.updated += 1;
        } else {
          stats.preserved += 1; result.preserved += 1;
        }
        if (shaped.preserved && action !== 'preserved') { stats.preserved += 1; result.preserved += 1; }
        await writeProvenance(client, entity, id, source.updated_date, data, localNewerConflict);
      }
      result.entities[entity] = stats;
    }
  });
  return result;
}

function auditError(error) {
  if (error instanceof MigrationValidationError) return error.message.slice(0, 500);
  return 'Migration failed; inspect server diagnostics without credential payloads';
}

async function insertRun({ id, kind, mode, user, bundle }) {
  const source = kind === 'owner' ? bundle?.source_app : bundle?.manifest?.source_app;
  const exportedAt = kind === 'owner' ? bundle?.exported_at : bundle?.manifest?.exported_at;
  const version = kind === 'owner' ? bundle?.format : bundle?.manifest?.bundle_version;
  await pool.query(
    `INSERT INTO migration_import_runs
       (id, kind, mode, status, source_application, source_bundle_timestamp, bundle_version,
        importing_user_id, importing_user_email)
     VALUES ($1, $2, $3, 'running', $4, $5::timestamptz, $6, $7, $8)`,
    [id, kind, mode, String(source || ''), safeDate(exportedAt)?.toISOString() || null, String(version || ''),
      String(user?.id || ''), String(user?.email || '')],
  );
}

async function finishRun(id, status, report, result = null, errors = []) {
  await pool.query(
    `UPDATE migration_import_runs SET status = $2, completed_at = now(),
       entities_processed = $3, records_present = $4, records_created = $5,
       records_updated = $6, records_preserved = $7, records_skipped = $8,
       conflict_count = $9, failed_count = $10, credential_entities = $11::jsonb,
       entity_results = $12::jsonb, errors = $13::jsonb
     WHERE id = $1`,
    [id, status, report?.entities_present?.length || 0, report?.records_present || 0,
      result?.created || 0, result?.updated || 0, result?.preserved || report?.records_to_preserve || 0,
      result?.skipped || report?.records_to_skip || 0, result?.conflicts || report?.conflict_count || 0,
      result?.failed || errors.length, JSON.stringify(report?.credential_bearing_entities || {}),
      JSON.stringify(result?.entities || report?.entity_results || {}), JSON.stringify(errors.slice(0, SAMPLE_LIMIT))],
  );
}

export async function runMigrationImport({ kind, mode, bundle, passphrase = '', user, confirmed = false }) {
  await ensureMigrationImportSchema();
  const runId = newId();
  await insertRun({ id: runId, kind, mode, user, bundle });
  try {
    const normalized = normalizeMigrationBundle({ kind, bundle, passphrase });
    const report = await analyzeMigration(normalized);
    if (mode === 'preview') {
      await finishRun(runId, 'validated', report);
      return { run_id: runId, mode, kind, ...report };
    }
    if (mode !== 'apply') throw new MigrationValidationError('Unknown migration mode');
    if (!confirmed) throw new MigrationValidationError('Explicit migration confirmation is required');
    const result = await applyNormalized(normalized, report);
    await finishRun(runId, 'success', report, result);
    return { run_id: runId, mode, kind, ...report, result: 'success', applied: result };
  } catch (error) {
    await finishRun(runId, 'failed', null, null, [auditError(error)]).catch(() => {});
    error.runId = runId;
    throw error;
  }
}

export default { normalizeMigrationBundle, analyzeMigration, runMigrationImport, mergeOrdinarySecrets, prepareMigrationRecord };
