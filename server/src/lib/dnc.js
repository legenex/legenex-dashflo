// Global do-not-contact. Task I2.
//
// Requirements this module implements:
//
//   - global DNC is the first business validation after durable capture
//   - match normalized phone and email with keyed hashes
//   - support scope, status, effective dates, reason, source, actor, and
//     immutable history
//   - suppressed leads are retained with a stable rejection reason and are
//     never contacted or delivered
//   - enforcement is identical across every real intake source
//
// The last point is the reason this is a module and not a branch inside
// processLead. One implementation, one set of tests, called from the single
// canonical service. Wiring it in is task I3.
//
// Keyed hashes
// ------------
// Entries are stored as HMAC-SHA256 of the normalized value under a server
// held key, never as the raw phone or email. A suppression list is a list of
// people who asked not to be contacted, so it is exactly the population that
// must not leak, and a plain hash of a 10 digit phone number is trivially
// reversible by enumeration: the whole keyspace is ten billion, which a laptop
// walks in minutes. The HMAC key makes that enumeration useless without also
// stealing the key.
//
// The key is required. There is no development default, because a default
// would silently produce a list that looks protected and is not, and because
// changing the key later invalidates every stored hash.

import crypto from 'node:crypto';

export const DNC_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
};

export const DNC_SCOPE = {
  GLOBAL: 'global',
  VERTICAL: 'vertical',
  CAMPAIGN: 'campaign',
};

// Stable machine reason. Requirement: every rejection is retained with a
// stable machine reason and a useful human explanation.
export const DNC_REJECTION = {
  code: 'DNC_SUPPRESSED',
  message: 'This contact is on the do-not-contact list and cannot be delivered.',
};

export class DncKeyMissingError extends Error {
  constructor() {
    super(
      'DNC_HASH_KEY is not set. Global do-not-contact matching is disabled without it, '
      + 'and running intake with DNC disabled would contact people who opted out. '
      + 'Set DNC_HASH_KEY to a value from the production secret mechanism.',
    );
    this.name = 'DncKeyMissingError';
  }
}

export function dncKey() {
  const key = process.env.DNC_HASH_KEY || '';
  if (!key) throw new DncKeyMissingError();
  return key;
}

export function hasDncKey() {
  return Boolean(process.env.DNC_HASH_KEY);
}

// ── Normalization ───────────────────────────────────────────────────────────
//
// Matching is only as good as the normalization, and the normalization has to
// be identical on the way in and on the way out or an entry silently stops
// matching. Both directions go through these two functions.

// US and Canada, matching the existing toE164Us behaviour in the lead identity
// helpers: 10 digits, or 11 digits starting with 1.
export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Already international, or something this system does not route. Keep it
  // rather than dropping it, so a non US suppression still matches itself.
  if (digits.length > 11) return `+${digits}`;
  return null;
}

export function normalizeEmail(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || !raw.includes('@')) return null;
  const [local, domain] = raw.split('@');
  if (!local || !domain) return null;
  // Deliberately no gmail dot or plus folding. Two addresses that differ by a
  // plus tag are different addresses for consent purposes, and folding them
  // would suppress people who never opted out.
  return `${local}@${domain}`;
}

export function normalizeValue(kind, value) {
  if (kind === 'phone') return normalizePhone(value);
  if (kind === 'email') return normalizeEmail(value);
  return null;
}

// Keyed hash of a normalized value. Throws if the key is absent, so a caller
// cannot accidentally build an unprotected list.
export function hashValue(kind, normalized) {
  if (!normalized) return null;
  return crypto
    .createHmac('sha256', dncKey())
    .update(`${kind}:${normalized}`, 'utf8')
    .digest('hex');
}

// Convenience: normalize then hash. Returns null when the input is not a valid
// contact of that kind, which the caller must treat as "cannot be checked",
// not as "not suppressed".
export function hashContact(kind, rawValue) {
  const normalized = normalizeValue(kind, rawValue);
  if (!normalized) return null;
  return hashValue(kind, normalized);
}

// ── Effective window ────────────────────────────────────────────────────────

// Whether an entry suppresses at a given instant.
//
// An entry is in force when it is active, has begun, and has not ended. A
// future dated entry does not suppress yet, and an expired one does not
// suppress any more, but both are retained: history is immutable, so expiry is
// a state change rather than a delete.
export function isInForce(entry, at = new Date()) {
  if (!entry) return false;
  if (entry.status !== DNC_STATUS.ACTIVE) return false;

  const now = at instanceof Date ? at : new Date(at);
  if (entry.effective_from && new Date(entry.effective_from) > now) return false;
  if (entry.effective_to && new Date(entry.effective_to) <= now) return false;
  return true;
}

// Whether an entry's scope covers the lead being checked.
//
// Global covers everything. A narrower scope only covers a matching vertical
// or campaign. An entry with a narrower scope and no value set covers nothing,
// which is the safe reading of an incompletely configured entry: it fails
// closed for the operator (the entry does nothing until finished) rather than
// failing open for the contact.
export function scopeCovers(entry, context = {}) {
  const scope = entry?.scope || DNC_SCOPE.GLOBAL;
  if (scope === DNC_SCOPE.GLOBAL) return true;
  if (scope === DNC_SCOPE.VERTICAL) {
    return Boolean(entry.scope_value) && entry.scope_value === context.vertical;
  }
  if (scope === DNC_SCOPE.CAMPAIGN) {
    return Boolean(entry.scope_value) && entry.scope_value === context.campaign_id;
  }
  return false;
}

// ── The check ───────────────────────────────────────────────────────────────

// Decide whether a lead is suppressed.
//
// `entries` is the candidate set already fetched by hash, so this function is
// pure and can be tested exhaustively without a database. The caller looks up
// by hash, which is what keeps the lookup O(1) and keeps raw values out of the
// query.
//
// Returns { suppressed, matched, reason }. `matched` names which contact field
// hit, so the rejection can say why without echoing the value back.
export function evaluateSuppression({ entries = [], context = {}, at = new Date() } = {}) {
  for (const entry of entries) {
    if (!isInForce(entry, at)) continue;
    if (!scopeCovers(entry, context)) continue;
    return {
      suppressed: true,
      matched: entry.contact_kind,
      entry_id: entry.id,
      reason: DNC_REJECTION.code,
      message: DNC_REJECTION.message,
      // The operator-facing reason recorded on the entry, not the raw contact.
      entry_reason: entry.reason || null,
    };
  }
  return { suppressed: false, matched: null, reason: null, message: null };
}

// Build the hash set for a lead. Returns the hashes to look up and which kind
// each came from, so a caller can report what could not be checked.
export function contactHashesFor(lead = {}) {
  const out = [];
  const unresolvable = [];

  for (const [kind, raw] of [['phone', lead.phone], ['email', lead.email]]) {
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const normalized = normalizeValue(kind, raw);
    if (!normalized) { unresolvable.push(kind); continue; }
    out.push({ kind, normalized, hash: hashValue(kind, normalized) });
  }

  return { hashes: out, unresolvable };
}

export default {
  DNC_STATUS,
  DNC_SCOPE,
  DNC_REJECTION,
  DncKeyMissingError,
  dncKey,
  hasDncKey,
  normalizePhone,
  normalizeEmail,
  normalizeValue,
  hashValue,
  hashContact,
  isInForce,
  scopeCovers,
  evaluateSuppression,
  contactHashesFor,
};
