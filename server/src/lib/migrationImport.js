import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { tableName } from '../schemas/index.js';
import { entityExists, newId } from '../db/repo.js';
import { ensureMigrationImportSchema } from '../db/migrationImportSchema.js';
import { ensureBase44SyncSchema } from '../db/base44SyncSchema.js';
import { hashApiKey, keyPrefixOf, translateCredentialNamespace, isLegacyNamespace } from './apiKeys.js';
import { MIGRATED_INVITATION_FIELD } from './googleAccountLink.js';
import { fingerprint } from './base44Sync.js';
import {
  IMPORT_FORCE,
  MIGRATION_CRYPTO,
  MIGRATION_FORMAT,
  MIGRATION_DROP_FIELDS,
  MIGRATION_DROP_RECORD,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_SECRETS_EXPECTED,
  MIGRATION_TARGET_PROTECTED_FIELDS,
  REDACTED,
} from '../functions/systemTransfer.generated.js';
import {
  DIAGNOSTIC_SAMPLE_LIMIT,
  ISSUE_SEVERITY,
  RECORD_DISPOSITION,
  planIdentity,
  planRelationships,
  rewriteReferences,
} from './migrationPlan.js';

const MAX_RECORDS = 1_000_000;
const MAX_CHUNKS = 20_000;
const SAMPLE_LIMIT = 50;
const IMPORT_LOCK_ID = 4471002;
const META_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id']);
const SECRET_KEY_PATTERN = /(auth|key|secret|token|password|passwd|pwd|bearer|sig|signature|credential)/i;

/* Progress reporting sink.
 *
 * The importer reports where it is, never what it is reading. Every value that
 * leaves through here is a stage name or a count: no record, no field, no
 * passphrase, no decrypted byte. Callers that do not care pass nothing and get
 * NULL_PROGRESS, so the import path behaves identically with progress off.
 */
export const NULL_PROGRESS = Object.freeze({
  stage() {},
  chunk() {},
});

// Every refusal the importer can produce is one of these, and every one of them
// carries a stable code as well as a message.
//
// The message is safe to show and is written for the operator. The code is what
// the browser branches on and what the server log records, so the copy can be
// reworded without changing either. Nothing here ever carries a passphrase, a
// decrypted value, or a record field.
export const MIGRATION_ERROR_CODE = Object.freeze({
  DECRYPT_FAILED: 'decrypt_failed',
  VALIDATION_FAILED: 'validation_failed',
  BAD_UPLOAD: 'bad_upload',
  UNAUTHORIZED: 'unauthorized',
  NOT_CONFIRMED: 'not_confirmed',
  TOO_LARGE: 'too_large',
  INTERNAL: 'internal',
});

export class MigrationValidationError extends Error {
  constructor(message, status = 400, code = MIGRATION_ERROR_CODE.VALIDATION_FAILED) {
    super(message);
    this.name = 'MigrationValidationError';
    this.status = status;
    this.code = code;
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

// Validate the crypto envelope against the canonical contract and return the
// parameters the package asked to be decrypted with.
//
// Structure and algorithm are matched exactly. The PBKDF2 work factor is the one
// parameter read back from the package, because it is a cost the exporter chose
// and recorded, and the same value has to go into pbkdf2 to arrive at the same
// key. Pinning it to a single constant here is what made every real export
// undecryptable. Bounding it by MIGRATION_FORMAT.iterations is what stops that
// from becoming either a downgrade or an unbounded amount of server work.
export function assertOwnerCrypto(bundle) {
  const spec = bundle?.crypto || {};

  if (!MIGRATION_FORMAT.formats.includes(bundle?.format)) {
    throw new MigrationValidationError(`Unsupported migration package format: ${String(bundle?.format || 'missing')}`);
  }
  if (!MIGRATION_FORMAT.formats.includes(spec.format)) {
    throw new MigrationValidationError('Unsupported migration crypto parameter: format');
  }
  if (spec.format !== bundle.format) {
    throw new MigrationValidationError('Migration package format does not match its crypto format');
  }

  // Fail closed on anything unrecognised rather than validating only the fields
  // this function happens to name.
  const allowed = new Set([...MIGRATION_FORMAT.crypto_keys_required, ...MIGRATION_FORMAT.crypto_keys_optional]);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) throw new MigrationValidationError(`Unsupported migration crypto parameter: ${key}`);
  }
  for (const key of MIGRATION_FORMAT.crypto_keys_required) {
    if (spec[key] === undefined || spec[key] === null) {
      throw new MigrationValidationError(`Missing migration crypto parameter: ${key}`);
    }
  }

  for (const [field, expected] of [
    ['kdf', MIGRATION_FORMAT.kdf],
    ['cipher', MIGRATION_FORMAT.cipher],
    ['key_bits', MIGRATION_FORMAT.key_bits],
    ['salt_bytes', MIGRATION_FORMAT.salt_bytes],
    ['iv_bytes', MIGRATION_FORMAT.iv_bytes],
  ]) {
    if (spec[field] !== expected) {
      throw new MigrationValidationError(`Unsupported migration crypto parameter: ${field}`);
    }
  }

  const { min, max } = MIGRATION_FORMAT.iterations;
  const iterations = spec.iterations;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) {
    throw new MigrationValidationError('Unsupported migration crypto parameter: iterations');
  }
  if (iterations < min) {
    throw new MigrationValidationError(
      `Migration package uses a weaker key derivation than DashFlo accepts: ${iterations} iterations, minimum ${min}`,
    );
  }
  if (iterations > max) {
    throw new MigrationValidationError(
      `Migration package requests more key derivation work than DashFlo allows: ${iterations} iterations, maximum ${max}`,
    );
  }

  const salt = decodeBase64(spec.salt, 'Migration salt');
  if (salt.length !== MIGRATION_FORMAT.salt_bytes) {
    throw new MigrationValidationError('Migration salt has the wrong length');
  }
  return { salt, iterations };
}

function decryptChunk(chunk, key) {
  const iv = decodeBase64(chunk?.iv, 'Chunk IV');
  if (iv.length !== MIGRATION_FORMAT.iv_bytes) throw new MigrationValidationError('Chunk IV has the wrong length');
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
    throw new MigrationValidationError(
      'Could not decrypt migration package. Check the passphrase and file integrity.',
      400,
      MIGRATION_ERROR_CODE.DECRYPT_FAILED,
    );
  }
}

function normalizeOwner(bundle, passphrase, progress = NULL_PROGRESS) {
  if (String(passphrase || '').length < 16) {
    throw new MigrationValidationError(
      'The migration passphrase must be at least 16 characters',
      400,
      MIGRATION_ERROR_CODE.DECRYPT_FAILED,
    );
  }
  if (!Array.isArray(bundle?.chunks) || bundle.chunks.length > MAX_CHUNKS) {
    throw new MigrationValidationError('Migration package has an invalid chunk list');
  }
  if (bundle.source_app !== 'legenex-dashboard' || bundle.target !== 'dashflo') {
    throw new MigrationValidationError('Migration package source or target is not DashFlo-compatible');
  }
  if (!safeDate(bundle.exported_at)) throw new MigrationValidationError('Migration package export timestamp is invalid');
  progress.stage('validating_envelope');
  const { salt, iterations } = assertOwnerCrypto(bundle);

  progress.stage('deriving_key');
  const key = crypto.pbkdf2Sync(
    Buffer.from(String(passphrase), 'utf8'),
    salt,
    iterations,
    MIGRATION_FORMAT.key_bits / 8,
    'sha256',
  );

  const entities = {};
  for (const name of Object.keys(bundle.counts || {})) entities[name] = [];
  let total = 0;
  let decrypted = 0;
  const positions = new Set();
  progress.stage('decrypting', { total_chunks: bundle.chunks.length, processed_chunks: 0 });
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
    decrypted += 1;
    progress.chunk(decrypted);
    if (total > MAX_RECORDS) throw new MigrationValidationError('Migration package record limit exceeded', 413, MIGRATION_ERROR_CODE.TOO_LARGE);
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
    if (total > MAX_RECORDS) throw new MigrationValidationError('Import bundle record limit exceeded', 413, MIGRATION_ERROR_CODE.TOO_LARGE);
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

export function normalizeMigrationBundle({ kind, bundle, passphrase = '', progress = NULL_PROGRESS }) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new MigrationValidationError('Migration file is not a JSON object');
  }
  if (kind === 'owner') return normalizeOwner(bundle, passphrase, progress);
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

/* Shape one source record into the DashFlo row that will be written for it.
 *
 * `remap` is the completed source id -> target id map for the whole package.
 * Passing it in rather than resolving references here is what makes the rewrite
 * independent of the order entities are processed in: by the time any record is
 * shaped, every id in the package already has its final target.
 *
 * `existingData` is the matched DashFlo row's data, empty for a create. It does
 * three separate jobs, which is why it is one argument: it restores redacted
 * credentials on an ordinary import, it keeps a credential namespace stable
 * across reruns, and it pins the fields DashFlo owns.
 */
export function prepareMigrationRecord(kind, entity, source, existingData = {}, options = {}) {
  const remap = options.remap || null;
  // Whether this record resolved onto a DashFlo record that already exists.
  // Defaulted from existingData so the three and four argument callers behave
  // exactly as they did, and passed explicitly by the planner and the apply.
  const matched = options.matched ?? Object.keys(existingData || {}).length > 0;
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

  // An imported invitation is history, never authorization. See the note in
  // lib/googleAccountLink.js: without this marker a pending Base44 invitation
  // would let any Google account holding the matching verified address create
  // a DashFlo account carrying whatever role that old row named.
  //
  // Stamped for both bundle kinds. IMPORT_FORCE would have been the obvious
  // mechanism, but it only applies to ordinary exports, and the real
  // production bundle is an owner export.
  //
  // The value is a constant, so a rerun writes the same thing and the record
  // still compares equal.
  if (entity === 'Invitation') {
    data[MIGRATED_INVITATION_FIELD] = true;
  }

  // Every declared record reference is moved onto its final target id. Without
  // this, matching a colliding parent through its natural key would relink the
  // parent and leave every child still pointing at the source id.
  if (remap && remap.size) {
    ({ data } = rewriteReferences(entity, data, remap));
  }

  // Fields DashFlo owns on a record it already holds. See
  // MIGRATION_TARGET_PROTECTED_FIELDS: for User these are the live authorization
  // fields that middleware/auth.js reads straight off the entity row, so a
  // source value here would silently change what a real account may do.
  const protectedFields = matched ? (MIGRATION_TARGET_PROTECTED_FIELDS[entity] || []) : [];
  let targetProtected = false;
  for (const field of protectedFields) {
    // DashFlo owns the field including its absence. A source record that
    // carries linked_buyer_id for an account DashFlo has never scoped to a
    // buyer portal must not be able to introduce one.
    if (field in existingData) {
      if (data[field] === existingData[field]) continue;
      data[field] = existingData[field];
    } else if (field in data) {
      delete data[field];
    } else {
      continue;
    }
    targetProtected = true;
  }

  return { meta, data, preserved, namespaceMigrated, targetProtected };
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

function valuesDiffer(a, b) {
  return fingerprint(a || {}) !== fingerprint(b || {});
}

/* Disposition of one already-identified record.
 *
 * Shared by the preview and by the apply so the numbers on screen are the
 * numbers the apply produces. Every matched record lands on exactly one of
 * update or preserve, and an unmatched one on create. There is no fourth
 * outcome: what used to be counted as "skipped" here was a record the importer
 * deliberately left alone because DashFlo held something newer, which is a
 * preserve, and calling it a skip is what made the totals impossible to
 * reconcile.
 */
export function disposeRecord({ kind, entity, source, existing, shaped }) {
  if (!existing) return { disposition: RECORD_DISPOSITION.CREATE, conflict: false, data: shaped.data };

  const sourceDate = safeDate(source.updated_date);
  const currentDate = safeDate(existing.updated_date);
  const targetIsNewer = !sourceDate || (currentDate && currentDate > sourceDate);

  if (targetIsNewer && valuesDiffer(shaped.data, existing.data)) {
    // DashFlo moved after the export. Owner packages still carry the durable
    // credentials across, because that is the one thing only they can supply,
    // and nothing else about the record is touched.
    const secrets = kind === 'owner' ? ownerSecretPatch(entity, shaped.data) : {};
    if (Object.keys(secrets).length) {
      return {
        disposition: RECORD_DISPOSITION.UPDATE,
        conflict: true,
        data: { ...existing.data, ...secrets },
        keepTargetTimestamp: true,
      };
    }
    return { disposition: RECORD_DISPOSITION.PRESERVE, conflict: true, data: existing.data };
  }

  const merged = { ...existing.data, ...shaped.data };
  if (!valuesDiffer(merged, existing.data)) {
    return { disposition: RECORD_DISPOSITION.PRESERVE, conflict: false, data: existing.data };
  }
  return { disposition: RECORD_DISPOSITION.UPDATE, conflict: false, data: merged };
}

/* Build the complete plan and the preview report for a normalized package.
 *
 * The order is the point. Identity for every record in the package is settled
 * first, so the source id -> target id map is complete before anything reads a
 * reference; then records are shaped against that finished map; then references
 * are resolved against final target ids. Relationship validation used to run on
 * raw source ids and could therefore never see a remap, which is why matching a
 * colliding parent had no way to fix its children.
 */
export async function buildMigrationPlan(normalized, queryable = pool) {
  const plan = await planIdentity(normalized, queryable);

  let recordsPresent = 0;
  let recordsToCreate = 0;
  let recordsToUpdate = 0;
  let recordsToPreserve = 0;
  let credentialsPreserved = 0;
  let targetProtectedCount = 0;
  const newerConflicts = [];

  for (const entity of plan.orderedNames) {
    const records = normalized.entities[entity] || [];
    recordsPresent += records.length;
    const entityPlan = plan.entityPlans.get(entity);
    if (!entityPlan?.supported) continue;

    const identity = plan.identity.get(entity) || new Map();
    const existingRows = plan.existingRows.get(entity) || new Map();

    for (const source of records) {
      const sourceId = String(source?.id || '').trim();
      const resolved = identity.get(sourceId);
      if (!resolved) continue; // excluded by rule, or unresolved: already accounted for.

      const existing = existingRows.get(sourceId) || null;
      const shaped = prepareMigrationRecord(normalized.kind, entity, source, existing?.data || {}, { remap: plan.remap, matched: Boolean(existing) });
      if (!shaped) continue;
      if (shaped.preserved) credentialsPreserved += 1;
      if (shaped.targetProtected) targetProtectedCount += 1;

      const outcome = disposeRecord({ kind: normalized.kind, entity, source, existing, shaped });
      if (outcome.conflict && newerConflicts.length < DIAGNOSTIC_SAMPLE_LIMIT) {
        newerConflicts.push({ entity, id: sourceId, reason: 'DashFlo record is newer than the source record' });
      }
      if (outcome.conflict) entityPlan.conflicts = (entityPlan.conflicts || 0) + 1;

      if (outcome.disposition === RECORD_DISPOSITION.CREATE) { entityPlan.create += 1; recordsToCreate += 1; }
      else if (outcome.disposition === RECORD_DISPOSITION.UPDATE) { entityPlan.update += 1; recordsToUpdate += 1; }
      else { entityPlan.preserve += 1; recordsToPreserve += 1; }
    }
  }

  const relationships = await planRelationships(normalized, plan, queryable);

  const conflictCount = [...plan.entityPlans.values()].reduce((sum, e) => sum + (e.conflicts || 0), 0);
  const declaredRecords = Object.values(normalized.declaredCounts || {})
    .reduce((sum, value) => sum + (Number(value) >= 0 ? Number(value) : 0), 0);

  const accounted = recordsToCreate + recordsToUpdate + recordsToPreserve
    + plan.excludedRecordCount + plan.unresolvedCount;

  const reconciliation = {
    declared_records: declaredRecords,
    exported_records: recordsPresent,
    planned_creates: recordsToCreate,
    planned_updates: recordsToUpdate,
    planned_preserves: recordsToPreserve,
    explicit_exclusions: plan.excludedRecordCount,
    unresolved: plan.unresolvedCount,
    // An attribute of the creates, updates and preserves above, never a sixth
    // bucket. Adding it to the total would count every remapped record twice.
    id_remaps: plan.remapCount,
    accounted_records: accounted,
    unaccounted_records: recordsPresent - accounted,
    balanced: accounted === recordsPresent,
    credentials_preserved: credentialsPreserved,
    target_protected_records: targetProtectedCount,
  };

  const entityReconciliation = plan.orderedNames.map((entity) => {
    const e = plan.entityPlans.get(entity);
    return {
      entity,
      supported: e.supported,
      declared: e.declared,
      exported: e.decrypted,
      create: e.create,
      update: e.update,
      preserve: e.preserve,
      excluded: e.excluded,
      unresolved: e.unresolved,
      remapped: e.remapped,
      balanced: e.create + e.update + e.preserve + e.excluded + e.unresolved === e.decrypted,
    };
  });

  const hardBlockers = [];
  for (const issue of plan.schemaIncompatibilities.slice(0, DIAGNOSTIC_SAMPLE_LIMIT)) {
    hardBlockers.push({ kind: 'schema', entity: issue.entity, detail: issue.reason });
  }
  for (const duplicate of plan.duplicateIds.slice(0, DIAGNOSTIC_SAMPLE_LIMIT)) {
    hardBlockers.push({ kind: 'duplicate_source_id', entity: duplicate.entity, source_id: duplicate.id, detail: 'the same source id appears more than once in this package' });
  }
  for (const collision of plan.collisions) {
    if (collision.severity !== ISSUE_SEVERITY.BLOCKER) continue;
    hardBlockers.push({ kind: 'id_collision', entity: collision.entity, source_id: collision.source_id, detail: collision.detail });
  }
  for (const issue of relationships.blockers.slice(0, DIAGNOSTIC_SAMPLE_LIMIT)) {
    hardBlockers.push({
      kind: 'relationship',
      entity: issue.entity,
      field: issue.field,
      source_id: issue.sample_source_ids[0] || null,
      detail: `${issue.reason}, and the DashFlo schema requires ${issue.entity}.${issue.field}`,
    });
  }
  if (!reconciliation.balanced) {
    hardBlockers.push({
      kind: 'reconciliation',
      entity: null,
      detail: `${reconciliation.unaccounted_records} exported record(s) have no disposition`,
    });
  }

  // Kept under its previous shape for the audit row writer and any older
  // client, with the new buckets added beside the old ones.
  const entityResults = {};
  for (const entity of plan.orderedNames) {
    const e = plan.entityPlans.get(entity);
    entityResults[entity] = {
      present: e.decrypted,
      create: e.create,
      update: e.update,
      preserve: e.preserve,
      skip: e.excluded + e.unresolved,
      conflict: e.conflicts || 0,
      excluded: e.excluded,
      unresolved: e.unresolved,
      remapped: e.remapped,
    };
  }

  const resolvedRemaps = [];
  for (const [entity, entityRemap] of plan.remap) {
    const identity = plan.identity.get(entity) || new Map();
    for (const [sourceId, targetId] of entityRemap) {
      if (resolvedRemaps.length >= DIAGNOSTIC_SAMPLE_LIMIT) break;
      const resolved = identity.get(sourceId);
      resolvedRemaps.push({
        entity,
        source_id: sourceId,
        target_id: targetId,
        matched_by: resolved?.matchedBy || 'natural_key',
        natural_key_field: resolved?.naturalKeyField || null,
      });
    }
  }

  const report = {
    package_version: normalized.packageVersion,
    source_application: normalized.sourceApplication,
    export_timestamp: normalized.exportedAt,
    entities_present: plan.presentNames,
    entities_missing: plan.supportedNames.filter((name) => !plan.presentNames.includes(name)),

    records_present: recordsPresent,
    records_to_create: recordsToCreate,
    records_to_update: recordsToUpdate,
    records_to_preserve: recordsToPreserve,
    records_to_skip: plan.excludedRecordCount + plan.unresolvedCount,

    reconciliation,
    entity_reconciliation: entityReconciliation,
    explicit_exclusions: plan.exclusions,
    resolved_id_remaps: resolvedRemaps,
    id_remap_count: plan.remapCount,

    id_collisions: plan.collisions,
    id_collision_count: Object.values(plan.collisionCounts).reduce((a, b) => a + b, 0),
    id_collision_types: plan.collisionCounts,

    relationship_issues: relationships.issues.slice(0, DIAGNOSTIC_SAMPLE_LIMIT),
    relationship_issue_count: relationships.issues.length,
    relationship_resolved: relationships.resolved,

    unresolved_records: plan.unresolved,
    unresolved_count: plan.unresolvedCount,
    hard_blockers: hardBlockers.slice(0, DIAGNOSTIC_SAMPLE_LIMIT),
    hard_blocker_count: hardBlockers.length,

    credential_bearing_entities: publicCredentialCounts(normalized),

    // Kept under their previous names so an older client, the audit row writer
    // and the existing status copy keep working unchanged.
    relationship_problems: relationships.issues
      .filter((issue) => issue.severity === ISSUE_SEVERITY.BLOCKER)
      .slice(0, DIAGNOSTIC_SAMPLE_LIMIT)
      .map((issue) => ({ target: issue.referenced_entity, id: issue.referenced_source_id, reason: issue.reason })),
    schema_incompatibilities: plan.schemaIncompatibilities.slice(0, DIAGNOSTIC_SAMPLE_LIMIT),
    duplicate_ids: plan.duplicateIds.slice(0, DIAGNOSTIC_SAMPLE_LIMIT),
    conflicts_with_newer_dashflo_data: newerConflicts,
    conflict_count: conflictCount,
    entity_results: entityResults,
    declared_count_discrepancies: normalized.countDiscrepancies || [],

    can_apply: hardBlockers.length === 0,
  };

  return { report, plan };
}

export async function analyzeMigration(normalized, queryable = pool) {
  const { report } = await buildMigrationPlan(normalized, queryable);
  return report;
}

/* Record which source id became which DashFlo id.
 *
 * base44_id is the id the source system used and dashflo_id is the row that was
 * actually written, so a remap is durable and auditable rather than something
 * only the preview knew about. They are equal for every record whose id did not
 * move, which is almost all of them.
 */
async function writeProvenance(client, entity, sourceId, targetId, updatedDate, data, modified = false) {
  await client.query(
    `INSERT INTO base44_record_provenance
       (entity, base44_id, dashflo_id, source_updated_date, dashflo_fingerprint, dashflo_modified, last_synced_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, now())
     ON CONFLICT (entity, base44_id) DO UPDATE SET
       dashflo_id = EXCLUDED.dashflo_id,
       source_updated_date = EXCLUDED.source_updated_date,
       dashflo_fingerprint = EXCLUDED.dashflo_fingerprint,
       dashflo_modified = EXCLUDED.dashflo_modified,
       conflict = false,
       conflict_reason = null,
       conflict_at = null,
       last_synced_at = now()`,
    [entity, sourceId, targetId, safeDate(updatedDate)?.toISOString() || null, fingerprint(data), modified],
  );
}

/* Apply a plan that a preview has already produced.
 *
 * The plan is not rebuilt here. Identity, the remap and every disposition were
 * decided by buildMigrationPlan against the same target state inside the same
 * request, and this walks that decision. That is what makes the preview counts a
 * promise rather than an estimate: there is one identity decision path, not two
 * that have to be kept in agreement.
 *
 * The row is still re-read FOR UPDATE and the disposition still recomputed
 * against what the lock returns, so a concurrent write between the plan and the
 * transaction cannot be overwritten unseen.
 */
async function applyNormalized(normalized, report, plan) {
  if (!report.can_apply) throw new MigrationValidationError('Migration cannot be applied until validation errors are resolved', 409);
  const result = {
    created: 0, updated: 0, preserved: 0, skipped: 0, conflicts: 0, failed: 0, remapped: 0,
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

    for (const entity of plan.orderedNames) {
      if (!entityExists(entity)) continue;
      const identity = plan.identity.get(entity);
      if (!identity) continue;
      const table = tableName(entity);
      const stats = {
        created: 0, updated: 0, preserved: 0, skipped: 0, conflicts: 0, failed: 0,
        remapped: 0, credentials_namespaced: 0,
      };

      for (const source of normalized.entities[entity] || []) {
        const sourceId = String(source?.id || '').trim();
        const resolved = identity.get(sourceId);
        // Excluded by an explicit rule, or left unresolved. can_apply already
        // refused the second case, so what reaches here is an exclusion.
        if (!resolved) { stats.skipped += 1; result.skipped += 1; continue; }
        const targetId = resolved.targetId;

        const { rows } = await client.query(
          `SELECT id, data, created_by, created_date, updated_date FROM ${table} WHERE id = $1 FOR UPDATE`,
          [targetId],
        );
        const current = rowToExisting(rows[0]);
        const shaped = prepareMigrationRecord(normalized.kind, entity, source, current?.data || {}, { remap: plan.remap, matched: Boolean(current) });
        if (!shaped) { stats.skipped += 1; result.skipped += 1; continue; }
        if (shaped.namespaceMigrated) { stats.credentials_namespaced += 1; result.credentials_namespaced += 1; }
        if (resolved.remapped) { stats.remapped += 1; result.remapped += 1; }

        const outcome = disposeRecord({ kind: normalized.kind, entity, source, existing: current, shaped });
        let data = outcome.data;
        if (outcome.conflict) { stats.conflicts += 1; result.conflicts += 1; }

        // Belt and braces. prepareMigrationRecord already translated and dropped
        // the cleartext, so no branch should reach here holding a raw key. If a
        // future change reintroduces one it is translated rather than hashed in
        // the old namespace.
        if (CREDENTIAL_ENTITIES.has(entity) && data.key && CREDENTIAL_SHAPE[entity]?.dropRaw) {
          const translated = translateCredentialNamespace(String(data.key));
          data = { ...data, key_hash: hashApiKey(translated), key_prefix: keyPrefixOf(translated) };
          delete data.key;
        }

        if (outcome.disposition === RECORD_DISPOSITION.CREATE) {
          await client.query(
            `INSERT INTO ${table} (id, data, created_by, created_date, updated_date)
             VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))`,
            [targetId, JSON.stringify(data), shaped.meta.created_by, safeDate(source.created_date)?.toISOString() || null,
              safeDate(source.updated_date)?.toISOString() || null],
          );
          stats.created += 1; result.created += 1;
        } else if (outcome.disposition === RECORD_DISPOSITION.UPDATE) {
          await client.query(
            `UPDATE ${table} SET data = $2::jsonb,
               created_by = COALESCE($3, created_by),
               created_date = COALESCE($4::timestamptz, created_date),
               updated_date = COALESCE($5::timestamptz, updated_date)
             WHERE id = $1`,
            [targetId, JSON.stringify(data), shaped.meta.created_by, safeDate(source.created_date)?.toISOString() || null,
              outcome.keepTargetTimestamp
                ? safeDate(current.updated_date)?.toISOString() || null
                : safeDate(source.updated_date)?.toISOString() || null],
          );
          stats.updated += 1; result.updated += 1;
        } else {
          stats.preserved += 1; result.preserved += 1;
        }
        await writeProvenance(client, entity, sourceId, targetId, source.updated_date, data, outcome.conflict);
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

export async function runMigrationImport({ kind, mode, bundle, passphrase = '', user, confirmed = false, progress = NULL_PROGRESS }) {
  await ensureMigrationImportSchema();
  const runId = newId();
  await insertRun({ id: runId, kind, mode, user, bundle });
  try {
    const normalized = normalizeMigrationBundle({ kind, bundle, passphrase, progress });
    progress.stage('validating');
    // One plan per run. The preview reports it and the apply walks it, so the
    // counts an operator approved are the counts the apply produces.
    const { report, plan } = await buildMigrationPlan(normalized);
    if (mode === 'preview') {
      progress.stage('building_preview');
      await finishRun(runId, 'validated', report);
      progress.stage('complete');
      return { run_id: runId, mode, kind, ...report };
    }
    if (mode !== 'apply') throw new MigrationValidationError('Unknown migration mode');
    if (!confirmed) throw new MigrationValidationError('Explicit migration confirmation is required', 400, MIGRATION_ERROR_CODE.NOT_CONFIRMED);
    progress.stage('applying');
    const result = await applyNormalized(normalized, report, plan);
    await finishRun(runId, 'success', report, result);
    progress.stage('complete');
    return { run_id: runId, mode, kind, ...report, result: 'success', applied: result };
  } catch (error) {
    await finishRun(runId, 'failed', null, null, [auditError(error)]).catch(() => {});
    error.runId = runId;
    throw error;
  }
}

export default {
  MIGRATION_ERROR_CODE,
  normalizeMigrationBundle,
  analyzeMigration,
  buildMigrationPlan,
  disposeRecord,
  runMigrationImport,
  mergeOrdinarySecrets,
  prepareMigrationRecord,
};
