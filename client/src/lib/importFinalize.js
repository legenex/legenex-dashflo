import { LEGACY_FINAL_STATUS } from '@/lib/leadStatus';

// Materialization for imported leads. CSV imports historically stored every
// value inside the mapped_fields JSON string and left final_status at the
// schema default "Processing". This module promotes mapped values onto the
// top-level Lead columns the app reads, derives lead_type when missing, and
// guarantees an imported lead never remains at that transit state (a
// live-pipeline transit state, not a valid imported outcome).
//
// Used in two places:
// 1. CsvImporter calls materializeRecord() at commit time so every future
//    import is written complete in one pass.
// 2. finalizePendingImports() repairs existing imported leads in place using
//    the operator's session (same write path as the lead detail modal).
//
// This path writes Lead rows directly through the generic entity API,
// bypassing server/src/functions/processLead.js entirely, so it is
// responsible for its own dual-write of the seven-value vocabulary
// (forge-pack/CONTRACT.md D1) alongside the legacy final_status column,
// mirroring server/src/lib/leadStatus.js's expand-phase approach for the one
// write path that module cannot reach (a client-originated CSV import has no
// server-side equivalent of statusPatch to call through). See
// buildFinalizePatch below for the actual field set written; this lookup only
// resolves which of the twelve legacy final_status labels an arbitrary import
// value maps onto, matching forge-pack/CONTRACT.md D4's table exactly for the
// five retired values.
const STATUS_LOOKUP = {
  sold: 'Sold',
  unsold: 'Unsold', rejected: 'Unsold', reject: 'Unsold',
  qualified: 'Qualified',
  disqualified: 'Disqualified', dq: 'Disqualified',
  duplicate: 'Duplicate', dupe: 'Duplicate', dup: 'Duplicate', duplicates: 'Duplicate',
  error: 'Error', err: 'Error',
  queued: 'Queued', queue: 'Queued',
  returned: 'Returned', return: 'Returned',
};
// Imported leads never resolve to the transit "Processing" state: unknown,
// blank, "new" and "processing" all land on the neutral accepted state D4
// maps the retired "Qualified" legacy label onto (queued, is_qualified:
// true), which is what QUALIFIED_FALLBACK resolves to below.
export const normalizeImportStatus = (raw) =>
  STATUS_LOOKUP[String(raw ?? '').trim().toLowerCase()] || LEGACY_FINAL_STATUS.QUALIFIED;

// forge-pack/CONTRACT.md D4's table, restated for this client-only write
// path. Mirrors server/src/lib/leadStatus.js's LEGACY_STATUS_MAP exactly for
// the fields this module is allowed to touch; money fields are never in this
// list and never written by this module. Keyed by the LEGACY_FINAL_STATUS
// constants (client/src/lib/leadStatus.js), never by a bare literal.
const LEAD_STATUS_FOR_LEGACY = {
  [LEGACY_FINAL_STATUS.PROCESSING]: { lead_status: 'queued', processing_state: 'routing', is_qualified: null },
  [LEGACY_FINAL_STATUS.QUALIFIED]: { lead_status: 'queued', processing_state: 'settled', is_qualified: true },
  [LEGACY_FINAL_STATUS.DUPLICATE]: { lead_status: 'rejected', processing_state: 'settled', status_reason: 'REJECTED_DUPLICATE', is_qualified: false },
  [LEGACY_FINAL_STATUS.ERROR]: { lead_status: 'queued', processing_state: 'failed', is_qualified: null },
  [LEGACY_FINAL_STATUS.FAKE]: { lead_status: 'rejected', processing_state: 'settled', status_reason: 'REJECTED_FAKE', is_qualified: false },
  [LEGACY_FINAL_STATUS.QUEUED]: { lead_status: 'queued', processing_state: 'settled', is_qualified: null },
  [LEGACY_FINAL_STATUS.SOLD]: { lead_status: 'sold', processing_state: 'settled', is_qualified: true },
  [LEGACY_FINAL_STATUS.UNSOLD]: { lead_status: 'unsold', processing_state: 'settled', is_qualified: true },
  [LEGACY_FINAL_STATUS.DISQUALIFIED]: { lead_status: 'disqualified', processing_state: 'settled', is_qualified: false },
  [LEGACY_FINAL_STATUS.REJECTED]: { lead_status: 'rejected', processing_state: 'settled', is_qualified: false },
  [LEGACY_FINAL_STATUS.RETURNED]: { lead_status: 'returned', processing_state: 'settled', is_qualified: true },
  [LEGACY_FINAL_STATUS.CONVERTED]: { lead_status: 'converted', processing_state: 'settled', is_qualified: true },
};

// The new-vocabulary half of a status patch for a resolved legacy
// final_status label, or null when the label is not one of the twelve this
// module knows. Additive only: never touches final_status (the caller sets
// that separately) and never touches a money flag.
export function newVocabularyPatch(legacyFinalStatus) {
  const descriptor = LEAD_STATUS_FOR_LEGACY[String(legacyFinalStatus ?? '').trim()];
  if (!descriptor) return null;
  const patch = { lead_status: descriptor.lead_status, processing_state: descriptor.processing_state };
  if (descriptor.status_reason) patch.status_reason = descriptor.status_reason;
  if (descriptor.is_qualified === true || descriptor.is_qualified === false) patch.is_qualified = descriptor.is_qualified;
  return patch;
}

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'none') return null;
  return s;
};

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Derive lead_type when the payload did not carry one. Per Nick's rule on
// 20 Jul 2026: our own quiz funnels (sid LEADFLOW or LGNX) are 'Quiz'; every
// other supplier (INBNDS and any future affiliate) is 'Affiliate'.
export function deriveLeadType(mapped) {
  const existing = clean(mapped.lead_type);
  if (existing) return existing;
  const sid = String(mapped.sid || '').trim().toUpperCase();
  if (sid === 'LEADFLOW' || sid === 'LGNX') return 'Quiz';
  return 'Affiliate';
}

// Build the top-level patch for one lead from its mapped fields. Only fills
// gaps: an already-populated top-level value is never overwritten. Returns
// null when nothing needs to change.
export function buildFinalizePatch(lead) {
  let mapped = {};
  try { mapped = JSON.parse(lead.mapped_fields || '{}') || {}; } catch { mapped = {}; }
  const patch = {};

  if (!lead.final_status || lead.final_status === LEGACY_FINAL_STATUS.PROCESSING) {
    patch.final_status = normalizeImportStatus(mapped.lead_status);
  }
  // Whenever final_status is (re)settled above, or a row already carries a
  // settled final_status but has never had the seven-value fields written
  // (a row from before W2-STATUS's dual-write existed), stamp the matching
  // lead_status/processing_state/status_reason/is_qualified alongside it, so
  // an imported lead never has a NULL lead_status the way live leads did
  // before webhook.js/leadbyteWebhook.js's own dual-write fix (see
  // server/src/lib/leadStatus.js's module comment, adversarial QA finding
  // B2). Never overwrites a lead_status the row already has.
  if (!lead.lead_status) {
    const resolvedFinalStatus = patch.final_status || lead.final_status;
    const vocab = newVocabularyPatch(resolvedFinalStatus);
    if (vocab) Object.assign(patch, vocab);
  }
  if (!clean(lead.lead_vertical) && clean(mapped.vertical)) patch.lead_vertical = clean(mapped.vertical);
  if (!clean(lead.buyer_name) && (clean(mapped.buyer_name) || clean(mapped.buyer))) {
    patch.buyer_name = clean(mapped.buyer_name) || clean(mapped.buyer);
  }
  if (!clean(lead.buyer_id) && clean(mapped.buyer_id)) patch.buyer_id = clean(mapped.buyer_id);
  if (!clean(lead.buyer_feedback) && clean(mapped.buyer_feedback)) patch.buyer_feedback = clean(mapped.buyer_feedback);
  if (lead.buyer_returned !== true && String(mapped.returned || '').trim().toLowerCase() === 'yes') {
    patch.buyer_returned = true;
  }
  if (!clean(lead.buyer_return_reason) && clean(mapped.returned_reason)) {
    patch.buyer_return_reason = clean(mapped.returned_reason);
  }
  if (lead.supplier_payout == null && num(mapped.supplier_payout) != null) {
    patch.supplier_payout = num(mapped.supplier_payout);
  }
  if ((lead.revenue == null || lead.revenue === 0) && num(mapped.revenue ?? mapped.cpl) != null) {
    const r = num(mapped.revenue ?? mapped.cpl);
    if (r > 0) patch.revenue = r;
  }
  if (!clean(lead.email_valid)) {
    const ev = clean(mapped.email_valid);
    if (ev === 'Yes' || ev === 'No') patch.email_valid = ev;
  }

  // lead_type lives inside mapped_fields (the table reads it from there).
  const derived = deriveLeadType(mapped);
  if (derived && !clean(mapped.lead_type)) {
    patch.mapped_fields = JSON.stringify({ ...mapped, lead_type: derived });
  }

  return Object.keys(patch).length ? patch : null;
}

// Commit-time variant for CsvImporter: mutates the outgoing record and its
// mapped object before creation so new imports are complete in one pass.
export function materializeRecord(out, mapped) {
  const fake = {
    final_status: out.final_status,
    lead_status: out.lead_status,
    lead_vertical: out.lead_vertical,
    buyer_name: out.buyer_name,
    buyer_id: out.buyer_id,
    buyer_feedback: out.buyer_feedback,
    buyer_returned: out.buyer_returned,
    buyer_return_reason: out.buyer_return_reason,
    supplier_payout: out.supplier_payout,
    revenue: out.revenue != null ? Number(out.revenue) : null,
    email_valid: out.email_valid,
    mapped_fields: JSON.stringify(mapped),
  };
  const patch = buildFinalizePatch(fake) || {};
  const { mapped_fields: patchedMapped, ...rest } = patch;
  Object.assign(out, rest);
  if (patchedMapped) {
    try { Object.assign(mapped, JSON.parse(patchedMapped)); } catch { /* keep original */ }
  }
  // Imported leads must never be created sitting at the transit state.
  if (!out.final_status || out.final_status === LEGACY_FINAL_STATUS.PROCESSING) {
    out.final_status = LEGACY_FINAL_STATUS.QUALIFIED;
  }
  // Guarantee the seven-value fields are never left unset even when the patch
  // above found nothing else to fill in (e.g. an all-defaults row).
  if (!out.lead_status) {
    const vocab = newVocabularyPatch(out.final_status);
    if (vocab) Object.assign(out, vocab);
  }
  return out;
}

// Repair every imported lead still sitting in the transit state, or a single
// batch when batchId is given. Pages through records and updates them one by
// one with the operator session. Reports progress via onProgress(done, total).
export async function finalizePendingImports(api, { batchId = null, onProgress = () => {} } = {}) {
  const filter = batchId
    ? { import_batch_id: batchId }
    : { final_status: LEGACY_FINAL_STATUS.PROCESSING };
  const pageSize = 200;
  const targets = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await api.entities.Lead.filter(filter, '-created_date', pageSize, page * pageSize);
    // Only imported records: live leads pass through the transit state legitimately.
    batch.forEach(l => { if (l.import_batch_id) targets.push(l); });
    if (batch.length < pageSize) break;
    page += 1;
  }
  let done = 0;
  let updated = 0;
  for (const lead of targets) {
    const patch = buildFinalizePatch(lead);
    if (patch) {
      await api.entities.Lead.update(lead.id, patch);
      updated += 1;
    }
    done += 1;
    if (done % 10 === 0 || done === targets.length) onProgress(done, targets.length);
  }
  return { scanned: targets.length, updated };
}
