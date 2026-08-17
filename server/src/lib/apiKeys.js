// Supplier and master API key credential service.
//
// Task S4. This module owns every operation on API key secret material:
// minting, hashing, and resolving a presented key back to its record. No other
// module should hash a key or query `ApiKey` by a secret field directly.
//
// Storage model
// -------------
// `key_hash` is the credential of record: SHA-256 hex of the raw key. Lookup is
// an equality match on that hash, which keeps the O(1) `filter` the repository
// already supports. A slow password hash such as bcrypt cannot be looked up by
// value and would force a full table scan and compare on every inbound lead,
// which is the hot path. Keys are 192 bits of `crypto.randomBytes` entropy
// rather than a human-chosen password, so the work factor that protects
// passwords buys nothing here. This mirrors `InboundWebhookRoute.token_hash`,
// which is the existing precedent in this repository.
//
// Migration posture
// -----------------
// This lands additively. `key` (cleartext) is still written by legacy callers
// and is still readable here, behind `legacyCleartextEnabled()`. Nothing in
// this change deletes cleartext. The sequence is:
//
//   1. add `key_hash`, backfill it for every existing row  (this change)
//   2. resolve by hash, fall back to cleartext, backfill on hit  (this change)
//   3. observe that real traffic resolves by hash, not by fallback
//   4. set DASHFLO_APIKEY_LEGACY_CLEARTEXT=0 and confirm nothing breaks
//   5. only then purge the `key` field  (a separate, reversible task)
//
// Step 5 is deliberately not in this change. Removing cleartext before the hash
// path has been exercised against real supplier traffic would lock out every
// supplier at once with no way back.

import crypto from 'node:crypto';

// Bytes of entropy in a newly minted key. 24 bytes base64url is 32 characters,
// which matches the length the previous browser-side generator produced, so
// nothing downstream that slices or displays a key needs to change.
const KEY_BYTES = 24;

// How much of the raw key is retained in cleartext for display. This is a
// deliberate, bounded disclosure: the operator needs to tell one key from
// another in a list. 16 characters of a 32 character key would be half the
// secret, so the prefix is the tag plus a short discriminator instead.
//
// Under the DashFlo namespace the tag is 11 characters, so the discriminator
// is 5 characters of base64url, about 30 bits. That is ample to tell keys
// apart in a list and discloses less of the secret than the 7 characters the
// shorter legacy tag left exposed.
const PREFIX_LENGTH = 16;

// ── Credential namespace ────────────────────────────────────────────────────
//
// Every credential DashFlo mints carries a `dshflo_` prefix followed by a
// three letter type tag. One rule, no exceptions:
//
//   dshflo_mst_<random>   master / system ingest key
//   dshflo_sup_<random>   supplier ingest key
//   dshflo_byr_<random>   buyer key (minted by functions/systemKeys.js)
//
// The explicit `sup` tag is used rather than a bare `dshflo_` supplier key so
// that every credential reads its own type. An operator holding a value can
// tell what it is without looking it up, and the migration below can map a
// legacy value to the right namespace deterministically.
//
// `lgnx_` was the Legenex-era namespace. Nothing mints it any more. It survives
// here only as a translation table, because Base44 is a migration source that
// still contains values in the old shape, and a stored DashFlo row may predate
// this change. See translateCredentialNamespace.

export const KEY_NAMESPACE = 'dshflo_';

export const KEY_TAGS = {
  master: 'dshflo_mst_',
  supplier: 'dshflo_sup_',
  buyer: 'dshflo_byr_',
};

// Legacy tag -> DashFlo tag. Ordered longest first so `lgnx_mst_` is matched
// before the bare `lgnx_` fallback.
export const LEGACY_TAG_TRANSLATIONS = [
  ['lgnx_mst_', 'dshflo_mst_'],
  ['lgnx_sup_', 'dshflo_sup_'],
  ['lgnx_byr_', 'dshflo_byr_'],
  ['lgnx_ext_', 'dshflo_ext_'],
  ['lgnx_', 'dshflo_'],
];

export function isLegacyNamespace(raw) {
  return /^lgnx_/.test(String(raw ?? '').trim());
}

export function isDashfloNamespace(raw) {
  return String(raw ?? '').trim().startsWith(KEY_NAMESPACE);
}

// Map a credential value into the DashFlo namespace.
//
// The transformation is a pure prefix swap and is deliberately deterministic:
// the same input always produces the same output, so a migration that runs
// twice produces the same key, the same SHA-256 hash and the same stored row.
// That is what makes the Base44 import idempotent without needing to remember
// whether it already converted a given record.
//
// The secret material after the tag is preserved verbatim. It is 24 bytes of
// base64url entropy in both namespaces, the hash is taken over the whole
// string rather than the suffix, and there is no checksum or length rule that
// the prefix participates in, so preserving it is safe and keeps the record's
// identity intact. A value that is already DashFlo, or is not a recognised
// credential at all, is returned unchanged.
export function translateCredentialNamespace(raw) {
  const value = String(raw ?? '');
  if (!value || !isLegacyNamespace(value)) return value;
  for (const [from, to] of LEGACY_TAG_TRANSLATIONS) {
    if (value.startsWith(from)) return `${to}${value.slice(from.length)}`;
  }
  return value;
}

// SHA-256 hex of a presented key. Exported so the backfill script and the
// tests derive the hash exactly the way the resolver does, rather than
// reimplementing it.
export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw ?? ''), 'utf8').digest('hex');
}

// Mint a new key with cryptographic entropy.
//
// The previous generator lived in the browser and used Math.random(), which is
// not a cryptographic source. A supplier key authenticates inbound leads, so a
// predictable key is an authentication bypass. Minting moved server-side for
// that reason and the raw value is returned to the caller exactly once.
export function mintApiKey(type = 'supplier') {
  const tag = KEY_TAGS[type] || KEY_TAGS.supplier;
  return `${tag}${crypto.randomBytes(KEY_BYTES).toString('base64url')}`;
}

export function keyPrefixOf(raw) {
  return String(raw ?? '').slice(0, PREFIX_LENGTH);
}

// Build the stored shape for a raw key. The caller persists this; it never
// contains the raw value.
export function storedFieldsFor(raw) {
  return {
    key_hash: hashApiKey(raw),
    key_prefix: keyPrefixOf(raw),
  };
}

// Whether a presented key may still be matched against the legacy cleartext
// `key` column. Defaults to enabled so this change cannot lock out a supplier
// whose row has not been backfilled yet. Set DASHFLO_APIKEY_LEGACY_CLEARTEXT
// to 0, false, or no to prove the hash-only path in isolation.
export function legacyCleartextEnabled() {
  const raw = process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|no)$/i.test(String(raw).trim());
}

// Resolve a presented raw key to its ApiKey record.
//
// Returns { record, matchedBy, backfilled } where matchedBy is 'hash',
// 'cleartext', or null. The caller decides what to do with an inactive key; a
// record is returned whether or not it is active so the caller can distinguish
// "unknown key" from "known but disabled" in its own logging.
export async function resolveApiKey(db, rawKey) {
  const raw = String(rawKey ?? '').trim();
  if (!raw) return { record: null, matchedBy: null, backfilled: false };

  const hash = hashApiKey(raw);

  const byHash = await db.entities.ApiKey.filter({ key_hash: hash });
  if (byHash.length > 0) {
    return { record: byHash[0], matchedBy: 'hash', backfilled: false };
  }

  if (!legacyCleartextEnabled()) {
    return { record: null, matchedBy: null, backfilled: false };
  }

  // Transitional path. A row that predates the backfill still carries only
  // cleartext. Match it, then write its hash so the next request for the same
  // key takes the hash path and the population converges without a maintenance
  // window.
  const byCleartext = await db.entities.ApiKey.filter({ key: raw });
  if (byCleartext.length === 0) {
    return { record: null, matchedBy: null, backfilled: false };
  }

  const record = byCleartext[0];
  let backfilled = false;
  try {
    await db.entities.ApiKey.update(record.id, { key_hash: hash });
    record.key_hash = hash;
    backfilled = true;
  } catch {
    // A failed backfill must not fail the request. The key was valid; the row
    // simply stays on the cleartext path until the next attempt or the
    // batch script picks it up.
  }

  return { record, matchedBy: 'cleartext', backfilled };
}

// Resolve and require an active key. Returns the record or null.
export async function resolveActiveApiKey(db, rawKey) {
  const { record, matchedBy } = await resolveApiKey(db, rawKey);
  if (!record) return null;
  if (record.active === false) return null;
  return { ...record, __matchedBy: matchedBy };
}

export default {
  KEY_NAMESPACE,
  KEY_TAGS,
  LEGACY_TAG_TRANSLATIONS,
  isLegacyNamespace,
  isDashfloNamespace,
  translateCredentialNamespace,
  hashApiKey,
  mintApiKey,
  keyPrefixOf,
  storedFieldsFor,
  legacyCleartextEnabled,
  resolveApiKey,
  resolveActiveApiKey,
};
