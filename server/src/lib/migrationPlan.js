import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { tableName, getSchema } from '../schemas/index.js';
import { entityExists } from '../db/repo.js';
import {
  ALL_ENTITIES,
  ENTITY_ORDER,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_EXCLUSION_RULES,
  NATURAL_KEYS,
  REFS,
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

function requiredFields(entity) {
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

// Existing rows keyed by their folded natural key value. A key answered by more
// than one row is recorded as a list so identity can fail closed rather than
// pick the first one the database happened to return. Exported: the
// relationship resolver reuses this exact query to try a reference value as a
// natural key of the target entity, rather than inventing a second way to ask
// the same question.
export async function loadRowsByNaturalKey(queryable, entity, values) {
  const out = new Map();
  const field = NATURAL_KEYS[entity];
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
  // database. `entity -> foldedValue -> targetId`, produced by
  // planRelationships from both the package's own natural keys and DashFlo's.
  const aliasFor = (target, rawValue) => {
    const naturalKeyField = NATURAL_KEYS[target];
    if (!naturalKeyField) return null;
    const index = aliasTargets?.get(target);
    if (!index || !index.size) return null;
    return index.get(naturalKeyFolder(target, naturalKeyField)(String(rawValue))) || null;
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
  // Entity -> folded natural key value -> { targetId, ambiguous }. A byproduct
  // of identity resolution, not a second pass over the data: every value here
  // is the natural key this entity's own records already carry, pointed at
  // whatever target those records actually resolved to. Consulted by
  // planRelationships as a fallback when a reference field's raw value is not
  // a record id anyone recognises. See "Legacy identity alias" there.
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

    const naturalKeyField = NATURAL_KEYS[entity] || null;
    let byNaturalKey = new Map();
    if (naturalKeyField) {
      const values = [...new Set(importable.map((item) => naturalKeyValue(entity, item.record)).filter((v) => v != null))];
      byNaturalKey = await loadRowsByNaturalKey(queryable, entity, values);
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
    const allocatedIds = new Set();
    // Two source records folding to one natural key, where neither matched a
    // DashFlo record, are created side by side. Reported, never dropped.
    const naturalKeySeen = new Map();
    const entityAlias = new Map();

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

      if (decision.existing) claimedTargetIds.add(decision.existing.id);
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

      // The alias index is keyed by this record's OWN natural key value,
      // pointed at wherever it actually resolved. A value shared by two
      // records that resolved to different targets cannot alias either one,
      // for exactly the reason DUPLICATE_IN_PACKAGE_CLAIMS_TARGET fails closed
      // above: picking one would be a guess.
      if (naturalValue != null) {
        const priorAlias = entityAlias.get(naturalValue);
        if (!priorAlias) entityAlias.set(naturalValue, { targetId: decision.targetId, ambiguous: false });
        else if (!priorAlias.ambiguous && priorAlias.targetId !== decision.targetId) {
          entityAlias.set(naturalValue, { targetId: null, ambiguous: true });
        }
      }
    }

    if (entityRemap.size) remap.set(entity, entityRemap);
    identity.set(entity, entityIdentity);
    existingRows.set(entity, entityExisting);
    if (entityAlias.size) naturalKeyAlias.set(entity, entityAlias);
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
 * `lib/buyerIdentity.js` exists specifically to resolve that. REFS marks
 * `Lead.buyer_id` `kind: 'code'` for exactly this reason and it is never
 * touched here. But several other reference fields are literally named after
 * the target's own natural key rather than after "id"
 * (`RouteGroup.campaign_id`, `ContractVersion.campaign_id`,
 * `BuyerCplRule.campaign_id`, `LeadSource.campaign_id` all share a name with
 * `NATURAL_KEYS.Campaign`), which is exactly the shape of naming that produced
 * the proven Lead case. Whether that pattern repeats in a specific field is
 * not something to guess per field; the resolver instead tries the one
 * question that answers it for every field at once: does this unresolved
 * value match the target entity's declared natural key, exactly once.
 *
 * This is a fallback, tried only after `resolveAliasCandidate` and the two
 * id-based passes below have already failed, so it can never override or
 * compete with an id match. It reuses the exact same natural key already
 * trusted for record identity, so it invents nothing: `NATURAL_KEYS`, the same
 * case folding rules, and the same "more than one candidate fails closed"
 * policy that governs an ordinary collision. An entity with no declared
 * natural key (`RouteGroup`, `Delivery`) gets no alias fallback, because there
 * is no safe field to try, and none is invented here: a genuinely unresolvable
 * reference to one of those stays an honest blocker for the owner.
 */
function resolveAliasCandidate(aliasIndex, foldedValue) {
  const hit = aliasIndex?.get(foldedValue);
  if (!hit) return { found: false };
  if (hit.ambiguous) return { found: true, ambiguous: true };
  return { found: true, ambiguous: false, targetId: hit.targetId };
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
  // entity -> folded natural key value -> target id, for every value that
  // resolved through the alias fallback rather than as a record id, package or
  // DashFlo. Consulted by rewriteReferences so the write path stores the
  // resolved id, not the raw legacy value the record arrived with. Seeded from
  // the package-side index planIdentity already built, since every
  // non-ambiguous entry there is by construction a resolved alias target.
  const aliasTargets = new Map();
  for (const [entity, index] of plan.naturalKeyAlias) {
    const resolved = new Map();
    for (const [value, hit] of index) if (!hit.ambiguous) resolved.set(value, hit.targetId);
    if (resolved.size) aliasTargets.set(entity, resolved);
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
    };
    issues.set(key, entry);
    return entry;
  };

  const recordAlias = (entity, sourceId, field, ref, referencedId, targetId, via) => {
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
      natural_key_field: NATURAL_KEYS[ref.target],
      via,
      record_count: 1,
      sample_source_ids: [sourceId],
    });
  };

  // Values that need a DashFlo-side natural key lookup: the package alias
  // index had no answer, so the last question left is whether DashFlo already
  // holds a record whose natural key equals this value.
  const aliasCandidatesByTarget = new Map();

  // Pass one: resolve against the package and the remap; failing that, against
  // this package's own natural key alias index; and collect whatever is left
  // for a single batched lookup against DashFlo.
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

          const naturalKeyField = NATURAL_KEYS[ref.target];
          if (naturalKeyField) {
            const folded = naturalKeyFolder(ref.target, naturalKeyField)(String(referencedId));
            const candidate = resolveAliasCandidate(plan.naturalKeyAlias.get(ref.target), folded);
            if (candidate.found && !candidate.ambiguous) {
              resolvedCounts[RELATIONSHIP_STATUS.RESOLVED_BY_NATURAL_KEY_ALIAS] += 1;
              recordAlias(entity, sourceId, field, ref, referencedId, candidate.targetId, 'package');
              continue;
            }
            if (candidate.found && candidate.ambiguous) {
              // The package itself cannot decide this one; DashFlo cannot
              // either, since the ambiguity is among source records, not
              // against a single DashFlo answer. Fail closed here rather than
              // querying for a tiebreaker that does not exist.
              record(entity, sourceId, field, ref, referencedId, RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS);
              continue;
            }
          }

          const entry = record(entity, sourceId, field, ref, referencedId, RELATIONSHIP_STATUS.REFERENCED_RECORD_ABSENT);
          const set = unresolvedByTarget.get(ref.target) || new Map();
          const list = set.get(referencedId) || [];
          list.push(entry);
          set.set(referencedId, list);
          unresolvedByTarget.set(ref.target, set);

          // One issue key can only ever fold to one natural key value (it is
          // the same referencedId every time), so a plain overwrite here is
          // exactly the right dedup: this runs once per distinct issue key
          // regardless of how many source records share it.
          if (naturalKeyField) {
            const byValue = aliasCandidatesByTarget.get(ref.target) || new Map();
            const folded = naturalKeyFolder(ref.target, naturalKeyField)(String(referencedId));
            byValue.set(folded, entry);
            aliasCandidatesByTarget.set(ref.target, byValue);
          }
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

  // Pass three: whatever is still unresolved and points at a natural-keyed
  // entity gets one batched try against DashFlo's own natural key index. Only
  // reached for values pass one could not already answer from the package, so
  // this never second-guesses a package-level resolution or ambiguity, and
  // never runs for an entry pass two already closed.
  for (const [target, byValue] of aliasCandidatesByTarget) {
    const stillOpen = [...byValue.entries()].filter(([, entry]) => (
      issues.get(`${entry.entity}|${entry.field}|${target}|${entry.referenced_source_id}`) === entry
    ));
    if (!stillOpen.length) continue;

    const matches = await loadRowsByNaturalKey(queryable, target, stillOpen.map(([value]) => value));
    for (const [foldedValue, entry] of stillOpen) {
      const candidates = matches.get(foldedValue) || [];
      const key = `${entry.entity}|${entry.field}|${target}|${entry.referenced_source_id}`;
      if (candidates.length === 1) {
        issues.delete(key);
        resolvedCounts[RELATIONSHIP_STATUS.RESOLVED_BY_NATURAL_KEY_ALIAS] += entry.record_count;
        // Set directly with the entry's own true count and samples rather than
        // replaying recordAlias once per sample: the count pass one already
        // measured is the real one, and re-deriving it from a bounded sample
        // list would under-report it.
        aliasResolutions.set(key, {
          entity: entry.entity,
          field: entry.field,
          referenced_entity: target,
          referenced_value: entry.referenced_source_id,
          resolved_target_id: candidates[0].id,
          natural_key_field: NATURAL_KEYS[target],
          via: 'dashflo',
          record_count: entry.record_count,
          sample_source_ids: entry.sample_source_ids,
        });
        const targetAliasIndex = aliasTargets.get(target) || new Map();
        targetAliasIndex.set(foldedValue, candidates[0].id);
        aliasTargets.set(target, targetAliasIndex);
      } else if (candidates.length > 1) {
        entry.status = RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS;
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
  if (entry.status === RELATIONSHIP_STATUS.REFERENCED_RECORD_AMBIGUOUS_ALIAS) {
    const field = NATURAL_KEYS[entry.referenced_entity];
    return `this value is not a ${entry.referenced_entity} id, and more than one ${entry.referenced_entity} record shares it as ${entry.referenced_entity}.${field}`;
  }
  return `the referenced ${entry.referenced_entity} record is in neither the package nor DashFlo`;
}

export default {
  RECORD_DISPOSITION,
  COLLISION_TYPE,
  RELATIONSHIP_STATUS,
  ISSUE_SEVERITY,
  derivedTargetId,
  planIdentity,
  planRelationships,
  resolveIdentity,
  rewriteReferences,
  referenceIds,
  recordExclusionRule,
};
