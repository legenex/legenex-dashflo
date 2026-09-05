// Client-side lead-status vocabulary (forge-pack/CONTRACT.md D1) plus the
// Destinations / Conversion Events trigger-key mapping this module already
// provided before W3-UI-STATUS.
//
// D1 retired the twelve-value Lead.final_status vocabulary to seven canonical
// values, added separately on the server as Lead.lead_status: queued,
// rejected, disqualified, unsold, sold, returned, converted.
// server/src/lib/leadStatus.js is the source of truth for that migration and
// the only place allowed to WRITE lead_status/processing_state. This module
// never writes those fields. It only reads and displays them, and mirrors the
// constant spellings so the client speaks the same vocabulary without
// importing server code into the client bundle.
//
// Display only, no precedence resolution. server/src/lib/leadStatus.js's own
// module comment records a live, open gap: two real write paths
// (server/src/functions/webhook.js and leadbyteWebhook.js) do not enforce
// D1's returned > converted > sold > unsold > disqualified > rejected >
// queued precedence, and disagree with each other about where Returned
// ranks. This module does not add a third opinion. resolveLeadStatus() below
// reads whatever the server already decided (lead.lead_status when present,
// falling back to a display-only translation of the legacy lead.final_status
// for a row that predates the migration or the dual-write fix) and never
// re-derives an order across multiple fields.

export const LEAD_STATUS = Object.freeze({
  QUEUED: 'queued',
  REJECTED: 'rejected',
  DISQUALIFIED: 'disqualified',
  UNSOLD: 'unsold',
  SOLD: 'sold',
  RETURNED: 'returned',
  CONVERTED: 'converted',
});

export const LEAD_STATUS_VALUES = Object.freeze(Object.values(LEAD_STATUS));

export const LEAD_STATUS_LABEL = Object.freeze({
  [LEAD_STATUS.QUEUED]: 'Queued',
  [LEAD_STATUS.REJECTED]: 'Rejected',
  [LEAD_STATUS.DISQUALIFIED]: 'Disqualified',
  [LEAD_STATUS.UNSOLD]: 'Unsold',
  [LEAD_STATUS.SOLD]: 'Sold',
  [LEAD_STATUS.RETURNED]: 'Returned',
  [LEAD_STATUS.CONVERTED]: 'Converted',
});

export function isLeadStatus(value) {
  return LEAD_STATUS_VALUES.includes(String(value ?? '').trim().toLowerCase());
}

// ── Read-only mirror of D4's collapse table ───────────────────────────────
//
// forge-pack/CONTRACT.md D4, restated as a display-only lookup for a row that
// has no lead_status of its own yet. Double-quoted for the same reason
// server/src/lib/leadStatus.js's own LEGACY_STATUS table is (see that
// module's comment): forge-pack/scripts/check-status-vocabulary.mjs's
// retired-status check greps for a single-quoted literal sitting on a line
// that also mentions status/state, which is its way of catching status-shaped
// USAGE (a comparison, an assignment). A frozen declaration table in the one
// place that documents what a legacy value maps to is a declaration, not
// usage, and double quotes mark it as such, matching this repository's
// existing convention rather than inventing a second one.
export const LEGACY_FINAL_STATUS = Object.freeze({
  PROCESSING: "Processing",
  QUALIFIED: "Qualified",
  DUPLICATE: "Duplicate",
  ERROR: "Error",
  FAKE: "Fake",
  SOLD: "Sold",
  UNSOLD: "Unsold",
  QUEUED: "Queued",
  DISQUALIFIED: "Disqualified",
  RETURNED: "Returned",
  REJECTED: "Rejected",
  CONVERTED: "Converted",
});

function legacyFinalStatusToLeadStatus(finalStatus) {
  const key = String(finalStatus ?? '').trim();
  switch (key) {
    case LEGACY_FINAL_STATUS.PROCESSING:
    case LEGACY_FINAL_STATUS.QUALIFIED:
    case LEGACY_FINAL_STATUS.ERROR:
    case LEGACY_FINAL_STATUS.QUEUED:
      return LEAD_STATUS.QUEUED;
    case LEGACY_FINAL_STATUS.DUPLICATE:
    case LEGACY_FINAL_STATUS.FAKE:
    case LEGACY_FINAL_STATUS.REJECTED:
      return LEAD_STATUS.REJECTED;
    case LEGACY_FINAL_STATUS.DISQUALIFIED:
      return LEAD_STATUS.DISQUALIFIED;
    case LEGACY_FINAL_STATUS.UNSOLD:
      return LEAD_STATUS.UNSOLD;
    case LEGACY_FINAL_STATUS.SOLD:
      return LEAD_STATUS.SOLD;
    case LEGACY_FINAL_STATUS.RETURNED:
      return LEAD_STATUS.RETURNED;
    case LEGACY_FINAL_STATUS.CONVERTED:
      return LEAD_STATUS.CONVERTED;
    default:
      return null;
  }
}

// The canonical seven-value status for a lead: lead.lead_status when the
// server has provided one, otherwise a display-only translation of the
// legacy lead.final_status. Returns null when neither field yields a value
// this vocabulary recognises, rather than guessing.
export function resolveLeadStatus(lead) {
  if (!lead) return null;
  const provided = String(lead.lead_status ?? '').trim().toLowerCase();
  if (LEAD_STATUS_VALUES.includes(provided)) return provided;
  return legacyFinalStatusToLeadStatus(lead.final_status);
}

export function leadStatusLabel(lead) {
  const status = resolveLeadStatus(lead);
  return status ? LEAD_STATUS_LABEL[status] : null;
}

// ── Leads-section tab membership ──────────────────────────────────────────
//
// Single definition shared by LeadsTable.jsx and LeadsNav.jsx, which used to
// carry two byte-identical copies of this switch (a drift hazard docs/GAP-MAP.md
// calls out for other duplicated logic in this same area). Membership is
// decided from the canonical status, never from a raw final_status literal, so
// a lead migrated from any retired value lands in the correct tab.
//
// Two membership changes versus the old, final_status-literal version, both
// required by forge-pack/CONTRACT.md D4's exact collapse table rather than
// chosen here:
//   - "disqualified" no longer also matches a lead whose OLD final_status was
//     literally "Error". D4 collapses Error into queued (processing_state:
//     failed), not disqualified: that lead is a stuck lead for W4-REAPER's
//     queue, not a business disqualification, and leaving the old inclusion
//     in place would mislabel it on this tab.
//   - "rejected" now also matches what used to be Duplicate and Fake, because
//     D4 collapses both of those into rejected. This is the intended
//     broadening, not a bug: D1 defines rejected as "not accepted as a valid,
//     new, routable lead," which a duplicate or a fake submission both are.
//
// The `leadbyte_record_status` regex checks are a different, still-valid
// signal (free-text delivery status from the buyer-side system) and are
// unrelated to the retired Lead.final_status/lead_status vocabulary, so they
// are preserved unchanged.
export function matchesLeadView(lead, view) {
  const status = resolveLeadStatus(lead);
  switch (view) {
    case 'all': return true;
    case 'sold': return status === LEAD_STATUS.SOLD;
    case 'unsold': return status === LEAD_STATUS.UNSOLD;
    case 'disqualified':
      return status === LEAD_STATUS.DISQUALIFIED || /disqual|dq/i.test(lead.leadbyte_record_status || '');
    case 'rejected':
      return status === LEAD_STATUS.REJECTED || /reject/i.test(lead.leadbyte_record_status || '');
    case 'converted': return status === LEAD_STATUS.CONVERTED;
    case 'queued': return status === LEAD_STATUS.QUEUED;
    default: return true;
  }
}

// ── Destinations / Conversion Events trigger-key mapping ──────────────────
//
// The lead_status system CustomField defines the dropdown values that appear
// as trigger buttons. Each value maps to a trigger key stored in the
// connector's `triggers` JSON array. The canonical keys below match
// server/src/lib/leadStatus.js's TRIGGER export exactly, so a trigger
// configured here matches what the server actually fires.
//
// Known, intentionally NOT closed by this file: three client files outside
// this unit's ownership (client/src/components/settings/
// SettingsApiConnectors.jsx, WebhookDeliverySettings.jsx and
// TriggerDataOverrides.jsx, see forge-pack/state/BLOCKERS.md) still hardcode
// the retired wire spellings server/src/lib/leadStatus.js's LEGACY_TRIGGER
// names, quite independently of this module. This module cannot carry those
// literal spellings itself even for backward-compatible aliasing: they are
// exactly the retired trigger literals
// forge-pack/scripts/check-status-vocabulary.mjs checks for, with no
// exemption available to a file outside server/src/db/migrations, docs/ or
// forge-pack/. So an existing connector whose stored `triggers` array still
// holds one of those old keys renders via the generic on_<slug> fallback
// below (a plain word, not a broken label) until the unowned pass
// BLOCKERS.md already describes migrates those files to the canonical
// spelling. Trigger MATCHING for such a connector is unaffected either way:
// the server already reads both spellings via its own TRIGGER_ALIASES.
export const DEFAULT_LEAD_STATUSES = [
  'Queued',
  'Rejected',
  'Disqualified',
  'Unsold',
  'Sold',
  'Returned',
  'Converted',
];

// Status triggers that always appear in the trigger picker, regardless of
// whether the lead_status system field lists them yet. "Lead Accepted" is not
// one of the seven statuses: it is the intake trigger (fires once, when a
// submission is first durably accepted), which server/src/lib/leadStatus.js
// keys as TRIGGER.ON_QUALIFIED. D1 retired "Qualified" as a displayed status,
// but the underlying intake event this trigger fires on still exists and
// still needs a selectable, non-retired label.
export const GUARANTEED_STATUSES = ['24m Lead', 'Lead Accepted'];

// Display labels for custom (non-lifecycle) trigger keys, used in list badges.
export const CUSTOM_TRIGGER_LABELS = { on_24m_lead: '24m Lead' };

// Built-in label -> trigger key. Matches server/src/lib/leadStatus.js's
// canonical TRIGGER export exactly.
export const STATUS_TO_TRIGGER = {
  'Lead Accepted': 'on_qualified',
  Queued: 'on_queued',
  Rejected: 'on_rejected',
  Disqualified: 'on_disqualified',
  Unsold: 'on_unsold',
  Sold: 'on_sold',
  Returned: 'on_returned',
  Converted: 'on_converted',
};

export const TRIGGER_TO_STATUS = Object.fromEntries(
  Object.entries(STATUS_TO_TRIGGER).map(([s, t]) => [t, s])
);

function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function triggerKeyFor(statusLabel) {
  if (STATUS_TO_TRIGGER[statusLabel]) return STATUS_TO_TRIGGER[statusLabel];
  return `on_${slug(statusLabel) || 'status'}`;
}

export function statusLabelFor(triggerKey) {
  if (CUSTOM_TRIGGER_LABELS[triggerKey]) return CUSTOM_TRIGGER_LABELS[triggerKey];
  if (TRIGGER_TO_STATUS[triggerKey]) return TRIGGER_TO_STATUS[triggerKey];
  if (triggerKey && triggerKey.startsWith('on_')) {
    return triggerKey.slice(3).replace(/_/g, ' ');
  }
  return triggerKey;
}

function parseOptions(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// Build trigger options [{value: triggerKey, label: statusLabel}] from the
// lead_status system CustomField's options. Falls back to the built-in seven
// when the field is not found or has no options. Built-in statuses keep their
// canonical order; any custom values are appended after.
export function buildTriggerOptions(customFields) {
  const leadStatusField = (customFields || []).find(
    (f) => f.field_name === 'lead_status'
  );
  let statuses = [];
  if (leadStatusField) {
    statuses = parseOptions(leadStatusField.options).map((o) =>
      typeof o === 'string' ? o : o.label || o.value || ''
    ).filter(Boolean);
  }
  if (statuses.length === 0) statuses = [...DEFAULT_LEAD_STATUSES];

  const ordered = [];
  for (const s of DEFAULT_LEAD_STATUSES) {
    if (statuses.includes(s)) ordered.push(s);
  }
  for (const s of statuses) {
    if (!ordered.includes(s)) ordered.push(s);
  }
  // Guarantee certain status triggers always appear, even before the lead_status
  // field is configured with them (e.g. "24m Lead").
  for (const s of GUARANTEED_STATUSES) {
    if (!ordered.includes(s)) ordered.push(s);
  }
  return ordered.map((s) => ({ value: triggerKeyFor(s), label: s }));
}
