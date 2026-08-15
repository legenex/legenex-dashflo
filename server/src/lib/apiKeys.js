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
const PREFIX_LENGTH = 16;

export const KEY_TAGS = {
  master: 'lgnx_mst_',
  supplier: 'lgnx_sup_',
};

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
  KEY_TAGS,
  hashApiKey,
  mintApiKey,
  keyPrefixOf,
  storedFieldsFor,
  legacyCleartextEnabled,
  resolveApiKey,
  resolveActiveApiKey,
};
