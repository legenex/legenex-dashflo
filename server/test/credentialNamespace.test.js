// The DashFlo credential namespace.
//
// Two things are pinned here. The first is that every generator in the
// repository produces a `dshflo_` value. The second is that the legacy Legenex
// namespace can be translated deterministically, which is what makes the
// Base44 import idempotent: converting the same value twice produces the same
// key and therefore the same hash and the same stored row.
//
// The scan at the bottom is the one that matters most. A unit test on
// mintApiKey only proves the generator it imports; the scan proves that no
// second generator has been added somewhere else with its own hardcoded
// prefix, which is exactly how the buyer key ended up in a different namespace
// from the supplier key before this change.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEY_TAGS,
  KEY_NAMESPACE,
  hashApiKey,
  mintApiKey,
  keyPrefixOf,
  isDashfloNamespace,
  isLegacyNamespace,
  translateCredentialNamespace,
} from '../src/lib/apiKeys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

describe('DashFlo credential namespace', () => {
  it('every key type mints under one dshflo namespace', () => {
    for (const [type, tag] of Object.entries(KEY_TAGS)) {
      const key = mintApiKey(type);
      expect(key.startsWith(KEY_NAMESPACE), type).toBe(true);
      expect(key.startsWith(tag), type).toBe(true);
      expect(isDashfloNamespace(key), type).toBe(true);
      expect(isLegacyNamespace(key), type).toBe(true === false);
    }
  });

  it('never mints a legacy value, for any type name including unknown ones', () => {
    const types = [...Object.keys(KEY_TAGS), 'unknown', '', null, undefined];
    for (const type of types) {
      expect(mintApiKey(type).startsWith('lgnx_'), String(type)).toBe(false);
      expect(mintApiKey(type).startsWith(KEY_NAMESPACE), String(type)).toBe(true);
    }
  });

  it('keeps the displayed prefix bounded and type-revealing', () => {
    const key = mintApiKey('supplier');
    const prefix = keyPrefixOf(key);
    expect(prefix).toHaveLength(16);
    expect(prefix.startsWith('dshflo_sup_')).toBe(true);
    // The prefix is a display aid, not half the credential.
    expect(prefix.length).toBeLessThan(key.length / 2);
  });
});

describe('legacy namespace translation', () => {
  it('maps each legacy tag onto its DashFlo equivalent and keeps the secret material', () => {
    const cases = [
      ['lgnx_mst_AbC123', 'dshflo_mst_AbC123'],
      ['lgnx_sup_AbC123', 'dshflo_sup_AbC123'],
      ['lgnx_byr_AbC123', 'dshflo_byr_AbC123'],
      ['lgnx_ext_AbC123', 'dshflo_ext_AbC123'],
      ['lgnx_AbC123', 'dshflo_AbC123'],
    ];
    for (const [from, to] of cases) {
      expect(translateCredentialNamespace(from), from).toBe(to);
    }
  });

  it('is idempotent, which is what makes a rerun of the import a no-op', () => {
    const once = translateCredentialNamespace('lgnx_mst_secret-material');
    const twice = translateCredentialNamespace(once);
    const thrice = translateCredentialNamespace(twice);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    // The hash is what gets stored, so idempotent translation means an
    // idempotent stored row.
    expect(hashApiKey(twice)).toBe(hashApiKey(once));
    expect(keyPrefixOf(twice)).toBe(keyPrefixOf(once));
  });

  it('leaves values that are not legacy credentials alone', () => {
    for (const value of ['dshflo_sup_x', 'sk-live-abc', '', 'lgnxsomething', 'LGNX-DS']) {
      expect(translateCredentialNamespace(value), value).toBe(value);
    }
  });

  it('does not touch the LGNX supplier identifier, which is business data', () => {
    // LGNX is the house supplier SID in webhook.js and backfillLeadType.js. It
    // is not a credential and must survive the namespace change untouched.
    expect(translateCredentialNamespace('LGNX')).toBe('LGNX');
    expect(translateCredentialNamespace('LGNX-CMC')).toBe('LGNX-CMC');
    expect(isLegacyNamespace('LGNX-DS')).toBe(false);
  });
});

describe('no generator anywhere mints the legacy namespace', () => {
  // Walk the executable source and fail on any string literal that would
  // produce a `lgnx_` credential. Tests and documentation are excluded because
  // they legitimately name the old value while describing the migration.
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test', 'docs']);

  function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        sourceFiles(full, out);
      } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('has no lgnx_ credential literal in client or server source', () => {
    const offenders = [];
    for (const file of [
      ...sourceFiles(path.join(REPO, 'server/src')),
      ...sourceFiles(path.join(REPO, 'client/src')),
    ]) {
      // The translation table in apiKeys.js is the one place the old tags are
      // allowed to appear in code, because migrating away from them is its job.
      if (file.endsWith('lib/apiKeys.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [index, raw] of text.split('\n').entries()) {
        // Prose about the migration is expected and is not a credential. Only
        // executable string literals count, so line comments are stripped
        // before the check.
        const line = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/['"`]lgnx_/.test(line)) {
          offenders.push(`${path.relative(REPO, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
