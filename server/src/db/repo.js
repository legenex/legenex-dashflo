import crypto from 'node:crypto';
import { pool } from './pool.js';
import { getSchema, tableName, entityNames } from '../schemas/index.js';

const META_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by']);

// Generate a 24-char hex id (Mongo ObjectId-like) to match what the app expects.
export function newId() {
  return crypto.randomBytes(12).toString('hex');
}

// Merge stored row -> flat record: { id, created_date, updated_date, created_by, ...data }
function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_date: row.created_date instanceof Date ? row.created_date.toISOString() : row.created_date,
    updated_date: row.updated_date instanceof Date ? row.updated_date.toISOString() : row.updated_date,
    created_by: row.created_by ?? null,
    ...(row.data || {}),
  };
}

// Split an incoming record into meta columns + data blob.
function splitRecord(record) {
  const data = {};
  const meta = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (META_FIELDS.has(k)) meta[k] = v;
    else data[k] = v;
  }
  return { meta, data };
}

// Apply schema defaults for any missing properties.
function applyDefaults(name, data) {
  const schema = getSchema(name);
  if (!schema?.properties) return data;
  const out = { ...data };
  for (const [key, def] of Object.entries(schema.properties)) {
    if (out[key] === undefined && def && 'default' in def) out[key] = def.default;
  }
  return out;
}

// ── Filter translation ──────────────────────────────────────────────────────
// Supports the subset the app/functions use:
//   { field: value }                       equality
//   { field: { $in: [...] } }              membership
//   { field: { $ne, $gt, $gte, $lt, $lte } } comparisons
// Meta fields (id/created_date/updated_date/created_by) map to real columns;
// everything else maps to the JSONB data blob.
function buildWhere(query, params) {
  const clauses = [];
  const add = (sql) => clauses.push(sql);

  for (const [field, cond] of Object.entries(query || {})) {
    const isMeta = META_FIELDS.has(field);
    const col = isMeta ? field : null;
    const jsonPath = isMeta ? null : field;

    const ref = (castNumeric) => {
      if (isMeta) return col;
      return castNumeric ? `(data->>'${jsonPath}')` : `data->>'${jsonPath}'`;
    };

    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, val] of Object.entries(cond)) {
        switch (op) {
          case '$in': {
            if (isMeta) {
              params.push(val);
              add(`${col} = ANY($${params.length})`);
            } else {
              params.push((val || []).map((x) => (x == null ? x : String(x))));
              add(`data->>'${jsonPath}' = ANY($${params.length})`);
            }
            break;
          }
          case '$nin': {
            params.push((val || []).map((x) => (x == null ? x : String(x))));
            add(`(data->>'${jsonPath}' <> ALL($${params.length}) OR data->>'${jsonPath}' IS NULL)`);
            break;
          }
          case '$ne':
            params.push(val == null ? null : isMeta ? val : String(val));
            add(`${ref(false)} IS DISTINCT FROM $${params.length}`);
            break;
          case '$gt': case '$gte': case '$lt': case '$lte': {
            const sym = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
            const numeric = typeof val === 'number';
            params.push(val);
            if (isMeta) add(`${col} ${sym} $${params.length}`);
            else if (numeric) add(`(data->>'${jsonPath}')::numeric ${sym} $${params.length}`);
            else add(`data->>'${jsonPath}' ${sym} $${params.length}`);
            break;
          }
          case '$exists':
            add(val ? `data ? '${jsonPath}'` : `NOT (data ? '${jsonPath}')`);
            break;
          case '$regex': {
            params.push(val);
            const flags = cond.$options?.includes('i') ? '~*' : '~';
            add(`${ref(false)} ${flags} $${params.length}`);
            break;
          }
          case '$options':
            break;
          default:
            // Unknown operator: treat the object as a literal equality on JSON.
            params.push(JSON.stringify(cond));
            add(`data->'${jsonPath}' = $${params.length}::jsonb`);
            break;
        }
      }
    } else if (cond === null) {
      if (isMeta) add(`${col} IS NULL`);
      else add(`(NOT (data ? '${jsonPath}') OR data->>'${jsonPath}' IS NULL)`);
    } else if (typeof cond === 'boolean') {
      params.push(cond);
      add(`(data->'${jsonPath}')::boolean = $${params.length}`);
    } else {
      params.push(isMeta ? cond : String(cond));
      add(`${ref(false)} = $${params.length}`);
    }
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

// Parse a sort spec: "-created_date" (desc) or "field" (asc). Meta -> column,
// otherwise sort on the data field (numeric-aware for known number fields).
function buildOrderBy(name, sort) {
  if (!sort) return 'ORDER BY created_date DESC';
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  const dir = desc ? 'DESC' : 'ASC';
  if (META_FIELDS.has(field)) return `ORDER BY ${field} ${dir}`;
  const schema = getSchema(name);
  const type = schema?.properties?.[field]?.type;
  if (type === 'number') return `ORDER BY (data->>'${field}')::numeric ${dir} NULLS LAST`;
  return `ORDER BY data->>'${field}' ${dir} NULLS LAST`;
}

export function entityExists(name) {
  return entityNames.includes(name);
}

export class Repo {
  constructor(name) {
    if (!entityExists(name)) throw new Error(`Unknown entity: ${name}`);
    this.name = name;
    this.table = tableName(name);
  }

  async list(sort = '-created_date', limit = 100, offset = 0) {
    const order = buildOrderBy(this.name, sort);
    const params = [];
    let sql = `SELECT * FROM ${this.table} ${order}`;
    if (limit != null) { params.push(limit); sql += ` LIMIT $${params.length}`; }
    if (offset) { params.push(offset); sql += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    return rows.map(rowToRecord);
  }

  async filter(query = {}, sort = '-created_date', limit = null, offset = 0) {
    const params = [];
    const where = buildWhere(query, params);
    const order = buildOrderBy(this.name, sort);
    let sql = `SELECT * FROM ${this.table} ${where} ${order}`;
    if (limit != null) { params.push(limit); sql += ` LIMIT $${params.length}`; }
    if (offset) { params.push(offset); sql += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    return rows.map(rowToRecord);
  }

  async get(id) {
    const { rows } = await pool.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return rowToRecord(rows[0]);
  }

  async count(query = {}) {
    const params = [];
    const where = buildWhere(query, params);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${this.table} ${where}`, params);
    return rows[0].n;
  }

  async create(record, actor = null) {
    const { meta, data } = splitRecord(record);
    const id = meta.id || newId();
    const withDefaults = applyDefaults(this.name, data);
    const { rows } = await pool.query(
      `INSERT INTO ${this.table} (id, data, created_by, created_date, updated_date)
       VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), now())
       RETURNING *`,
      [id, JSON.stringify(withDefaults), meta.created_by ?? actor ?? null, meta.created_date || null]
    );
    return rowToRecord(rows[0]);
  }

  async bulkCreate(records = [], actor = null) {
    const out = [];
    for (const r of records) out.push(await this.create(r, actor));
    return out;
  }

  // Partial update: merge provided fields into the data blob (or meta cols).
  async update(id, patch) {
    const { meta, data } = splitRecord(patch);
    const sets = ['updated_date = now()'];
    const params = [id];
    if (Object.keys(data).length) {
      params.push(JSON.stringify(data));
      sets.push(`data = data || $${params.length}::jsonb`);
    }
    if ('created_by' in meta) { params.push(meta.created_by); sets.push(`created_by = $${params.length}`); }
    const { rows } = await pool.query(
      `UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return rowToRecord(rows[0]);
  }

  async bulkUpdate(updates = []) {
    const out = [];
    for (const u of updates) out.push(await this.update(u.id, u));
    return out;
  }

  async delete(id) {
    await pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return { success: true };
  }

  async deleteMany(query = {}) {
    const params = [];
    const where = buildWhere(query, params);
    const { rowCount } = await pool.query(`DELETE FROM ${this.table} ${where}`, params);
    return { deleted: rowCount };
  }

  // Mongo-style conditional update used by counter/optimistic-lock code:
  //   updateMany({ name, value }, { $set: { value, updated_at } })
  // Returns { updated } — the number of rows matched+written.
  async updateMany(query = {}, update = {}) {
    const set = update.$set || update;
    const params = [];
    const where = buildWhere(query, params);
    // Only data-field $set supported here (that's all the app uses).
    params.push(JSON.stringify(set));
    const setIdx = params.length;
    const { rowCount } = await pool.query(
      `UPDATE ${this.table} SET data = data || $${setIdx}::jsonb, updated_date = now() ${where}`,
      params
    );
    return { updated: rowCount };
  }
}

const cache = new Map();
export function repo(name) {
  if (!cache.has(name)) cache.set(name, new Repo(name));
  return cache.get(name);
}

// A namespace object shaped like `db.entities.<Name>.method()` for ported
// backend functions and the server-side client.
export function entitiesNamespace() {
  const ns = {};
  for (const name of entityNames) {
    Object.defineProperty(ns, name, {
      enumerable: true,
      get() { return repo(name); },
    });
  }
  return ns;
}

export default repo;
