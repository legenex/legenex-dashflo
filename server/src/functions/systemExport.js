import { requireUser, HttpError } from './_runtime.js';

// Caller model: MASTER ADMIN ONLY. Produces a portable bundle of system data for
// seeding another app. Deny by default: partner accounts (buyer/supplier or any
// linked_* record) are rejected outright and can never be granted access, and
// every other caller needs base_role owner or the explicit set_export_import
// permission key.
//
// Credentials never travel. Redaction runs server side on every record, is not
// switchable, and the client cannot ask for a raw export. The manifest reports
// exactly which fields were scrubbed so the receiving app gets a re-entry list.
//
// Paged by design: the client walks entities and offsets, so no single request
// has to hold the whole system in memory.

const PAGE_MAX = 500;

// Catalog and redaction ship as generated siblings (see
// scripts/generate-transfer-catalog.mjs) and are the single source of truth for
// what is exportable and how each record is scrubbed. They are imported as-is so
// the redaction rules stay identical to what the generator emits — no runtime
// translation is applied to that security-critical logic.

export default async function systemExport(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const caller = (await db.entities.User.get(user.id).catch(() => null)) || user;

    // Hard partner exclusion first, before any permission map is consulted.
    if (caller.base_role === 'buyer' || caller.base_role === 'supplier'
      || caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }

    const isMaster = caller.base_role === 'owner' || permissions.set_export_import === true;
    if (!isMaster) return ctx.json({ error: 'Forbidden' }, 403);

    const catalog = await import('./systemTransfer.generated.js');
    const { redactRecord, summariseRedactions } = await import('./systemTransferRedact.generated.js');

    const body = ctx.body || {};
    const mode = String(body.mode || 'records');

    // ---- counts: what is actually there, before anything is downloaded ----
    if (mode === 'counts') {
      const names = Array.isArray(body.entities) && body.entities.length
        ? body.entities.filter((n) => catalog.ALL_ENTITIES.includes(n))
        : catalog.ALL_ENTITIES;

      const counts = {};
      for (const name of names) {
        try {
          const rows = await db.entities[name].list(null, PAGE_MAX);
          let total = (rows || []).length;
          // Walk further pages only when the first came back full.
          let offset = total;
          while (total > 0 && total % PAGE_MAX === 0 && offset < 20000) {
            const next = await db.entities[name].list(null, PAGE_MAX, offset);
            const got = (next || []).length;
            total += got;
            offset += got;
            if (got < PAGE_MAX) break;
          }
          counts[name] = total;
        } catch {
          counts[name] = -1; // entity unavailable to this caller or missing
        }
      }
      return { ok: true, counts };
    }

    // ---- schemas: entity definitions, so an empty app can be seeded ----
    if (mode === 'schemas') {
      return {
        ok: true,
        note: 'Entity schema definitions are exported from the app source, not the record API.',
        entities: catalog.ALL_ENTITIES,
      };
    }

    // ---- records: one entity, one page ----
    const entity = String(body.entity || '');
    if (!catalog.ALL_ENTITIES.includes(entity)) {
      return ctx.json({ error: `Unknown or non-exportable entity: ${entity}` }, 400);
    }

    const limit = Math.min(Number(body.limit) || PAGE_MAX, PAGE_MAX);
    const offset = Math.max(Number(body.offset) || 0, 0);

    const rows = (await db.entities[entity].list(null, limit, offset)) || [];

    const records = [];
    const hits = [];
    for (const row of rows) {
      const { record, redacted } = redactRecord(entity, row);
      records.push(record);
      for (const h of redacted) hits.push(h);
    }

    return {
      ok: true,
      entity,
      offset,
      returned: records.length,
      done: records.length < limit,
      records,
      redactions: summariseRedactions(entity, hits),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      const status = error.status || error.statusCode || 500;
      return ctx.json({ error: error.message }, status);
    }
    return ctx.json({ error: error.message }, 500);
  }
}
