import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertOwnerCrypto, MigrationValidationError } from '../src/lib/migrationImport.js';
import { MIGRATION_CRYPTO, MIGRATION_FORMAT } from '../src/functions/systemTransfer.generated.js';

/* The migration crypto envelope contract.
 *
 * The bug these cover: the importer demanded exact equality with a single
 * iteration constant, and that constant (600000) is not what the supported
 * exporter emits (100000). Every real owner package was refused at
 * "Unsupported migration crypto parameter: iterations" before a single chunk
 * was read, and because the same constant was also fed to pbkdf2, relaxing the
 * check alone would have derived the wrong key and failed a step later.
 *
 * So there are two things to hold here. Legitimate packages across the
 * supported iteration range are accepted AND the value they declare is what
 * comes back for derivation. Everything structural is still matched exactly,
 * and anything unrecognised is still refused.
 */

const SALT = crypto.randomBytes(MIGRATION_FORMAT.salt_bytes).toString('base64');

const envelope = (overrides = {}) => ({
  format: 'legenex-migration-v1',
  crypto: {
    format: 'legenex-migration-v1',
    kdf: 'PBKDF2-SHA256',
    iterations: 100000,
    cipher: 'AES-GCM',
    key_bits: 256,
    salt_bytes: 16,
    iv_bytes: 12,
    salt: SALT,
    ...overrides,
  },
});

const rejects = (bundle, match) => {
  expect(() => assertOwnerCrypto(bundle)).toThrow(MigrationValidationError);
  if (match) expect(() => assertOwnerCrypto(bundle)).toThrow(match);
};

describe('owner migration crypto envelope', () => {
  it('accepts the 100000 iteration package the supported exporter actually emits', () => {
    const result = assertOwnerCrypto(envelope());
    expect(result.iterations).toBe(100000);
    expect(result.salt).toHaveLength(MIGRATION_FORMAT.salt_bytes);
  });

  it('returns the package iteration count so the key is derived with it, not with the constant', () => {
    // This is the half that a naive "stop rejecting iterations" fix would miss.
    expect(assertOwnerCrypto(envelope({ iterations: 100000 })).iterations).toBe(100000);
    expect(assertOwnerCrypto(envelope({ iterations: 600000 })).iterations).toBe(600000);
    expect(MIGRATION_CRYPTO.iterations).toBe(600000);
  });

  it('accepts both ends of the supported iteration range', () => {
    expect(assertOwnerCrypto(envelope({ iterations: MIGRATION_FORMAT.iterations.min })).iterations)
      .toBe(MIGRATION_FORMAT.iterations.min);
    expect(assertOwnerCrypto(envelope({ iterations: MIGRATION_FORMAT.iterations.max })).iterations)
      .toBe(MIGRATION_FORMAT.iterations.max);
  });

  it('refuses a weakened work factor rather than deriving a cheap key', () => {
    rejects(envelope({ iterations: 1000 }), /weaker key derivation/i);
    rejects(envelope({ iterations: MIGRATION_FORMAT.iterations.min - 1 }), /weaker key derivation/i);
  });

  it('refuses an unbounded work factor rather than burning the server on one upload', () => {
    rejects(envelope({ iterations: MIGRATION_FORMAT.iterations.max + 1 }), /more key derivation work/i);
    rejects(envelope({ iterations: 5_000_000_000 }), /more key derivation work/i);
  });

  it('refuses an iteration count that is not a whole number', () => {
    for (const bad of ['100000', 100000.5, null, undefined, NaN, true, []]) {
      rejects(envelope({ iterations: bad }));
    }
  });

  it('refuses a different key derivation function', () => {
    rejects(envelope({ kdf: 'PBKDF2-SHA1' }), /crypto parameter: kdf/);
    rejects(envelope({ kdf: 'scrypt' }), /crypto parameter: kdf/);
  });

  it('refuses a different cipher', () => {
    rejects(envelope({ cipher: 'AES-CBC' }), /crypto parameter: cipher/);
    rejects(envelope({ cipher: 'AES-256-CTR' }), /crypto parameter: cipher/);
  });

  it('refuses a shorter key', () => {
    rejects(envelope({ key_bits: 128 }), /crypto parameter: key_bits/);
    rejects(envelope({ key_bits: 192 }), /crypto parameter: key_bits/);
  });

  it('refuses malformed salt and IV metadata', () => {
    rejects(envelope({ salt_bytes: 8 }), /crypto parameter: salt_bytes/);
    rejects(envelope({ iv_bytes: 16 }), /crypto parameter: iv_bytes/);
    rejects(envelope({ salt: crypto.randomBytes(8).toString('base64') }), /salt has the wrong length/i);
    rejects(envelope({ salt: 'not base64 !!' }), /not valid base64/i);
  });

  it('refuses an unsupported package format', () => {
    rejects({ ...envelope(), format: 'legenex-migration-v2' }, /Unsupported migration package format/);
    rejects({ ...envelope(), format: undefined }, /Unsupported migration package format/);
    rejects(envelope({ format: 'legenex-migration-v2' }), /crypto parameter: format/);
  });

  it('accepts a package whose outer format and crypto format agree', () => {
    // The mismatch branch guards a future second supported version: with one
    // format in the list, a disagreeing crypto.format is already unsupported and
    // is refused by the check above. This holds the agreeing case explicitly so
    // adding a version cannot quietly make agreement optional.
    const bundle = envelope();
    expect(bundle.format).toBe(bundle.crypto.format);
    expect(() => assertOwnerCrypto(bundle)).not.toThrow();
  });

  it('refuses an unrecognised crypto key instead of ignoring it', () => {
    // Fail closed: a validator that only checks fields it knows about would let
    // an unreviewed directive ride along untouched.
    rejects(envelope({ pepper: 'surprise' }), /crypto parameter: pepper/);
    rejects(envelope({ kdf_rounds: 1 }), /crypto parameter: kdf_rounds/);
  });

  it('refuses a crypto block missing a required parameter', () => {
    for (const key of MIGRATION_FORMAT.crypto_keys_required) {
      const bundle = envelope();
      delete bundle.crypto[key];
      rejects(bundle);
    }
  });

  it('refuses a package with no crypto block at all', () => {
    rejects({ format: 'legenex-migration-v1' });
    rejects({ format: 'legenex-migration-v1', crypto: {} });
  });
});

describe('migration format contract parity', () => {
  // scripts/generate-transfer-catalog.mjs, named in the generated file's header,
  // does not exist in this repository, so the client catalog and its server copy
  // are kept in step by hand. That is exactly the mechanism that lets a contract
  // drift, so the two copies are compared here rather than trusted.
  it('client source and generated server catalog declare the same contract', async () => {
    const client = await import('../../client/src/lib/systemTransfer.js');
    expect(client.MIGRATION_FORMAT).toEqual(MIGRATION_FORMAT);
    expect(client.MIGRATION_CRYPTO).toEqual(MIGRATION_CRYPTO);
  });

  it('the emitted spec stays inside the accepted policy', () => {
    expect(MIGRATION_FORMAT.formats).toContain(MIGRATION_CRYPTO.format);
    expect(MIGRATION_CRYPTO.kdf).toBe(MIGRATION_FORMAT.kdf);
    expect(MIGRATION_CRYPTO.cipher).toBe(MIGRATION_FORMAT.cipher);
    expect(MIGRATION_CRYPTO.key_bits).toBe(MIGRATION_FORMAT.key_bits);
    expect(MIGRATION_CRYPTO.iterations).toBeGreaterThanOrEqual(MIGRATION_FORMAT.iterations.min);
    expect(MIGRATION_CRYPTO.iterations).toBeLessThanOrEqual(MIGRATION_FORMAT.iterations.max);
  });
});
