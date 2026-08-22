import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { tableName, getSchema } from '../schemas/index.js';
import { entityExists } from '../db/repo.js';
import {
  ALL_ENTITIES,
  ENTITY_ORDER,
  LEGACY_IDENTITY_ALIASES,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_EXCLUSION_RULES,
  NATURAL_KEYS,
  REFS,
  SECTIONS,
} from '../functions/systemTransfer.generated.js';

/* The owner migration planner.
 *
 * What this module exists to fix.
 *
 * The importer used to answer one question per record, "is there already a row
 * with this id", and treat everything else as an error. A natural key that
 * matched an existing DashFlo record under a different id was reported as an
 * "ID collision" and blocked the apply, with no way to ever resolve it, and a
 * reference to an id that was absent from both sides was reported as a
 * "relationship issue" with no indication of which record held it. Neither had
 * a resolution path, so a package could be previewed forever and never applied.
 *
 * Worse, the collision check was the only thing standing between the apply and
 * a duplicate: nothing in the write path consulted a natural key, so removing
 * the block would have inserted a second row for a person or supplier DashFlo
 * already had.
 *
 * So the planner decides identity first, for every record in the package, and
 * only then looks at anything else:
 *
 *   1. inventory every entity the package declares
 *   2. classify each record as supported, excluded by rule, or unaccounted
 *   3. read target identity state, read only
 *   4. resolve identity: by source id, then by natural key
 *   5. allocate deterministic new ids for genuine id collisions
 *   6. build the complete source id -> target id remap
 *   7. resolve every relationship against FINAL target ids
 *   8. reconcile: every exported record has exactly one disposition
 *
 * Relationship resolution is a separate pass over an already complete remap, so
 * it cannot depend on the order entities happened to appear in the package.
 *
 * Nothing here writes. The only queries are SELECTs against the target tables,
 * and no value read out of a record is ever placed in a diagnostic: blocker
 * entries carry entity names, field names and record ids only.
 */

// A record has exactly one of these. Remap is deliberately absent: it is an
// attribute of a create, an update or a preserve, not a fourth outcome, and
// adding it to the totals would double count every record it applies to.
export const RECORD_DISPOSITION = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  PRESERVE: 'preserve',
  EXCLUDED: 'excluded',
  UNRESOLVED: 'unresolved',
});

export const COLLISION_TYPE = Object.freeze({
  // A. The source record is the record DashFlo already holds. Matched through a
  // natural key and dispositioned normally.
  SAME_LOGICAL_RECORD: 'same_logical_record',
  // C. The matched DashFlo record was created by DashFlo rather than carried in
  // from the source system. Same treatment, reported separately because the
  // protected-field policy is what keeps it intact.
  DASHFLO_NATIVE_PROTECTED: 'dashflo_native_protected',
  // B. A different logical record whose source id is already taken in DashFlo.
  // Gets a fresh deterministic target id and a remap.
  DIFFERENT_LOGICAL_RECORD: 'different_logical_record',
  // E. Two DashFlo records answer to one natural key, so identity cannot be
  // decided. Fail closed.
  AMBIGUOUS_TARGET_MATCH: 'ambiguous_target_match',
  // E. Two source records fold to one natural key and that key already matches
  // a DashFlo record, so both would claim the same target. Fail closed.
  DUPLICATE_IN_PACKAGE_CLAIMS_TARGET: 'duplicate_in_package_claims_target',
  // Two source records fold to one natural key and neither matches anything in
  // DashFlo. Both are created under their own ids, which loses nothing, and the
  // duplicate is inherited from the source rather than introduced here.
  DUPLICATE_IN_PACKAGE: 'duplicate_in_package',
  // E. The id allocated for a remap is itself taken. Fail closed rather than
  // guess again.
  REMAP_TARGET_TAKEN: 'remap_target_taken',
  // E. A previous migration already recorded a different source record as the
  // origin of this DashFlo record. base44_record_provenance is UNIQUE on
  // (entity, dashflo_id) precisely so one DashFlo record cannot have two source
  // origins, and letting the apply discover that would abort the transaction
  // instead of telling the owner about it.
  TARGET_ALREADY_MIGRATED: 'target_already_migrated',
});

export const RELATIONSHIP_STATUS = Object.freeze({
  RESOLVED_IN_PACKAGE: 'resolved_in_package',
  RESOLVED_BY_REMAP: 'resolved_by_remap',
  RESOLVED_IN_TARGET: 'resolved_in_target',
  // The reference value did not match any record id, in the package or in
  // DashFlo, but it matched the target entity's own natural key exactly once.
  // See "Legacy identity alias" below.
  RESOLVED_BY_NATURAL_KEY_ALIAS: 'resolved_by_natural_key_alias',
  REFERENCED_RECORD_EXCLUDED: 'referenced_record_excluded',
  REFERENCED_RECORD_ABSENT: 'referenced_record_absent',
  // The reference value matched the target's natural key more than once, so
  // which record was meant cannot be decided. Distinct from plain absence: the
  // package or DashFlo has candidates, just not exactly one.
  REFERENCED_RECORD_AMBIGUOUS_ALIAS: 'referenced_record_ambiguous_alias',
  REFERENCED_ENTITY_UNSUPPORTED: 'referenced_entity_unsupported',
});

// How an issue affects the apply. Only BLOCKER stops it.
export const ISSUE_SEVERITY = Object.freeze({
  RESOLVED: 'resolved',
  WARNING: 'warning',
  BLOCKER: 'blocker',
});

// Diagnostics are bounded so a pathological package cannot turn the preview
// response into a second copy of itself. Counts are always the true totals; the
// arrays are samples and say so.
export const DIAGNOSTIC_SAMPLE_LIMIT = 200;

// Ids are read back in batches rather than as one enormous ANY() array. The
// largest entity in a real package is six figures.
const ID_LOOKUP_BATCH = 5000;

/* A new target id for a record whose own id is already taken by an unrelated
 * DashFlo record.
 *
 * Derived rather than random on purpose. The preview has to be able to promise
 * a target id that the apply will actually use, and a rerun of the same package
 * has to arrive at the same id or the second run would allocate a third record.
 * crypto.randomBytes cannot do either. The digest is truncated to 24 hex
 * characters, which is exactly the shape db/repo.js newId() produces, so a
 * remapped record is indistinguishable from a natively created one afterwards.
 */
export function derivedTargetId(entity, sourceId) {
  return crypto.createHash('sha256')
    .update(`dashflo-migration-remap:${entity}:${sourceId}`)
    .digest('hex')
    .slice(0, 24);
}

// ── Natural key comparison ──────────────────────────────────────────────────
//
// Which natural keys are compared case-insensitively, and which are compared
// exactly.
//
// An email address is the same person whatever its capitalisation, so
// `Owner@Example.com` arriving from the source must be recognised as the account
// already stored as `owner@example.com` rather than created alongside it.
//
// Codes are not folded. Supplier `sid` and `source_code` carry compatibility
// sensitive longest-prefix matching against inbound lead traffic, and buyer and
// campaign codes appear in external systems. Folding those would change which
// records are considered the same and is not a change to make quietly inside an
// identity check. Whitespace is trimmed on every key, because leading or
// trailing space in an identifier is never meaningful.
const CASE_INSENSITIVE_NATURAL_KEYS = new Set(['User.email']);

export function foldsCase(entity, naturalKey) {
  return CASE_INSENSITIVE_NATURAL_KEYS.has(`${entity}.${naturalKey}`);
}

export function naturalKeyFolder(entity, naturalKey) {
  return foldsCase(entity, naturalKey)
    ? (value) => String(value).trim().toLowerCase()
    : (value) => String(value).trim();
}

// The SQL side of the same fold, so the stored value and the incoming value are
// compared the same way.
export function foldSql(entity, naturalKey, expression) {
  return foldsCase(entity, naturalKey) ? `lower(btrim(${expression}))` : `btrim(${expression})`;
}

function naturalKeyValue(entity, record) {
  const field = NATURAL_KEYS[entity];
  if (!field) return null;
  const raw = record?.[field];
  if (raw == null || String(raw) === '') return null;
  return naturalKeyFolder(entity, field)(String(raw));
}

/* Entity behavior class, for the diagnostic report only.
 *
 * Not a hand-maintained table: this reads two things the catalog already
 * declares for other reasons, so it cannot drift from the identity policy it
 * describes. Whether an entity has a declared identity field beyond its own
 * record id is exactly the answer to "does this entity get natural-key
 * matching or pure id matching", which is the one distinction that actually
 * changes migration behavior. 'historical' further separates the SECTIONS
 * 'logs' group: the append-only, high-volume audit and sync history that a
 * duplicate identity check must never fold into a "same logical record" the
 * way it correctly would for a Buyer or a Supplier. All three classes already
 * get the collision policy this describes; nothing here changes behavior,
 * only names it, so the reconciliation-by-entity report can say why.
 *
 *   master        has NATURAL_KEYS or LEGACY_IDENTITY_ALIASES: an exact
 *                 duplicate id is a hard blocker, but a same-natural-key
 *                 record under a different id resolves to one logical
 *                 record, matched and never silently merged with a
 *                 same-key package sibling.
 *   historical     the SECTIONS 'logs' group, no identity field at all: an
 *                 exact duplicate id is still a hard blocker (two records
 *                 cannot both be one row), but nothing else about the
 *                 record's content is ever compared, since repeated field
 *                 values across separate events are expected, not a
 *                 collision.
 *   transactional  everything else: pure id matching, same guarantee as
 *                 historical, grouped separately only for readability.
 */
export function entityClass(entity) {
  if (NATURAL_KEYS[entity] || (LEGACY_IDENTITY_ALIASES[entity] || []).length) return 'master';
  const section = SECTIONS.find((s) => s.entities.includes(entity));
  if (section?.key === 'logs') return 'historical';
  return 'transactional';
}

// The identity fields relationship resolution may try for this entity, in
// priority order: the primary NATURAL_KEYS field first, then any declared
// LEGACY_IDENTITY_ALIASES. Record identity and collision detection never
// consult this: they use NATURAL_KEYS[entity] alone, always. This list exists
// only for the reference-value fallback in planRelationships.
export function identityAliasFields(entity) {
  const fields = [];
  const primary = NATURAL_KEYS[entity];
  if (primary) fields.push(primary);
  for (const field of LEGACY_IDENTITY_ALIASES[entity] || []) {
    if (!fields.includes(field)) fields.push(field);
  }
  return fields;
}

function aliasFieldValue(entity, field, record) {
  const raw = record?.[field];
  if (raw == null || String(raw) === '') return null;
  return naturalKeyFolder(entity, field)(String(raw));
}

// Reference ids held in a field, for the two reference kinds that carry record
// ids. 'code' fields are natural keys or external identifiers and are never
// touched.
export function referenceIds(value, kind) {
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

export function requiredFields(entity) {
  const schema = getSchema(entity);
  return new Set(Array.isArray(schema?.required) ? schema.required : []);
}

// Record-scoped exclusion rules, indexed by entity, with the predicate that
// decides them. The predicate lives with the catalog entry it is authorised by
// so an exclusion cannot happen without a rule to point at.
const RECORD_EXCLUSION_PREDICATES = {
  'integration_config.meta_oauth_state': (record) => String(record?.name || '') === 'meta_oauth_state',
};

export function recordExclusionRule(entity, record) {
  for (const rule of MIGRATION_EXCLUSION_RULES) {
    if (rule.scope !== 'record' || rule.entity !== entity) continue;
    const predicate = RECORD_EXCLUSION_PREDICATES[rule.key];
    if (predicate && predicate(record)) return rule;
  }
  return null;
}

async function loadRowsByIds(queryable, entity, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const table = tableName(entity);
  for (let i = 0; i < ids.length; i += ID_LOOKUP_BATCH) {
    const batch = ids.slice(i, i + ID_LOOKUP_BATCH);
    const { rows } = await queryable.query(
      `SELECT id, data, created_by, created_date, updated_date FROM ${table} WHERE id = ANY($1::text[])`,
      [batch],
    );
    for (const row of rows) {
      out.set(String(row.id), {
        id: String(row.id),
        created_by: row.created_by,
        created_date: row.created_date,
        updated_date: row.updated_date,
        data: row.data || {},
      });
    }
  }
  return out;
}

// Existing rows keyed by their folded value in the given field. A key answered
// by more than one row is recorded as a list so identity can fail closed
// rather than pick the first one the database happened to return. Exported:
// the relationship resolver reuses this exact query to try a reference value
// against a target entity's identity field, whether that field is the
// entity's primary NATURAL_KEYS or a declared legacy alias, rather than
// inventing a second way to ask the same question.
export async function loadRowsByNaturalKey(queryable, entity, field, values) {
  const out = new Map();
  if (!field || !values.length) return out;
  const table = tableName(entity);
  const folded = foldSql(entity, field, 'data->>$1');
  for (let i = 0; i < values.length; i += ID_LOOKUP_BATCH) {
    const batch = values.slice(i, i + ID_LOOKUP_BATCH);
    const { rows } = await queryable.query(
      `SELECT id, data, created_by, created_date, updated_date, ${folded} AS natural_value
         FROM ${table} WHERE ${folded} = ANY($2::text[])`,
      [field, batch],
    );
    for (const row of rows) {
      const key = String(row.natural_value);
      const list = out.get(key) || [];
      list.push({
        id: String(row.id),
        created_by: row.created_by,
        created_date: row.created_date,
        updated_date: row.updated_date,
        data: row.data || {},
      });
      out.set(key, list);
    }
  }
  return out;
}

/* Which source record each candidate DashFlo record already came from.
 *
 * Two answers come out of one lookup. A DashFlo id that is absent was created by
 * DashFlo rather than carried in, which is what makes it a protected native
 * record. A DashFlo id that is present under a different source id is a target
 * with two claimed origins, which the UNIQUE (entity, dashflo_id) index on
 * base44_record_provenance forbids.
 *
 * Read only, and it degrades to "no provenance known" rather than failing when
 * the table has not been created yet, which is the state of a fresh install.
 */
async function loadProvenance(queryable, entity, ids) {
  const known = new Map();
  if (!ids.length) return known;
  try {
    for (let i = 0; i < ids.length; i += ID_LOOKUP_BATCH) {
      const batch = ids.slice(i, i + ID_LOOKUP_BATCH);
      const { rows } = await queryable.query(
        'SELECT base44_id, dashflo_id FROM base44_record_provenance WHERE entity = $1 AND dashflo_id = ANY($2::text[])',
        [entity, batch],
      );
      for (const row of rows) known.set(String(row.dashflo_id), String(row.base44_id));
    }
  } catch {
    return known;
  }
  return known;
}

/* Decide the target identity of one source record.
 *
 * Pure, and shared by the preview and by the apply, so the two cannot disagree
 * about which DashFlo row a source record is. Everything it needs is passed in.
 */
export function resolveIdentity({
  entity,
  sourceId,
  naturalValue,
  rowById,
  rowsByNaturalKey = [],
  claimedTargetIds,
  targetIdTaken,
}) {
  const naturalKeyField = NATURAL_KEYS[entity] || null;

  if (rowsByNaturalKey.length > 1) {
    return {
      targetId: null,
      collision: {
        type: COLLISION_TYPE.AMBIGUOUS_TARGET_MATCH,
        existing_target_ids: rowsByNaturalKey.map((row) => row.id).slice(0, 8),
        detail: `${rowsByNaturalKey.length} DashFlo records answer to this natural key`,
      },
    };
  }

  const match = rowsByNaturalKey[0] || null;

  // Matched by natural key to a record already claimed by an earlier source
  // record in this same package. Both cannot be the same DashFlo row.
  if (match && claimedTargetIds?.has(match.id)) {
    return {
      targetId: null,
      collision: {
        type: COLLISION_TYPE.DUPLICATE_IN_PACKAGE_CLAIMS_TARGET,
        existing_target_id: match.id,
        detail: 'another record in this package already matched that DashFlo record through the same natural key',
      },
    };
  }

  // The id is free. Either the natural key points at a DashFlo record, in which
  // case that record is the target and the id moves, or nothing matches and the
  // record is created under its own id.
  if (!rowById) {
    if (!match) return { targetId: sourceId, existing: null, matchedBy: 'source_id' };
    return {
      targetId: match.id,
      existing: match,
      matchedBy: 'natural_key',
      naturalKeyField,
      collision: {
        type: COLLISION_TYPE.SAME_LOGICAL_RECORD,
        existing_target_id: match.id,
        detail: 'natural key matched an existing DashFlo record held under a different id',
      },
    };
  }

  // A row already holds this id. If it is the same logical record, or the
  // entity has no natural key to judge by, this is an ordinary in place import.
  const existingValue = naturalKeyField ? naturalKeyValue(entity, { ...rowById.data, id: rowById.id }) : null;
  const sameLogical = !naturalKeyField
    || naturalValue == null
    || existingValue == null
    || existingValue === naturalValue;

  if (sameLogical) {
    // The natural key of this source record points somewhere else entirely, so
    // two DashFlo rows both claim to be it.
    if (match && match.id !== rowById.id) {
      return {
        targetId: null,
        collision: {
          type: COLLISION_TYPE.AMBIGUOUS_TARGET_MATCH,
          existing_target_ids: [rowById.id, match.id],
          detail: 'the source id and the source natural key resolve to different DashFlo records',
        },
      };
    }
    return { targetId: sourceId, existing: rowById, matchedBy: 'source_id' };
  }

  // Different logical record under the same id. If the natural key points at a
  // DashFlo record, that record is the target. Otherwise allocate a new id.
  if (match) {
    return {
      targetId: match.id,
      existing: match,
      matchedBy: 'natural_key',
      naturalKeyField,
      collision: {
        type: COLLISION_TYPE.DIFFERENT_LOGICAL_RECORD,
        existing_target_id: match.id,
        detail: 'the source id belongs to an unrelated DashFlo record; the natural key identified the correct one',
      },
    };
  }

  const allocated = derivedTargetId(entity, sourceId);
  if (targetIdTaken?.(allocated)) {
    return {
      targetId: null,
      collision: {
        type: COLLISION_TYPE.REMAP_TARGET_TAKEN,
        existing_target_id: allocated,
        detail: 'the allocated replacement id is itself already in use',
      },
    };
  }
  return {
    targetId: allocated,
    existing: null,
    matchedBy: 'allocated',
    collision: {
      type: COLLISION_TYPE.DIFFERENT_LOGICAL_RECORD,
      existing_target_id: rowById.id,
      allocated_target_id: allocated,
      detail: 'the source id belongs to an unrelated DashFlo record; a new DashFlo id was allocated',
    },
  };
}

/* Rewrite every declared record reference on one record to its final target id.
 *
 * `remap` is the completed source id -> target id map for the whole package, so
 * this can run in any order. Fields of kind 'code' are left alone: they are
 * natural keys or external identifiers, and Lead.buyer_id in particular holds
 * buyer codes despite its name.
 */
export function rewriteReferences(entity, data, remap, aliasTargets = null) {
  const refs = REFS[entity];
  if (!refs) return { data, rewrites: 0 };
  let out = data;
  let rewrites = 0;

  // A reference resolved through the legacy identity alias is a raw value
  // that never was a record id, so it has to be rewritten here exactly like an
  // ordinary remap. Leaving it as the alias value would apply cleanly and then
  // fail at runtime the first time application code reads that field expecting
  // a record id: it would look correct in the preview and be wrong in the
  // database. `entity -> identity field -> foldedValue -> targetId`, produced
  // by planRelationships from both the package's own identity fields and
  // DashFlo's. Fields are tried in the same priority order identity
  // resolution used, so the id this writes is the same id the preview
  // promised.
  const aliasFor = (target, rawValue) => {
    const perEntity = aliasTargets?.get(target);
    if (!perEntity || !perEntity.size) return null;
    for (const field of identityAliasFields(target)) {
      const index = perEntity.get(field);
      if (!index || !index.size) continue;
      const hit = index.get(naturalKeyFolder(target, field)(String(rawValue)));
      if (hit) return hit;
    }
    return null;
  };

  for (const [field, ref] of Object.entries(refs)) {
    if (ref.kind !== 'id' && ref.kind !== 'idsJson') continue;
    const entityRemap = remap.get(ref.target);
    const aliasIndex = aliasTargets?.get(ref.target);
    if ((!entityRemap || !entityRemap.size) && (!aliasIndex || !aliasIndex.size)) continue;
    const value = out[field];
    if (value == null || value === '') continue;

    if (ref.kind === 'id') {
      const raw = String(value);
      const mapped = entityRemap?.get(raw) || aliasFor(ref.target, raw);
      if (mapped && mapped !== raw) {
        if (out === data) out = { ...data };
        out[field] = mapped;
        rewrites += 1;
      }
      continue;
    }

    const ids = referenceIds(value, 'idsJson');
    if (!ids.length) continue;
    let changed = false;
    const mappedIds = ids.map((id) => {
      const mapped = entityRemap?.get(id) || aliasFor(ref.target, id);
      if (mapped && mapped !== id) { changed = true; return mapped; }
      return id;
    });
    if (changed) {
      if (out === data) out = { ...data };
      out[field] = typeof value === 'string' ? JSON.stringify(mappedIds) : mappedIds;
      rewrites += 1;
    }
  }
  return { data: out, rewrites };
}

function pushSample(list, entry) {
  if (list.length < DIAGNOSTIC_SAMPLE_LIMIT) list.push(entry);
}

/* Phase 1 to 6. Identity for every record in the package.
 *
 * Returns the complete remap plus per-entity accounting, the collision report
 * and the exclusion report. No record disposition (create, update, preserve) is
 * decided here: that needs the shaped record, which needs the finished remap,
 * which is what this phase produces.
 */
export async function planIdentity(normalized, queryable = pool) {
  const supportedNames = normalized.kind === 'owner' ? MIGRATION_ENTITY_ORDER : ALL_ENTITIES;
  // Which entities the package may contain, and the order they are planned and
  // written in, are two different questions. ALL_ENTITIES is the export panel's
  // section order; ENTITY_ORDER is the parents-before-children import order.
  const writeOrder = normalized.kind === 'owner' ? MIGRATION_ENTITY_ORDER : ENTITY_ORDER;
  const presentNames = Object.keys(normalized.entities);
  // Plan in catalog order rather than package order, so the plan is identical
  // whichever order the exporter happened to write its chunks in.
  const orderedNames = [
    ...writeOrder.filter((name) => presentNames.includes(name)),
    ...presentNames.filter((name) => !writeOrder.includes(name)),
  ];

  const remap = new Map();
  const identity = new Map();
  const excludedIds = new Map();
  const existingRows = new Map();
  // Entity -> identity field -> folded value -> { targetId, ambiguous }. A
  // byproduct of identity resolution, not a second pass over the data: every
  // value here is a value this entity's own records already carry in one of
  // its identityAliasFields, pointed at wherever that record actually
  // resolved. Consulted by planRelationships as a fallback when a reference
  // field's raw value is not a record id anyone recognises. See "Legacy
  // identity alias" there.
  const naturalKeyAlias = new Map();

  const collisions = [];
  const collisionCounts = {};
  const unresolved = [];
  const schemaIncompatibilities = [];
  const duplicateIds = [];
  const exclusionCounts = new Map();
  const entityPlans = new Map();

  let unresolvedCount = 0;
  let excludedRecordCount = 0;
  let remapCount = 0;

  const noteCollision = (entry) => {
    collisionCounts[entry.collision_type] = (collisionCounts[entry.collision_type] || 0) + 1;
    pushSample(collisions, entry);
  };

  for (const entity of orderedNames) {
    const records = normalized.entities[entity] || [];
    const plan = {
      entity,
      supported: true,
      decrypted: records.length,
      declared: Number(normalized.declaredCounts?.[entity] ?? records.length),
      create: 0,
      update: 0,
      preserve: 0,
      excluded: 0,
      unresolved: 0,
      remapped: 0,
    };
    entityPlans.set(entity, plan);

    if (!supportedNames.includes(entity) || !entityExists(entity)) {
      plan.supported = false;
      plan.unresolved = records.length;
      unresolvedCount += records.length;
      schemaIncompatibilities.push({ entity, reason: 'entity is not supported by this DashFlo schema' });
      for (const record of records) {
        pushSample(unresolved, {
          entity,
          source_id: String(record?.id || ''),
          reason: 'entity is not supported by this DashFlo schema',
          resolution: 'Add the entity to the DashFlo schema, or confirm with the owner that it is excluded.',
        });
      }
      continue;
    }

    // Exclusions and structural problems first, so identity only ever runs on
    // records that are actually going to be imported.
    const importable = [];
    const seenIds = new Set();
    for (const record of records) {
      const sourceId = String(record?.id || '').trim();
      if (!sourceId) {
        plan.unresolved += 1;
        unresolvedCount += 1;
        schemaIncompatibilities.push({ entity, reason: 'record is missing its source id' });
        pushSample(unresolved, {
          entity,
          source_id: '',
          reason: 'record is missing its source id, so it has no stable identity',
          resolution: 'Re-export the package. A record without an id cannot be given a deterministic target.',
        });
        continue;
      }
      if (seenIds.has(sourceId)) {
        plan.unresolved += 1;
        unresolvedCount += 1;
        duplicateIds.push({ entity, id: sourceId });
        pushSample(unresolved, {
          entity,
          source_id: sourceId,
          reason: 'the same source id appears more than once in this package',
          resolution: 'Re-export the package. Two records claiming one id cannot both be imported.',
        });
        continue;
      }
      seenIds.add(sourceId);

      const rule = recordExclusionRule(entity, record);
      if (rule) {
        plan.excluded += 1;
        excludedRecordCount += 1;
        const bucket = exclusionCounts.get(rule.key) || { rule, count: 0, ids: [] };
        bucket.count += 1;
        if (bucket.ids.length < 20) bucket.ids.push(sourceId);
        exclusionCounts.set(rule.key, bucket);
        const set = excludedIds.get(entity) || new Set();
        set.add(sourceId);
        excludedIds.set(entity, set);
        continue;
      }
      importable.push({ sourceId, record });
    }
    // Set even when empty. An entity whose every record was excluded still has
    // to be distinguishable from one that was never planned, or the apply reads
    // "no identity map" as "skip this entity" and loses the exclusion count.
    identity.set(entity, new Map());
    existingRows.set(entity, new Map());

    if (!importable.length) continue;

    const ids = importable.map((item) => item.sourceId);
    const byId = await loadRowsByIds(queryable, entity, ids);

    // Prioritize records that have an exact ID match in the target database.
    // This ensures that when two source records share a natural key and one has
    // an exact ID match (sourceId === targetId), that record gets priority over
    // a record that would only match via natural key remap.
    importable.sort((a, b) => {
      const aHasExactMatch = byId.has(a.sourceId);
      const bHasExactMatch = byId.has(b.sourceId);
      if (aHasExactMatch && !bHasExactMatch) return -1;
      if (!aHasExactMatch && bHasExactMatch) return 1;
      return 0;
    });

    const naturalKeyField = NATURAL_KEYS[entity] || null;
    let byNaturalKey = new Map();
    if (naturalKeyField) {
      const values = [...new Set(importable.map((item) => naturalKeyValue(entity, item.record)).filter((v) => v != null))];
      byNaturalKey = await loadRowsByNaturalKey(queryable, entity, naturalKeyField, values);
    }

    // Every DashFlo id this entity could end up writing to: the source ids
    // themselves, anything a natural key matched, and the replacement id a
    // remap would allocate. Provenance is read for all of them in one batched
    // pass so identity can see a target that a previous migration already
    // claimed, rather than leaving the apply to hit the unique index.
    const candidateTargets = new Set(ids);
    for (const list of byNaturalKey.values()) for (const row of list) candidateTargets.add(row.id);
    for (const id of ids) if (byId.has(id)) candidateTargets.add(derivedTargetId(entity, id));
    const provenanceOwners = await loadProvenance(queryable, entity, [...candidateTargets]);

    const entityRemap = new Map();
    const entityIdentity = new Map();
    const entityExisting = new Map();
    const claimedTargetIds = new Set();
    const claimedTargetHasExactMatch = new Map();
    const allocatedIds = new Set();
    // Two source records folding to one natural key, where neither matched a
    // DashFlo record, are created side by side. Reported, never dropped.
    const naturalKeySeen = new Map();
    // field -> folded value -> { targetId, ambiguous }, one map per identity
    // field this entity supports (the primary NATURAL_KEYS field, plus any
    // LEGACY_IDENTITY_ALIASES). Built for every field regardless of whether
    // that field participates in collision detection, which uses the primary
    // field alone.
    const entityAliasByField = new Map();
    const aliasFields = identityAliasFields(entity);

    for (const { sourceId, record } of importable) {
      const naturalValue = naturalKeyValue(entity, record);
      const rowById = byId.get(sourceId) || null;
      const candidates = naturalValue != null ? (byNaturalKey.get(naturalValue) || []) : [];

      if (naturalValue != null) {
        const prior = naturalKeySeen.get(naturalValue);
        if (prior && prior !== sourceId && !candidates.length) {
          noteCollision({
            entity,
            source_id: sourceId,
            collision_type: COLLISION_TYPE.DUPLICATE_IN_PACKAGE,
            natural_key_field: naturalKeyField,
            existing_target_id: null,
            other_source_id: prior,
            severity: ISSUE_SEVERITY.WARNING,
            disposition: 'create under its own source id',
            detail: 'two records in this package share one natural key and neither matches a DashFlo record, so both are created',
          });
        } else if (!prior) {
          naturalKeySeen.set(naturalValue, sourceId);
        }
      }

      const decision = resolveIdentity({
        entity,
        sourceId,
        naturalValue,
        rowById,
        rowsByNaturalKey: candidates,
        claimedTargetIds,
        targetIdTaken: (id) => byId.has(id) || allocatedIds.has(id) || claimedTargetIds.has(id),
      });

      // A DashFlo record that a previous migration already recorded a different
      // origin for cannot be claimed again, whatever the natural key says.
      const priorOrigin = decision.targetId ? provenanceOwners.get(decision.targetId) : null;
      if (decision.targetId && priorOrigin && priorOrigin !== sourceId) {
        decision.targetId = null;
        decision.collision = {
          type: COLLISION_TYPE.TARGET_ALREADY_MIGRATED,
          existing_target_id: null,
          detail: 'that DashFlo record was already migrated from a different source record',
        };
      }

      // If a record loses a natural-key race to another record in the same package
      // but has no exact ID match of its own, check if the winner had an exact match.
      // If the winner had an exact match, exclude the loser (it's a duplicate).
      // If neither had an exact match, it's a genuine conflict that must block.
      if (!decision.targetId && decision.collision?.type === COLLISION_TYPE.DUPLICATE_IN_PACKAGE_CLAIMS_TARGET && !rowById) {
        const targetId = decision.collision.existing_target_id;
        const winnerHadExactMatch = claimedTargetHasExactMatch.get(targetId) === true;
        if (winnerHadExactMatch) {
          plan.excluded += 1;
          excludedRecordCount += 1;
          const bucket = exclusionCounts.get('duplicate_natural_key_loser') || { rule: { key: 'duplicate_natural_key_loser', entity, scope: 'record' }, count: 0, ids: [] };
          bucket.count += 1;
          if (bucket.ids.length < 20) bucket.ids.push(sourceId);
          exclusionCounts.set('duplicate_natural_key_loser', bucket);
          const set = excludedIds.get(entity) || new Set();
          set.add(sourceId);
          excludedIds.set(entity, set);
          continue;
        }
        // No winner with exact match: genuine conflict, let it fall through to blocker handling
      }

      if (!decision.targetId) {
        plan.unresolved += 1;
        unresolvedCount += 1;
        noteCollision({
          entity,
          source_id: sourceId,
          collision_type: decision.collision.type,
          natural_key_field: naturalKeyField,
          existing_target_id: decision.collision.existing_target_id
            || (decision.collision.existing_target_ids || []).join(', ')
            || null,
          severity: ISSUE_SEVERITY.BLOCKER,
          disposition: 'blocked',
          detail: decision.collision.detail,
        });
        pushSample(unresolved, {
          entity,
          source_id: sourceId,
          reason: decision.collision.detail,
          resolution: 'Owner decision required. Reconcile the duplicate in DashFlo or in the source system, then preview again.',
        });
        continue;
      }

      if (decision.collision) {
        const native = decision.existing ? !provenanceOwners.has(decision.existing.id) : false;
        noteCollision({
          entity,
          source_id: sourceId,
          collision_type: native ? COLLISION_TYPE.DASHFLO_NATIVE_PROTECTED : decision.collision.type,
          natural_key_field: decision.naturalKeyField || naturalKeyField,
          existing_target_id: decision.collision.existing_target_id || null,
          resolved_target_id: decision.targetId,
          severity: ISSUE_SEVERITY.RESOLVED,
          disposition: decision.matchedBy === 'natural_key' ? 'match the existing DashFlo record' : 'create under a new DashFlo id',
          detail: native
            ? `${decision.collision.detail}. That DashFlo record has no import provenance, so DashFlo created it and its protected fields are kept.`
            : decision.collision.detail,
        });
      }

      if (decision.existing) {
        claimedTargetIds.add(decision.existing.id);
        // Record whether this claimant had an exact ID match (sourceId === targetId).
        // This is used to resolve duplicate-in-package conflicts: a claimant with
        // an exact match beats one without.
        claimedTargetHasExactMatch.set(decision.existing.id, decision.matchedBy === 'source_id');
      }
      if (decision.matchedBy === 'allocated') allocatedIds.add(decision.targetId);
      if (decision.targetId !== sourceId) {
        entityRemap.set(sourceId, decision.targetId);
        plan.remapped += 1;
        remapCount += 1;
      }
      entityIdentity.set(sourceId, {
        targetId: decision.targetId,
        matchedBy: decision.matchedBy,
        naturalKeyField: decision.naturalKeyField || null,
        remapped: decision.targetId !== sourceId,
      });
      if (decision.existing) entityExisting.set(sourceId, decision.existing);

      // Each alias index is keyed by this record's OWN value in that field,
      // pointed at wherever it actually resolved. A value shared by two
      // records that resolved to different targets cannot alias either one,
      // for exactly the reason DUPLICATE_IN_PACKAGE_CLAIMS_TARGET fails closed
      // above: picking one would be a guess.
      for (const field of aliasFields) {
        const value = aliasFieldValue(entity, field, record);
        if (value == null) continue;
        const fieldIndex = entityAliasByField.get(field) || new Map();
        const priorAlias = fieldIndex.get(value);
        if (!priorAlias) fieldIndex.set(value, { targetId: decision.targetId, ambiguous: false });
        else if (!priorAlias.ambiguous && priorAlias.targetId !== decision.targetId) {
          fieldIndex.set(value, { targetId: null, ambiguous: true });
        }
        entityAliasByField.set(field, fieldIndex);
      }
    }

    if (entityRemap.size) remap.set(entity, entityRemap);
    identity.set(entity, entityIdentity);
    existingRows.set(entity, entityExisting);
    if (entityAliasByField.size) naturalKeyAlias.set(entity, entityAliasByField);
  }

  return {
    kind: normalized.kind,
    supportedNames,
    presentNames,
    orderedNames,
    remap,
    identity,
    existingRows,
    excludedIds,
    naturalKeyAlias,
    entityPlans,
    collisions,
    collisionCounts,
    unresolved,
    unresolvedCount,
    excludedRecordCount,
    remapCount,
    schemaIncompatibilities,
    duplicateIds,
    exclusions: [...exclusionCounts.values()].map(({ rule, count, ids }) => ({
      entity: rule.entity,
      scope: rule.scope,
      key: rule.key,
      count,
      reason: rule.reason,
      rule: rule.rule,
      sample_source_ids: ids,
    })),
  };
}

/* Legacy identity alias.
 *
 * A required reference can fail to resolve even when the record it means to
 * point at is right there in the plan, fully accounted for, because the value
 * in the field is not that record's id. `Lead.buyer_id` is the proven case:
 * across legacy imports and LeadByte feedback matching it carries a buyer
 * CODE, not the Buyer record id its schema description claims, and
 * `lib/buyerIdentity.js` exists specifically to resolve that, trying a
 * record id, then `buyer_code`, then `leadbyte_bid`, in that order, failing
 * closed the moment more than one candidate answers. REFS marks
 * `Lead.buyer_id` `kind: 'code'` for exactly this reason and it is never
 * touched here.
 *
 * There is one canonical declaration of what identifies a migratable entity,
 * and it lives in the catalog, not scattered across this file, the schema
 * files, or the UI: `NATURAL_KEYS` names the one field record identity and
 * collision detection trust, `LEGACY_IDENTITY_ALIASES` names what
 * relationship resolution may additionally try, in order, once an id match
 * has already failed, and `CASE_INSENSITIVE_NATURAL_KEYS` above says which of
 * those fold case. Every function below reads these three, never a fourth
 * per-field rule invented locally: `identityAliasFields` is the single place
 * that turns the first two into the ordered list every caller actually uses,
 * so adding a new legacy field for a new entity is one catalog line, not a
 * new conditional here.
 *
 * `lib/buyerIdentity.js` stays a second, deliberately separate
 * implementation rather than the thing this module calls, and that is a
 * decision, not an oversight. It resolves live Lead-to-Buyer attribution for
 * billing and reporting, where an unresolved lead becomes a reviewable
 * exception row and a name-based last resort is an acceptable, disclosed
 * fallback. A migration relationship is written into the database once,
 * silently, as part of an owner-authorised Apply; a wrong resolution there is
 * not a flagged exception; it can mean pricing configuration attached to the
 * wrong buyer. So this module deliberately supports less than
 * `buyerIdentity.js` does (record id and `buyer_code` and `leadbyte_bid`,
 * never a name) rather than reusing its `resolveBuyer` outright. Passing a
 * migration record through `resolveBuyer` would in fact never reach its name
 * branch on its own, since that branch only triggers when the id field is
 * itself empty; the two are kept apart anyway; both are subject to the same
 * standard, but the fact that they arrive at it independently is what makes
 * this module safe to reason about without also having to hold Lead
 * attribution's looser tolerances in mind.
 *
 * `identityAliasFields(entity)` is the same idea generalised to every
 * reference, not reinvented per field: the primary NATURAL_KEYS field first,
 * then whatever `LEGACY_IDENTITY_ALIASES` declares for that entity, tried in
 * order, each one checked fully (package, then DashFlo) before the next is
 * tried at all. A hit at any field resolves it. An ambiguous hit at any field
 * stops there: a lower-priority field is never consulted to break a tie a
 * higher-priority one could not.
 *
 * This is a fallback, tried only after the two id-based passes below have
 * already failed, so it can never override or compete with an id match. An
 * entity with no declared identity field at all (`RouteGroup`, `Delivery`)
 * gets no alias fallback, because there is no safe field to try, and none is
 * invented here: a genuinely unresolvable reference to one of those stays an
 * honest blocker for the owner.
 */

// One field's verdict for one value, checked against a single index (either
// the in-memory package alias index, or a DashFlo batch result already keyed
// by folded value). 'none' means try the next field; the caller must not
// retry this field.
function aliasVerdict(index, foldedValue) {
  const hit = index?.get(foldedValue);
  if (hit == null) return { verdict: 'none' };
  if (Array.isArray(hit)) {
    // A DashFlo batch result: an array of matching rows.
    if (hit.length === 1) return { verdict: 'resolved', targetId: hit[0].id };
    if (hit.length > 1) return { verdict: 'ambiguous', count: hit.length };
    return { verdict: 'none' };
  }
  if (hit.ambiguous) return { verdict: 'ambiguous' };
  return { verdict: 'resolved', targetId: hit.targetId };
}

/* Phase 7. Resolve every declared reference against the finished remap.
 *
 * Issues are grouped by (entity, field, referenced entity, referenced id) with a
 * true record count, because one missing parent referenced by forty thousand
 * children is one problem, not forty thousand.
 *
 * Severity is read from the DashFlo schema rather than chosen by hand. A
 * reference the schema marks required is structural: the record does not mean
 * anything without it, so an unresolvable one is a blocker. An optional
 * reference that resolves nowhere is a dangling pointer the source system
 * already had, and the honest disposition is to carry it across unchanged and
 * say so. Blanking it would be data loss and dropping the record would be
 * worse; neither is done.
 */
export async function planRelationships(normalized, plan, queryable = pool) {
  const unresolvedByTarget = new Map();
  const issues = new Map();
  const aliasResolutions = new Map();
  // entity -> identity field -> folded value -> target id, for every value
  // that resolved through the alias fallback rather than as a record id,
  // package or DashFlo. Consulted by rewriteReferences so the write path
  // stores the resolved id, not the raw legacy value the record arrived
  // with. Seeded from the package-side index planIdentity already built,
  // since every non-ambiguous entry there is by construction a resolved
  // alias target.
  const aliasTargets = new Map();
  for (const [entity, byField] of plan.naturalKeyAlias) {
    const perField = new Map();
    for (const [field, index] of byField) {
      const resolved = new Map();
      for (const [value, hit] of index) if (!hit.ambiguous) resolved.set(value, hit.targetId);
      if (resolved.size) perField.set(field, resolved);
    }
    if (perField.size) aliasTargets.set(entity, perField);
  }
  const resolvedCounts = {
    [RELATIONSHIP_STATUS.RESOLVED_IN_PACKAGE]: 0,
    [RELATIONSHIP_STATUS.RESOLVED_BY_REMAP]: 0,
    [RELATIONSHIP_STATUS.RESOLVED_IN_TARGET]: 0,
    [RELATIONSHIP_STATUS.RESOLVED_BY_NATURAL_KEY_ALIAS]: 0,
  };

  const record = (entity, sourceId, field, ref, referencedId, status) => {
    const key = `${entity}|${field}|${ref.target}|${referencedId}`;
    const found = issues.get(key);
    if (found) {
      found.record_count += 1;
      if (found.sample_source_ids.length < 5) found.sample_source_ids.push(sourceId);
      return found;
    }
    const entry = {
      entity,
      field,
      referenced_entity: ref.target,
      referenced_source_id: referencedId,
      status,
      record_count: 1,
      sample_source_ids: [sourceId],
      required: requiredFields(entity).has(field),
      // Every identity field this unresolved reference's target entity
      // supports, and what happened when each was tried: 'no_match' or
      // 'ambiguous', and where it was checked. Populated as fields are tried
      // below; stays empty for an entity with no identity field at all,
      // which is itself the answer for why nothing could be attempted.
      identity_attempts: [],
    };
    issues.set(key, entry);
    return entry;
  };

  const recordAlias = (entity, sourceId, field, ref, referencedId, targetId, aliasField, via) => {
    const key = `${entity}|${field}|${ref.target}|${referencedId}`;
    const found = aliasResolutions.get(key);
    if (found) {
      found.record_count += 1;
      if (found.sample_source_ids.length < 5) found.sample_source_ids.push(sourceId);
      return;
    }
    aliasResolutions.set(key, {
      entity,
      field,
      referenced_entity: ref.target,
      referenced_value: referencedId,
      resolved_target_id: targetId,
      natural_key_field: aliasField,
      via,
      record_count: 1,
      sample_source_ids: [sourceId],
    });
  };

  // Every reference whose target entity has at least one identity field, but
  // whose value did not resolve against the package under any of them. Kept
  // as { entity: entry } pairs so pass three can retry field by field without
  // re-deriving which references are even eligible.
  const aliasCandidates = [];

  // Pass one: resolve against the package and the remap; failing that, against
  // this package's own identity alias fields, in priority order; and collect
  // whatever is left for a single batched lookup against DashFlo.
  for (const entity of plan.orderedNames) {
    const refs = REFS[entity];
    if (!refs || !entityExists(entity)) continue;
    const identity = plan.identity.get(entity);
    if (!identity) continue;

    for (const source of normalized.entities[entity] || []) {
      const sourceId = String(source?.id || '').trim();
      if (!identity.has(sourceId)) continue;

      for (const [field, ref] of Object.entries(refs)) {
        if (ref.kind !== 'id' && ref.kind !== 'idsJson') continue;
        for (const referencedId of referenceIds(source[field], ref.kind)) {
          if (!entityExists(ref.target)) {
            record(entity, sourceId, field, ref, referencedId, RELATIONSHIP_STATUS.REFERENCED_ENTITY_UNSUPPORTED);
            continue;
          }
          const targetIdentity = plan.identity.get(ref.target);
          const resolved = targetIdentity?.get(referencedId);
          if (resolved) {
            resolvedCounts[resolved.remapped
              ? RELATIONSHIP_STATUS.RESOLVED_BY_REMAP
              : RELATIONSHIP_STATUS.RESOLVED_IN_PACKAGE] += 1;
            continue;
          }
          if (plan.excludedIds.get(ref.target)?.has(referencedId)) {
            record(entity, sourceId, field, ref, referencedId, RELATIONSHIP_STATUS.REFERENCED_RECORD_EXCLUDED);
            continue;
          }

          const fields = identityAliasFields(ref.target);
          let decided = false;
          const entry = record(entity, sourceId, field, ref, referencedId, RELATIONSHIP_STATUS.REFERENCED_RECORD_ABSENT);
          for (const aliasField of fields) {
            const folded = naturalKeyFolder(ref.target, aliasField)(String(referencedId));
            const verdict = aliasVerdict(plan.naturalKeyAlias.get(ref.target)?.get(aliasField), folded);
            if (verdict.verdict === 'resolved') {
              resolvedCounts[RELATIONSHIP_STATUS.RESOLVED_BY_NATURAL_KEY_ALIAS] += 1;
              recordAlias(entity, sourceId, field, ref, referencedId, verdict.targetId, aliasField, 'package');
              issues.delete(`${entity}|${field}|${ref.target}|${referencedId}`);
              decided = true;
              break;
            }
            if (verdict.verdict === 'ambiguous') {
              entry.identity_attempts.push({ field: aliasField, checked_in: 'package', result: 'ambiguous' });
              entry.status = RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS;
              decided = true;
              break;
            }
            entry.identity_attempts.push({ field: aliasField, checked_in: 'package', result: 'no_match' });
          }
          if (decided) continue;

          // record() dedups by (entity, field, target, referencedId), so
          // repeat source records sharing that exact key return the same
          // entry object every time and must queue it for the fallback
          // passes only once, or its already-accumulated record_count is
          // processed more than once and the resolved counts below inflate.
          // A different (entity, field) pair CAN legitimately share the same
          // referencedId (two distinct fields both pointing at "C1", say),
          // and that is a second, separate entry that still needs its own
          // resolution, so the set below is keyed by object identity rather
          // than collapsed to one entry per value.
          const set = unresolvedByTarget.get(ref.target) || new Map();
          const entries = set.get(referencedId) || new Set();
          const firstOccurrence = !entries.has(entry);
          entries.add(entry);
          set.set(referencedId, entries);
          unresolvedByTarget.set(ref.target, set);
          if (firstOccurrence && fields.length) aliasCandidates.push({ target: ref.target, entry });
        }
      }
    }
  }

  // Pass two: anything the package could not answer might already be in
  // DashFlo, which is a legitimate resolution.
  for (const [target, byId] of unresolvedByTarget) {
    const found = await loadRowsByIds(queryable, target, [...byId.keys()]);
    for (const [referencedId, entries] of byId) {
      if (!found.has(referencedId)) continue;
      for (const entry of entries) {
        entry.status = RELATIONSHIP_STATUS.RESOLVED_IN_TARGET;
        resolvedCounts[RELATIONSHIP_STATUS.RESOLVED_IN_TARGET] += entry.record_count;
        issues.delete(`${entry.entity}|${entry.field}|${entry.referenced_entity}|${referencedId}`);
      }
    }
  }

  // Pass three: whatever is still unresolved and points at an entity with an
  // identity field gets one batched DashFlo try per field, in the same
  // priority order pass one already tried against the package. A field is
  // fully exhausted, for every value that still needs it, before the next
  // field is tried at all: this is what keeps the priority the same on both
  // sides rather than only inside the package.
  const byTarget = new Map();
  for (const { target, entry } of aliasCandidates) {
    const list = byTarget.get(target) || [];
    list.push(entry);
    byTarget.set(target, list);
  }
  for (const [target, entries] of byTarget) {
    for (const aliasField of identityAliasFields(target)) {
      const stillOpen = entries.filter((entry) => (
        issues.get(`${entry.entity}|${entry.field}|${target}|${entry.referenced_source_id}`) === entry
      ));
      if (!stillOpen.length) continue;

      const foldedValues = [...new Set(stillOpen.map((entry) => naturalKeyFolder(target, aliasField)(String(entry.referenced_source_id))))];
      const matches = await loadRowsByNaturalKey(queryable, target, aliasField, foldedValues);

      for (const entry of stillOpen) {
        const key = `${entry.entity}|${entry.field}|${target}|${entry.referenced_source_id}`;
        const foldedValue = naturalKeyFolder(target, aliasField)(String(entry.referenced_source_id));
        const verdict = aliasVerdict(matches, foldedValue);
        if (verdict.verdict === 'resolved') {
          issues.delete(key);
          resolvedCounts[RELATIONSHIP_STATUS.RESOLVED_BY_NATURAL_KEY_ALIAS] += entry.record_count;
          aliasResolutions.set(key, {
            entity: entry.entity,
            field: entry.field,
            referenced_entity: target,
            referenced_value: entry.referenced_source_id,
            resolved_target_id: verdict.targetId,
            natural_key_field: aliasField,
            via: 'dashflo',
            record_count: entry.record_count,
            sample_source_ids: entry.sample_source_ids,
          });
          const perEntity = aliasTargets.get(target) || new Map();
          const perField = perEntity.get(aliasField) || new Map();
          perField.set(foldedValue, verdict.targetId);
          perEntity.set(aliasField, perField);
          aliasTargets.set(target, perEntity);
        } else if (verdict.verdict === 'ambiguous') {
          entry.identity_attempts.push({ field: aliasField, checked_in: 'dashflo', result: 'ambiguous', candidate_count: verdict.count });
          entry.status = RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS;
        } else {
          entry.identity_attempts.push({ field: aliasField, checked_in: 'dashflo', result: 'no_match' });
        }
      }
    }
  }

  const list = [...issues.values()].map((entry) => ({
    ...entry,
    severity: entry.required ? ISSUE_SEVERITY.BLOCKER : ISSUE_SEVERITY.WARNING,
    reason: describeRelationship(entry),
    resolution: entry.required
      ? 'Owner decision required. The DashFlo schema requires this field, so the referenced record has to exist before the package can be applied.'
      : 'Carried across unchanged. The field is optional in the DashFlo schema and the source system already held a reference that resolves nowhere.',
  }));

  list.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === ISSUE_SEVERITY.BLOCKER ? -1 : 1;
    return b.record_count - a.record_count;
  });

  return {
    issues: list,
    resolved: resolvedCounts,
    blockers: list.filter((entry) => entry.severity === ISSUE_SEVERITY.BLOCKER),
    aliasResolutions: [...aliasResolutions.values()],
    aliasTargets,
  };
}

function describeRelationship(entry) {
  if (entry.status === RELATIONSHIP_STATUS.REFERENCED_ENTITY_UNSUPPORTED) {
    return `${entry.referenced_entity} is not supported by this DashFlo schema`;
  }
  if (entry.status === RELATIONSHIP_STATUS.REFERENCED_RECORD_EXCLUDED) {
    return `the referenced ${entry.referenced_entity} record is excluded from the migration by an explicit rule`;
  }
  const attempts = entry.identity_attempts || [];
  if (entry.status === RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS) {
    const ambiguous = attempts.find((a) => a.result === 'ambiguous');
    const field = ambiguous?.field || NATURAL_KEYS[entry.referenced_entity];
    const where = ambiguous?.checked_in === 'dashflo' ? 'in DashFlo' : 'in this package';
    const count = ambiguous?.candidate_count ? `${ambiguous.candidate_count} ${entry.referenced_entity} records` : `more than one ${entry.referenced_entity} record`;
    return `this value is not a ${entry.referenced_entity} id, and ${count} ${where} share it as ${entry.referenced_entity}.${field}`;
  }
  if (attempts.length) {
    // Every declared identity field was tried, in the package and in
    // DashFlo, and none of them named this value. This is what makes an
    // "absent" verdict provable rather than merely "the resolver gave up":
    // the fields tried are named, not just counted.
    const fieldList = [...new Set(attempts.map((a) => a.field))];
    return `the referenced ${entry.referenced_entity} record is in neither the package nor DashFlo, and this value did not match any ${entry.referenced_entity} record by ${fieldList.map((f) => `${entry.referenced_entity}.${f}`).join(' or ')} either`;
  }
  return `the referenced ${entry.referenced_entity} record is in neither the package nor DashFlo, and ${entry.referenced_entity} declares no natural key or legacy identity field to try instead`;
}

export default {
  RECORD_DISPOSITION,
  COLLISION_TYPE,
  RELATIONSHIP_STATUS,
  ISSUE_SEVERITY,
  derivedTargetId,
  entityClass,
  identityAliasFields,
  planIdentity,
  planRelationships,
  resolveIdentity,
  rewriteReferences,
  referenceIds,
  recordExclusionRule,
};
