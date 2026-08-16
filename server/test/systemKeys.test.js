import { describe, it, expect, vi } from 'vitest';
import systemKeys from '../src/functions/systemKeys.js';
import { resolveMetaAppCreds } from '../src/lib/metaAppCreds.js';

const response = (body, status = 200) => ({ __httpResponse: true, body, status });

function context({ user, db, body = {}, env = {} }) {
  return { user, db, body, env, json: response };
}

const OWNER = { id: 'owner-1', email: 'owner@example.test', base_role: 'owner', role: 'admin' };
const ADMIN = { id: 'admin-1', email: 'admin@example.test', base_role: 'admin', role: 'admin' };

describe('System Keys authority', () => {
  it('keeps system credential operations owner only', async () => {
    const db = { entities: {} };
    const out = await systemKeys(context({ user: ADMIN, db, body: { op: 'system_list' } }));
    expect(out.status).toBe(403);
  });

  it('never returns a raw system credential', async () => {
    const db = {
      entities: {
        SystemKey: { list: vi.fn().mockResolvedValue([{ id: 's1', name: 'Provider', provider: 'other', secret: 'never-return-this', key_prefix: 'never-re', active: true }]) },
      },
    };
    const out = await systemKeys(context({ user: OWNER, db, body: { op: 'system_list' } }));
    expect(out.keys[0].secret).toBeUndefined();
    expect(out.keys[0].key_prefix).toBeUndefined();
    expect(out.keys[0].secret_masked).not.toContain('never-return-this');
    expect(out.keys[0].secret_set).toBe(true);
  });

  it('saves Meta credentials only to SystemKey and audits without the value', async () => {
    const created = [];
    const audits = [];
    const db = {
      entities: {
        SystemKey: {
          filter: vi.fn().mockResolvedValue([]),
          create: vi.fn(async (row) => { created.push(row); return { id: 'meta-1', ...row }; }),
          get: vi.fn(),
          update: vi.fn(),
        },
        IntegrationConfig: { filter: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() },
        KeyAuditEvent: { create: vi.fn(async (row) => { audits.push(row); return row; }) },
      },
    };
    const out = await systemKeys(context({
      user: OWNER,
      db,
      body: { op: 'system_meta_save', app_id: 'public-app-id', app_secret: 'durable-meta-secret' },
    }));

    expect(out.success).toBe(true);
    expect(created[0].provider).toBe('meta');
    expect(created[0].client_id).toBe('public-app-id');
    expect(created[0].secret).toBe('durable-meta-secret');
    expect(db.entities.IntegrationConfig.create).not.toHaveBeenCalled();
    expect(db.entities.IntegrationConfig.update).not.toHaveBeenCalled();
    expect(JSON.stringify(audits)).not.toContain('durable-meta-secret');
    expect(JSON.stringify(out)).not.toContain('durable-meta-secret');
  });
});

describe('Meta credential resolution', () => {
  it('prefers the authoritative SystemKey over legacy and environment copies', async () => {
    const db = {
      entities: {
        SystemKey: { filter: vi.fn().mockResolvedValue([{ id: 's1', provider: 'meta', active: true, client_id: 'system-id', secret: 'system-secret' }]) },
        IntegrationConfig: { filter: vi.fn().mockResolvedValue([{ config: '{"app_id":"legacy-id","app_secret":"legacy-secret"}' }]) },
      },
    };
    const out = await resolveMetaAppCreds(db, { META_APP_ID: 'env-id', META_APP_SECRET: 'env-secret' });
    expect(out).toMatchObject({ appId: 'system-id', appSecret: 'system-secret', source: 'system_key', configured: true });
    expect(db.entities.IntegrationConfig.filter).not.toHaveBeenCalled();
  });

  it('keeps the legacy location read only as a compatibility fallback', async () => {
    const db = {
      entities: {
        SystemKey: { filter: vi.fn().mockResolvedValue([]) },
        IntegrationConfig: { filter: vi.fn().mockResolvedValue([{ config: '{"app_id":"legacy-id","app_secret":"legacy-secret"}' }]) },
      },
    };
    const out = await resolveMetaAppCreds(db, {});
    expect(out).toMatchObject({ appId: 'legacy-id', appSecret: 'legacy-secret', source: 'legacy_read_only', configured: true });
  });
});
