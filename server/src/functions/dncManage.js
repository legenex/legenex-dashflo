// Operator surface for the global do-not-contact list. Task I2.
//
// Ops:
//   check   { contacts: [{kind, value}], context? }  is this contact suppressed
//   add     { kind, value, scope?, reason, source?, effective_from?, effective_to? }
//   expire  { id, reason }                            retire without deleting
//   import  { entries: [...], batch_id? }             bulk load
//
// Every op hashes server-side. The raw phone or email never reaches storage
// and the hash never reaches a client, so the browser cannot build its own
// copy of the list or test membership offline.
//
// Deleting is deliberately absent. The requirement is immutable history:
// suppressions are expired, and both the entry and the act of expiring it stay
// on the record.

import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import {
  DNC_STATUS,
  DNC_SCOPE,
  hasDncKey,
  normalizeValue,
  hashValue,
  contactHashesFor,
  evaluateSuppression,
} from '../lib/dnc.js';

const OPERATORS = [ROLE.OWNER, ROLE.ADMIN, ROLE.MANAGER];

// Masked form for operator lists. Enough to recognise a record you just
// entered, not enough to recover the contact from an export.
function maskContact(kind, normalized) {
  const v = String(normalized || '');
  if (!v) return '';
  if (kind === 'phone') return `${v.slice(0, 2)}${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-2)}`;
  const [local, domain] = v.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

async function findByHash(db, hash) {
  return db.entities.DncEntry.filter({ contact_hash: hash });
}

export default async function dncManage(ctx) {
  if (!OPERATORS.includes(resolveRoleClass(ctx.user))) {
    return ctx.json({ success: false, error: 'Not permitted to manage the do-not-contact list' }, 403);
  }

  if (!hasDncKey()) {
    // Fail closed and say why. Serving this endpoint without the key would
    // return "not suppressed" for everyone, which is the dangerous answer.
    return ctx.json({
      success: false,
      error: 'DNC_HASH_KEY is not configured. Do-not-contact matching is unavailable until it is set.',
      code: 'DNC_KEY_MISSING',
    }, 503);
  }

  const body = ctx.body || {};
  const op = String(body.op || 'check').trim();
  const db = ctx.db;
  const actor = ctx.user?.id || 'unknown';

  try {
    if (op === 'check') {
      const contacts = Array.isArray(body.contacts) ? body.contacts : [];
      const context = body.context || {};
      const results = [];

      for (const c of contacts) {
        const kind = c?.kind === 'email' ? 'email' : 'phone';
        const normalized = normalizeValue(kind, c?.value);
        if (!normalized) {
          results.push({ kind, checkable: false, suppressed: false, reason: 'not a valid contact of this kind' });
          continue;
        }
        const entries = await findByHash(db, hashValue(kind, normalized));
        const verdict = evaluateSuppression({ entries, context });
        results.push({ kind, checkable: true, ...verdict });
      }

      return ctx.json({ success: true, results, suppressed: results.some((r) => r.suppressed) });
    }

    if (op === 'add') {
      const kind = body.kind === 'email' ? 'email' : 'phone';
      const normalized = normalizeValue(kind, body.value);
      if (!normalized) return ctx.json({ success: false, error: `Not a valid ${kind}` }, 400);
      if (!body.reason) return ctx.json({ success: false, error: 'A reason is required' }, 400);

      const scope = Object.values(DNC_SCOPE).includes(body.scope) ? body.scope : DNC_SCOPE.GLOBAL;
      if (scope !== DNC_SCOPE.GLOBAL && !body.scope_value) {
        return ctx.json({ success: false, error: `Scope ${scope} requires a scope_value` }, 400);
      }

      const created = await db.entities.DncEntry.create({
        contact_kind: kind,
        contact_hash: hashValue(kind, normalized),
        contact_display: maskContact(kind, normalized),
        scope,
        scope_value: body.scope_value || undefined,
        status: DNC_STATUS.ACTIVE,
        effective_from: body.effective_from || undefined,
        effective_to: body.effective_to || undefined,
        reason: String(body.reason),
        source: String(body.source || 'manual'),
        actor,
      });

      return ctx.json({
        success: true,
        id: created.id,
        contact_display: created.contact_display,
        scope: created.scope,
      });
    }

    if (op === 'expire') {
      const id = String(body.id || '').trim();
      if (!id) return ctx.json({ success: false, error: 'An entry id is required' }, 400);

      const entry = await db.entities.DncEntry.get(id);
      if (!entry) return ctx.json({ success: false, error: 'Unknown entry' }, 404);
      if (entry.status === DNC_STATUS.EXPIRED) {
        return ctx.json({ success: true, id, already_expired: true });
      }

      await db.entities.DncEntry.update(id, {
        status: DNC_STATUS.EXPIRED,
        expired_at: new Date().toISOString(),
        expired_by: actor,
        expired_reason: String(body.reason || 'expired by operator'),
      });

      return ctx.json({ success: true, id, already_expired: false });
    }

    if (op === 'import') {
      const rows = Array.isArray(body.entries) ? body.entries : [];
      if (rows.length === 0) return ctx.json({ success: false, error: 'No entries supplied' }, 400);

      const batchId = String(body.batch_id || `import_${Date.now()}`);
      const counts = { received: rows.length, added: 0, duplicate: 0, rejected: 0 };
      // Named apart from the `rejected` count on purpose: one is how many, the
      // other is which rows, and collapsing them into one key loses the count.
      const rejectedRows = [];

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] || {};
        const kind = row.kind === 'email' ? 'email' : 'phone';
        const normalized = normalizeValue(kind, row.value);
        if (!normalized) {
          counts.rejected += 1;
          // The row number, not the value: an import report is an artifact and
          // must not carry the contact list in cleartext.
          rejectedRows.push({ row: i + 1, kind, reason: 'not a valid contact of this kind' });
          continue;
        }

        const hash = hashValue(kind, normalized);
        const existing = await findByHash(db, hash);
        if (existing.some((e) => e.status === DNC_STATUS.ACTIVE)) {
          counts.duplicate += 1;
          continue;
        }

        await db.entities.DncEntry.create({
          contact_kind: kind,
          contact_hash: hash,
          contact_display: maskContact(kind, normalized),
          scope: DNC_SCOPE.GLOBAL,
          status: DNC_STATUS.ACTIVE,
          reason: String(row.reason || body.reason || 'bulk import'),
          source: String(body.source || 'bulk_import'),
          actor,
          import_batch_id: batchId,
        });
        counts.added += 1;
      }

      return ctx.json({ success: true, batch_id: batchId, ...counts, rejected_rows: rejectedRows });
    }

    return ctx.json({ success: false, error: `Unknown op: ${op}` }, 400);
  } catch (error) {
    return ctx.json({ success: false, error: error.message }, 500);
  }
}

// Re-exported so I3 can reach the same helper the operator surface uses.
export { contactHashesFor };
