import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isProtectedPlaceholder,
  mergeOrdinarySecrets,
  normalizeMigrationBundle,
  prepareMigrationRecord,
  NAMESPACE_MIGRATED_FIELD,
} from '../src/lib/migrationImport.js';
import {
  ENTITY_ORDER,
  MIGRATION_CRYPTO,
  MIGRATION_ENTITY_ORDER,
  MIGRATION_ONLY_ENTITIES,
} from '../src/functions/systemTransfer.generated.js';
import { hashApiKey, keyPrefixOf, translateCredentialNamespace } from '../src/lib/apiKeys.js';

const PASSPHRASE = 'correct horse battery staple';

function seal(payload, key, iv = crypto.randomBytes(MIGRATION_CRYPTO.iv_bytes)) {
  const plaintext = Buffer.from(JSON.stringify(payload));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
    records: payload.records.length,
  };
}

function ownerBundle() {
  const salt = crypto.randomBytes(MIGRATION_CRYPTO.salt_bytes);
  const key = crypto.pbkdf2Sync(PASSPHRASE, salt, MIGRATION_CRYPTO.iterations, 32, 'sha256');
  const records = [{
    id: 'supplier-key-1',
    supplier_id: 'supplier-1',
    key: 'lgnx_sup_existing-production-value',
    active: true,
    created_date: '2026-08-01T00:00:00.000Z',
    updated_date: '2026-08-02T00:00:00.000Z',
  }];
  const sealed = seal({ entity: 'ApiKey', offset: 0, records }, key);
  return {
    format: MIGRATION_CRYPTO.format,
    source_app: 'legenex-dashboard',
    target: 'dashflo',
    exported_at: '2026-08-16T12:00:00.000Z',
    crypto: { ...MIGRATION_CRYPTO, salt: salt.toString('base64') },
    counts: Object.fromEntries(MIGRATION_ENTITY_ORDER.map((name) => [name, name === 'ApiKey' ? 1 : 0])),
    chunks: [{ entity: 'ApiKey', offset: 0, ...sealed }],
  };
}

describe('Base44 owner migration package compatibility', () => {
  it('uses the exact 93-entity Base44 catalog', () => {
    expect(ENTITY_ORDER).toHaveLength(90);
    expect(MIGRATION_ENTITY_ORDER).toHaveLength(93);
    expect(MIGRATION_ONLY_ENTITIES).toEqual(['SystemKey', 'BuyerApiKey', 'KeyAuditEvent']);
  });

  it('decrypts the real Base44 per-chunk AES-GCM transport shape', () => {
    const normalized = normalizeMigrationBundle({ kind: 'owner', bundle: ownerBundle(), passphrase: PASSPHRASE });
    expect(normalized.packageVersion).toBe('legenex-migration-v1');
    expect(normalized.entities.ApiKey[0]).toMatchObject({ id: 'supplier-key-1', supplier_id: 'supplier-1' });
    expect(Object.keys(normalized.entities)).toHaveLength(93);
  });

  it('rejects a wrong passphrase without exposing ciphertext or credentials', () => {
    expect(() => normalizeMigrationBundle({ kind: 'owner', bundle: ownerBundle(), passphrase: 'wrong-passphrase-long' }))
      .toThrow('Could not decrypt migration package');
  });

  it('derives the supplier authentication hash and does not retain cleartext', () => {
    const raw = 'lgnx_sup_existing-production-value';
    const dashflo = translateCredentialNamespace(raw);
    const prepared = prepareMigrationRecord('owner', 'ApiKey', { id: 'k1', key: raw, active: true });

    // The credential is stored in the DashFlo namespace, not the Base44 one.
    // DashFlo is the canonical system, so its namespace wins on import.
    expect(prepared.data.key_hash).toBe(hashApiKey(dashflo));
    expect(prepared.data.key_hash).not.toBe(hashApiKey(raw));
    expect(prepared.data.key_prefix).toBe(keyPrefixOf(dashflo));
    expect(prepared.data.key_prefix.startsWith('dshflo_sup_')).toBe(true);
    expect(prepared.data).not.toHaveProperty('key');
    expect(prepared.namespaceMigrated).toBe(true);

    // The old Legenex value is not recoverable from what was stored.
    expect(JSON.stringify(prepared.data)).not.toContain(raw);
  });

  it('reruns the same credential without rotating or restamping it', () => {
    const raw = 'lgnx_sup_existing-production-value';
    const source = { id: 'k1', key: raw, active: true, updated_date: '2026-08-17T12:00:00.000Z' };
    const first = prepareMigrationRecord('owner', 'ApiKey', source);
    const second = prepareMigrationRecord('owner', 'ApiKey', source, first.data);

    // Byte identical on the second run, which is what makes the record
    // compare equal and be preserved rather than updated.
    expect(second.data).toEqual(first.data);
    expect(second.data.key_hash).toBe(first.data.key_hash);
    expect(second.data[NAMESPACE_MIGRATED_FIELD]).toBe(first.data[NAMESPACE_MIGRATED_FIELD]);

    // A record that already arrived in the DashFlo namespace is left alone.
    const already = prepareMigrationRecord('owner', 'ApiKey', { id: 'k2', key: translateCredentialNamespace(raw) });
    expect(already.data.key_hash).toBe(first.data.key_hash);
    expect(already.namespaceMigrated).toBe(false);
  });

  it('drops passwords, sessions, refresh tokens, invite tokens and OAuth state', () => {
    const user = prepareMigrationRecord('owner', 'User', {
      id: 'u1', email: 'owner@example.test', password: 'no', password_hash: 'no', session_token: 'no', refresh_token: 'no',
    });
    expect(user.data).toEqual({ email: 'owner@example.test' });
    expect(prepareMigrationRecord('owner', 'Invitation', { id: 'i1', email: 'x@example.test', token: 'no' }).data)
      .toEqual({ email: 'x@example.test' });
    expect(prepareMigrationRecord('owner', 'IntegrationConfig', { id: 's1', name: 'meta_oauth_state', config: 'no' })).toBeNull();
  });
});

describe('ordinary export credential protection', () => {
  it('recognizes all destructive placeholder forms', () => {
    for (const value of ['__REDACTED__', '', 'masked', 'placeholder', '********', '••••••••', null, undefined]) {
      expect(isProtectedPlaceholder(value), String(value)).toBe(true);
    }
  });

  it('preserves raw and structured durable credentials while accepting non-secret changes', () => {
    const existing = {
      fb_access_token: 'durable-token',
      headers: JSON.stringify({ Authorization: 'Bearer durable', 'Content-Type': 'application/json' }),
      target_url: 'https://example.test/post?api_key=durable&mode=old',
    };
    const incoming = {
      fb_access_token: '__REDACTED__',
      headers: JSON.stringify({ Authorization: '__REDACTED__', 'Content-Type': 'text/plain' }),
      target_url: '__REDACTED__',
      name: 'updated connector',
    };
    const { record, preserved } = mergeOrdinarySecrets('ApiConnector', incoming, existing);
    expect(preserved).toBe(true);
    expect(record.fb_access_token).toBe(existing.fb_access_token);
    expect(JSON.parse(record.headers)).toEqual({ Authorization: 'Bearer durable', 'Content-Type': 'text/plain' });
    expect(record.target_url).toBe(existing.target_url);
    expect(record.name).toBe('updated connector');
  });

  it('never replaces supplier, buyer, Meta or connector secrets with missing values', () => {
    const cases = [
      ['ApiKey', {}, { key_hash: 'existing-hash', key_prefix: 'lgnx_sup_existing' }, 'key_hash'],
      ['Buyer', { buyer_api_key: '' }, { buyer_api_key: 'buyer-live' }, 'buyer_api_key'],
      ['MetaConnection', {}, { token: 'meta-live' }, 'token'],
      ['PullSource', { api_key: null }, { api_key: 'pull-live' }, 'api_key'],
      ['Webhook', { secret: 'masked' }, { secret: 'webhook-live' }, 'secret'],
    ];
    for (const [entity, incoming, existing, field] of cases) {
      const prepared = prepareMigrationRecord('ordinary', entity, { id: 'r1', ...incoming }, existing);
      expect(prepared.data[field], `${entity}.${field}`).toBe(existing[field]);
    }
  });
});
