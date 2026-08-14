// Read-only migration source. Streams entity records out to a backup mirror
// app so it can stay 1:1 with this app. Guarded by a shared secret. This
// function never writes anything.
//
// Ops (POST JSON):
//   { secret, op: 'ping' }
//   { secret, op: 'count',  entity }
//   { secret, op: 'read',   entity, skip, limit, fields? }
//   { secret, op: 'filter', entity, query, skip, limit, fields? }
//   { secret, op: 'ids',    entity, skip, limit }   -> [{ id, updated_date }]

import crypto from 'node:crypto';

// The shared secret comes from the environment and has no default. A secret
// committed to the repository is public, and this endpoint can read every
// entity in the database, so an absent secret disables the endpoint entirely
// rather than falling back to a known value.
//
// The previously committed literal must be treated as compromised and rotated.
// See STATE.md, Gate B rotation list.
const SECRET = process.env.MIGRATE_SOURCE_SECRET || '';

// Constant-time comparison so a caller cannot recover the secret by measuring
// how long a rejection takes.
function secretMatches(provided) {
  if (!SECRET) return false;
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The entity API here exposes list(sort, limit) / filter(query, sort, limit)
// with no native offset or projection, so emulate the original skip+fields
// paging by over-fetching skip+limit rows, slicing the window, and projecting
// the requested fields in memory.
function projectFields(row, fields) {
  if (!fields || !Array.isArray(fields) || fields.length === 0) return row;
  const out = {};
  for (const f of fields) {
    if (row && Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
  }
  return out;
}

async function listPage(ent, sort, limit, skip, fields) {
  const rows = await ent.list(sort, skip + limit);
  const page = (rows || []).slice(skip, skip + limit);
  return fields ? page.map((r) => projectFields(r, fields)) : page;
}

async function filterPage(ent, query, sort, limit, skip, fields) {
  const rows = await ent.filter(query, sort, skip + limit);
  const page = (rows || []).slice(skip, skip + limit);
  return fields ? page.map((r) => projectFields(r, fields)) : page;
}

export default async function migrateSource(ctx) {
  try {
    if (ctx.req.method !== 'POST') return ctx.json({ error: 'POST only' }, 405);

    const body = ctx.body || {};
    if (!secretMatches(body.secret)) return ctx.json({ error: 'Forbidden' }, 403);

    const db = ctx.db;

    if (body.op === 'ping') return ctx.json({ ok: true });

    const ent = body.entity ? db.entities[body.entity] : null;
    if (!ent) return ctx.json({ error: `Unknown entity: ${body.entity}` }, 400);

    const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 500);
    const skip = Math.max(Number(body.skip) || 0, 0);

    if (body.op === 'count') {
      let total = 0;
      let s = 0;
      for (let i = 0; i < 1000; i++) {
        const page = await listPage(ent, 'created_date', 500, s, ['id']);
        if (!page || page.length === 0) break;
        total += page.length;
        if (page.length < 500) break;
        s += 500;
      }
      return ctx.json({ entity: body.entity, count: total });
    }

    if (body.op === 'read') {
      const rows = await listPage(ent, 'created_date', limit, skip, body.fields || undefined);
      return ctx.json({ entity: body.entity, skip, limit, rows: rows || [] });
    }

    if (body.op === 'ids') {
      const rows = await listPage(ent, 'created_date', limit, skip, ['id', 'updated_date']);
      return ctx.json({ entity: body.entity, skip, limit, rows: rows || [] });
    }

    if (body.op === 'filter') {
      const query = body.query && typeof body.query === 'object' ? body.query : {};
      const rows = await filterPage(ent, query, body.sort || 'created_date', limit, skip, body.fields || undefined);
      return ctx.json({ entity: body.entity, skip, limit, rows: rows || [] });
    }

    return ctx.json({ error: `Unknown op: ${body.op}` }, 400);
  } catch (error) {
    return ctx.json({ error: error && error.message ? error.message : String(error) }, 500);
  }
}
