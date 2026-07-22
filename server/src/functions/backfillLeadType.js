import { requireUser } from './_runtime.js';

// Operator-only utility to backfill the lead_type field on leads that were
// imported or created without one. lead_type lives inside the mapped_fields
// JSON string (the leads table and lead detail popup read it from there), so a
// plain updateMany cannot set it: each record needs its own JSON parsed,
// patched, and written back. This function does that server-side against live
// data, scanning the whole table.
//
// Per Nick's rule on 20 July 2026, lead_type derives from the supplier sid:
//   sid LEADFLOW or LGNX -> "Quiz"     (our own quiz funnels)
//   anything else        -> "Affiliate" (INBNDS and any future affiliate)
//
// The operation is idempotent: a lead that already has a non-empty lead_type is
// never touched, so re-running is safe.

function deriveLeadType(mapped) {
  const sid = String(mapped.sid || '').trim().toUpperCase();
  if (sid === 'LEADFLOW' || sid === 'LGNX') return 'Quiz';
  return 'Affiliate';
}

// A lead needs backfill when mapped_fields has no non-empty lead_type key.
function neededPatch(lead) {
  let mapped;
  try { mapped = JSON.parse(lead.mapped_fields || '{}') || {}; } catch { return null; }
  // Case-insensitive scan for an existing, non-empty lead_type.
  for (const [k, v] of Object.entries(mapped)) {
    if (k.toLowerCase() === 'lead_type' && v != null && String(v).trim() !== '') {
      return null; // already set, leave it
    }
  }
  const leadType = deriveLeadType(mapped);
  mapped.lead_type = leadType;
  return { patch: { mapped_fields: JSON.stringify(mapped) }, leadType };
}

async function loadAllLeads(db) {
  // The entity list API is sort + limit (no offset), so pull the whole table in
  // one created_date-ordered call rather than paging by skip.
  const page = await db.entities.Lead.list('created_date', 100000);
  return Array.isArray(page) ? page : [];
}

export default async function backfillLeadType(ctx) {
  // Auth gate BEFORE any entity read. requireUser throws 401 when unauthenticated.
  const user = requireUser(ctx);
  if (user.role !== 'admin') {
    return ctx.json({ error: 'Forbidden' }, 403);
  }

  const db = ctx.db;

  try {
    // Params come from the query string (manual GET) or the POST body (SDK
    // functions.invoke). Body wins when present.
    const body = ctx.body || {};
    const query = (ctx.req && ctx.req.query) || {};
    const rawMode = String(body.mode ?? query.mode ?? '').toLowerCase();
    const mode = ['count', 'apply'].includes(rawMode) ? rawMode : 'count';
    const confirmValue = String(body.confirm ?? query.confirm ?? '');

    const leads = await loadAllLeads(db);
    const totalScanned = leads.length;

    // Build the work list: id + computed patch for every lead that needs one.
    const work = [];
    const byType = { Quiz: 0, Affiliate: 0 };
    for (const l of leads) {
      if (!l || !l.id) continue;
      const res = neededPatch(l);
      if (res) {
        work.push({ id: l.id, patch: res.patch });
        byType[res.leadType] = (byType[res.leadType] || 0) + 1;
      }
    }

    if (mode === 'count') {
      return ctx.json({
        mode: 'count',
        total_leads_scanned: totalScanned,
        missing_lead_type: work.length,
        already_set: totalScanned - work.length,
        would_set: byType,
        note: 'No changes made. Call again with ?mode=apply to backfill.',
      }, 200);
    }

    // ── mode=apply ──────────────────────────────────────────────────────
    if (confirmValue !== 'YES_BACKFILL_LEAD_TYPE') {
      return ctx.json({
        error: 'Apply not confirmed. Pass confirm=YES_BACKFILL_LEAD_TYPE to proceed. Nothing was written.',
        missing_lead_type: work.length,
      }, 400);
    }

    let updated = 0;
    let failed = 0;
    const errors = [];
    const batchSize = 20;
    for (let i = 0; i < work.length; i += batchSize) {
      const batch = work.slice(i, i + batchSize);
      await Promise.all(batch.map(async ({ id, patch }) => {
        try {
          await db.entities.Lead.update(id, patch);
          updated += 1;
        } catch (e) {
          failed += 1;
          if (errors.length < 20) errors.push({ id, error: String(e?.message || e) });
        }
      }));
    }

    return ctx.json({
      mode: 'apply',
      total_leads_scanned: totalScanned,
      attempted: work.length,
      updated,
      failed,
      set_breakdown: byType,
      errors,
    }, 200);
  } catch (err) {
    return ctx.json({ error: String(err?.message || err) }, 500);
  }
}
