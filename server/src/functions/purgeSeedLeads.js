import { requireUser, HttpError } from './_runtime.js';

// Temporary operator-only utility to count, export, and delete the batch of
// synthetic seed Lead records inserted on 15 July 2026. A record is a seed lead
// only if BOTH are true:
//   - created_date is earlier than 2026-07-15T13:00:00
//   - leadbyte_lead_id is null or undefined
// Both conditions are required. This is deliberately conservative.

const CUTOFF = new Date('2026-07-15T13:00:00Z').getTime();

// Generous ceiling on how many Lead records we will pull in one pass.
const HARD_LIMIT = 200000;

// The single source of truth for the seed predicate.
function isSeedLead(lead) {
  if (!lead || !lead.created_date) return false;
  const created = new Date(lead.created_date).getTime();
  if (isNaN(created)) return false;
  const beforeCutoff = created < CUTOFF;
  const hasLeadByteId = lead.leadbyte_lead_id !== null && lead.leadbyte_lead_id !== undefined;
  return beforeCutoff && !hasLeadByteId;
}

// Pull the full Lead list, ordered by created_date.
async function loadAllLeads(db) {
  const page = await db.entities.Lead.list('created_date', HARD_LIMIT);
  return Array.isArray(page) ? page : [];
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

export default async function purgeSeedLeads(ctx) {
  try {
    const db = ctx.db;

    // Auth gate BEFORE any entity read.
    const user = requireUser(ctx);
    if (user.role !== 'admin') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    const rawMode = (ctx.req.query.mode || '').toString().toLowerCase();
    const mode = ['count', 'export', 'delete'].includes(rawMode) ? rawMode : 'count';

    const leads = await loadAllLeads(db);
    const totalScanned = leads.length;
    const seedLeads = leads.filter(isSeedLead);
    const protectedCount = totalScanned - seedLeads.length;

    // ── mode=count (default) ────────────────────────────────────────────
    if (mode === 'count') {
      let earliest = null;
      let latest = null;
      const byStatus = {};
      const bySupplier = {};
      for (const l of seedLeads) {
        const created = new Date(l.created_date).getTime();
        if (earliest === null || created < earliest) earliest = created;
        if (latest === null || created > latest) latest = created;
        const status = l.final_status || 'Unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
        const supplier = l.supplier_name || 'Unknown';
        bySupplier[supplier] = (bySupplier[supplier] || 0) + 1;
      }
      return {
        total_leads_scanned: totalScanned,
        seed_match_count: seedLeads.length,
        protected_count: protectedCount,
        earliest_seed_created: earliest !== null ? new Date(earliest).toISOString() : null,
        latest_seed_created: latest !== null ? new Date(latest).toISOString() : null,
        breakdown: {
          by_final_status: byStatus,
          by_supplier_name: bySupplier,
        },
      };
    }

    // ── mode=export ─────────────────────────────────────────────────────
    if (mode === 'export') {
      const columns = [
        'id', 'created_date', 'lead_id', 'leadbyte_lead_id', 'final_status',
        'supplier_name', 'supplier_key_id', 'buyer_id', 'buyer_name', 'revenue',
        'supplier_payout', 'conv_value', 'first_name', 'last_name', 'email',
        'mobile', 'lead_vertical', 'lead_tier', 'buyer_feedback',
        'buyer_returned', 'archived',
      ];
      const lines = [columns.map(csvCell).join(',')];
      for (const l of seedLeads) {
        lines.push(columns.map((c) => csvCell(l[c])).join(','));
      }
      const csv = lines.join('\r\n');

      const res = ctx.req && ctx.req.res;
      if (res && typeof res.setHeader === 'function') {
        res.status(200);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="seed-leads-backup.csv"');
        res.send(csv);
        return;
      }
      // Fallback if the raw response object is unavailable.
      return ctx.json(csv, 200);
    }

    // ── mode=delete ─────────────────────────────────────────────────────
    const confirm = (ctx.req.query.confirm || '').toString();
    if (confirm !== 'YES_DELETE_SEED_LEADS') {
      return ctx.json({
        error: 'Delete not confirmed. Pass confirm=YES_DELETE_SEED_LEADS to proceed. Nothing was deleted.',
      }, 400);
    }

    let deletedCount = 0;
    let failedCount = 0;
    const errors = [];
    const batchSize = 10;

    for (let i = 0; i < seedLeads.length; i += batchSize) {
      const batch = seedLeads.slice(i, i + batchSize);
      for (const l of batch) {
        // Re-evaluate the predicate immediately before deleting, do not trust
        // the stale list.
        if (!isSeedLead(l) || !l.id) {
          continue;
        }
        try {
          await db.entities.Lead.delete(l.id);
          deletedCount++;
        } catch (e) {
          failedCount++;
          if (errors.length < 20) {
            errors.push({ id: l.id, error: e?.message || 'delete failed' });
          }
        }
      }
    }

    return {
      deleted_count: deletedCount,
      failed_count: failedCount,
      errors,
    };

  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
