import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashApiKey } from '../src/lib/apiKeys.js';

// Task S4, closing a loop the data refresh kept reopening.
//
// The Base44 source app has no key_hash field. A --truncate import replaces the
// whole JSONB blob, so every refresh handed back an ApiKey table that was
// cleartext only with no hashes, silently reverting the S4 migration. It was
// invisible because authentication still worked: the resolver falls back to
// cleartext, so nothing broke, it just quietly stopped being hash based until
// somebody re-ran the backfill.
//
// The importer now derives key_hash from the cleartext it already has, which is
// the same additive migration the backfill script performs.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORTER = path.resolve(HERE, '../../sync/import-data.mjs');

describe('the importer derives key_hash so a refresh cannot revert S4', () => {
  const src = fs.readFileSync(IMPORTER, 'utf8');

  it('imports the hashing function rather than reimplementing it', () => {
    // Deriving the hash a second way is how the two drift apart and every key
    // silently stops resolving.
    expect(src).toContain("from '../server/src/lib/apiKeys.js'");
    expect(src).toContain('hashApiKey');
  });

  it('applies the derivation on the ApiKey entity', () => {
    expect(src).toContain('applyDerivedSecretFields');
    expect(src).toContain("entityName !== 'ApiKey'");
  });

  it('never deletes the cleartext key, because purging is a separate step', () => {
    expect(src).not.toMatch(/delete\s+data\.key\b/);
    expect(src).not.toMatch(/data\.key\s*=\s*(null|undefined|'')/);
  });
});

// The derivation itself, exercised directly. Copied out of the importer rather
// than imported because import-data.mjs runs main() on load and would open a
// database connection during collection.
function applyDerivedSecretFields(entityName, data) {
  if (entityName !== 'ApiKey') return data;
  const cleartext = typeof data.key === 'string' ? data.key.trim() : '';
  if (!cleartext) return data;
  if (typeof data.key_hash === 'string' && data.key_hash.trim()) return data;
  return { ...data, key_hash: hashApiKey(cleartext) };
}

describe('the derivation itself', () => {
  it('adds a hash that matches the resolver, so an imported key authenticates', () => {
    const out = applyDerivedSecretFields('ApiKey', { key: 'lgnx_sup_example', name: 'Acme' });
    expect(out.key_hash).toBe(hashApiKey('lgnx_sup_example'));
    expect(out.key_hash).toHaveLength(64);
  });

  it('keeps the cleartext, so the fallback path still works during transition', () => {
    const out = applyDerivedSecretFields('ApiKey', { key: 'lgnx_sup_example' });
    expect(out.key).toBe('lgnx_sup_example');
  });

  it('does not overwrite a hash the source already carries', () => {
    const out = applyDerivedSecretFields('ApiKey', { key: 'lgnx_sup_example', key_hash: 'preexisting' });
    expect(out.key_hash).toBe('preexisting');
  });

  it('leaves a row with no cleartext alone rather than hashing an empty string', () => {
    // hashApiKey('') returns a real, constant digest. Writing it would make
    // every keyless row share one hash and collide with each other.
    const out = applyDerivedSecretFields('ApiKey', { name: 'no key here' });
    expect(out.key_hash).toBeUndefined();
    const blank = applyDerivedSecretFields('ApiKey', { key: '   ' });
    expect(blank.key_hash).toBeUndefined();
  });

  it('touches no other entity', () => {
    const connector = { name: 'Meta', fb_access_token: 'token-value' };
    expect(applyDerivedSecretFields('ApiConnector', connector)).toEqual(connector);
    const lead = { key: 'not-an-api-key' };
    expect(applyDerivedSecretFields('Lead', lead)).toEqual(lead);
  });

  it('is idempotent, so repeated refreshes converge rather than churn', () => {
    const once = applyDerivedSecretFields('ApiKey', { key: 'lgnx_sup_example' });
    const twice = applyDerivedSecretFields('ApiKey', once);
    expect(twice).toEqual(once);
  });
});
