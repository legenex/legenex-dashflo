import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

import {
  hashApiKey,
  mintApiKey,
  keyPrefixOf,
  storedFieldsFor,
  legacyCleartextEnabled,
  resolveApiKey,
  resolveActiveApiKey,
} from '../src/lib/apiKeys.js';

// Task S4. These prove the hash path resolves a key on its own, and that the
// legacy cleartext path is a transitional fallback that can be switched off,
// which is the evidence required before the cleartext column is purged.

function makeDb(rows) {
  const store = rows.map((r) => ({ ...r }));
  const updates = [];
  return {
    __rows: store,
    __updates: updates,
    entities: {
      ApiKey: {
        filter: async (query) => {
          const [[field, value]] = Object.entries(query);
          return store.filter((r) => r[field] === value).map((r) => ({ ...r }));
        },
        update: async (id, patch) => {
          updates.push({ id, patch });
          const row = store.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
          return row;
        },
      },
    },
  };
}

const ORIGINAL_FLAG = process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT;
  else process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT = ORIGINAL_FLAG;
});

describe('api key hashing primitives', () => {
  it('hashes to sha256 hex and is stable', () => {
    const raw = 'lgnx_sup_example';
    const expected = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    expect(hashApiKey(raw)).toBe(expected);
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).toHaveLength(64);
  });

  it('mints unpredictable keys, not Math.random output', () => {
    const keys = new Set();
    for (let i = 0; i < 200; i += 1) keys.add(mintApiKey('supplier'));
    // No collisions across 200 mints.
    expect(keys.size).toBe(200);

    const one = mintApiKey('supplier');
    expect(one.startsWith('lgnx_sup_')).toBe(true);
    expect(mintApiKey('master').startsWith('lgnx_mst_')).toBe(true);

    // The random segment must be long enough to be unguessable. 24 bytes
    // base64url is 32 characters.
    expect(one.slice('lgnx_sup_'.length)).toHaveLength(32);
  });

  it('derives the stored shape without the raw value', () => {
    const raw = mintApiKey('supplier');
    const stored = storedFieldsFor(raw);
    expect(stored).toEqual({ key_hash: hashApiKey(raw), key_prefix: keyPrefixOf(raw) });
    expect(Object.values(stored)).not.toContain(raw);
    expect(JSON.stringify(stored)).not.toContain(raw);
  });
});

describe('resolveApiKey', () => {
  it('resolves by hash without any cleartext present', async () => {
    const raw = mintApiKey('supplier');
    const db = makeDb([{ id: 'k1', active: true, ...storedFieldsFor(raw) }]);

    const { record, matchedBy, backfilled } = await resolveApiKey(db, raw);
    expect(record?.id).toBe('k1');
    expect(matchedBy).toBe('hash');
    expect(backfilled).toBe(false);
    expect(record.key).toBeUndefined();
  });

  it('rejects a key that is not stored', async () => {
    const db = makeDb([{ id: 'k1', active: true, ...storedFieldsFor(mintApiKey('supplier')) }]);
    const { record, matchedBy } = await resolveApiKey(db, mintApiKey('supplier'));
    expect(record).toBeNull();
    expect(matchedBy).toBeNull();
  });

  it('rejects an empty or missing key without touching the store', async () => {
    const db = makeDb([{ id: 'k1', active: true, ...storedFieldsFor('x') }]);
    for (const value of ['', '   ', null, undefined]) {
      const { record } = await resolveApiKey(db, value);
      expect(record).toBeNull();
    }
    expect(db.__updates).toHaveLength(0);
  });

  it('falls back to legacy cleartext and backfills the hash on the way through', async () => {
    const raw = 'legacy_plaintext_key';
    const db = makeDb([{ id: 'k1', active: true, key: raw, key_prefix: 'legacy_plaintex' }]);

    const first = await resolveApiKey(db, raw);
    expect(first.record?.id).toBe('k1');
    expect(first.matchedBy).toBe('cleartext');
    expect(first.backfilled).toBe(true);
    expect(db.__updates).toEqual([{ id: 'k1', patch: { key_hash: hashApiKey(raw) } }]);

    // Second presentation of the same key now takes the hash path.
    const second = await resolveApiKey(db, raw);
    expect(second.matchedBy).toBe('hash');
    expect(db.__updates).toHaveLength(1);
  });

  it('does not delete the cleartext column while backfilling', async () => {
    const raw = 'legacy_plaintext_key';
    const db = makeDb([{ id: 'k1', active: true, key: raw }]);
    await resolveApiKey(db, raw);
    expect(db.__rows[0].key).toBe(raw);
  });

  it('survives a failed backfill and still authenticates the request', async () => {
    const raw = 'legacy_plaintext_key';
    const db = makeDb([{ id: 'k1', active: true, key: raw }]);
    db.entities.ApiKey.update = async () => { throw new Error('read only replica'); };

    const { record, matchedBy, backfilled } = await resolveApiKey(db, raw);
    expect(record?.id).toBe('k1');
    expect(matchedBy).toBe('cleartext');
    expect(backfilled).toBe(false);
  });

  it('refuses a cleartext-only row once the legacy fallback is switched off', async () => {
    const raw = 'legacy_plaintext_key';
    const db = makeDb([{ id: 'k1', active: true, key: raw }]);

    process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT = '0';
    expect(legacyCleartextEnabled()).toBe(false);

    const { record, matchedBy } = await resolveApiKey(db, raw);
    expect(record).toBeNull();
    expect(matchedBy).toBeNull();
  });

  it('still resolves a backfilled row once the legacy fallback is switched off', async () => {
    const raw = 'legacy_plaintext_key';
    const db = makeDb([{ id: 'k1', active: true, key: raw, key_hash: hashApiKey(raw) }]);

    process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT = '0';
    const { record, matchedBy } = await resolveApiKey(db, raw);
    expect(record?.id).toBe('k1');
    expect(matchedBy).toBe('hash');
  });

  it('defaults the legacy fallback to enabled so an un-backfilled row is not locked out', () => {
    delete process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT;
    expect(legacyCleartextEnabled()).toBe(true);
    process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT = '';
    expect(legacyCleartextEnabled()).toBe(true);
    for (const off of ['0', 'false', 'no', 'NO', ' False ']) {
      process.env.DASHFLO_APIKEY_LEGACY_CLEARTEXT = off;
      expect(legacyCleartextEnabled()).toBe(false);
    }
  });
});

describe('resolveActiveApiKey', () => {
  it('returns the record for an active key', async () => {
    const raw = mintApiKey('supplier');
    const db = makeDb([{ id: 'k1', active: true, ...storedFieldsFor(raw) }]);
    const record = await resolveActiveApiKey(db, raw);
    expect(record?.id).toBe('k1');
  });

  it('returns null for a known but disabled key', async () => {
    const raw = mintApiKey('supplier');
    const db = makeDb([{ id: 'k1', active: false, ...storedFieldsFor(raw) }]);
    expect(await resolveActiveApiKey(db, raw)).toBeNull();
  });

  it('treats a missing active flag as active, matching the previous behaviour', async () => {
    const raw = mintApiKey('supplier');
    const db = makeDb([{ id: 'k1', ...storedFieldsFor(raw) }]);
    expect((await resolveActiveApiKey(db, raw))?.id).toBe('k1');
  });
});
