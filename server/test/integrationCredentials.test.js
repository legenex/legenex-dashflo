import { describe, it, expect } from 'vitest';

import {
  isSecretKey,
  parseConfig,
  mergeConfig,
  projectConfig,
} from '../src/lib/integrationConfig.js';
import saveIntegrationConfig from '../src/functions/saveIntegrationConfig.js';
import integrationConfigStatus from '../src/functions/integrationConfigStatus.js';

// Task S4. The defect being closed here is concrete: every settings dialog read
// IntegrationConfig.config, got {} because the field is read-denied, merged the
// operator's two typed fields over that empty object, and wrote the result
// back, destroying every stored credential the form did not know about.

function makeCtx({ user, body, rows = [] }) {
  const store = rows.map((r) => ({ ...r }));
  const writes = [];
  let response = null;
  return {
    __store: store,
    __writes: writes,
    get __response() { return response; },
    user,
    body,
    json: (payload, status = 200) => { response = { payload, status }; return response; },
    db: {
      entities: {
        IntegrationConfig: {
          filter: async (query) => {
            const [[field, value]] = Object.entries(query);
            return store.filter((r) => r[field] === value).map((r) => ({ ...r }));
          },
          update: async (id, patch) => {
            writes.push({ op: 'update', id, patch });
            const row = store.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return row;
          },
          create: async (rec) => {
            writes.push({ op: 'create', rec });
            const row = { id: 'new1', ...rec };
            store.push(row);
            return row;
          },
        },
      },
    },
  };
}

const OWNER = { id: 'u1', base_role: 'owner' };
const MANAGER = { id: 'u3', base_role: 'manager' };
const BUYER_PORTAL = { id: 'u4', base_role: 'buyer', linked_buyer_id: 'b1' };

describe('secret classification', () => {
  it('treats credential shaped names as secret', () => {
    for (const k of ['api_token', 'secret_key', 'access_token', 'apiKey', 'app_secret',
      'bot_token', 'client_secret', 'refresh_token', 'password', 'private_key']) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  it('does not treat identifiers or timestamps as secret', () => {
    for (const k of ['account_id', 'tenant_id', 'app_id', 'client_id', 'phone_number_id',
      'last_synced_at', 'token_expires_at', 'categories', 'accounts']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe('parseConfig', () => {
  it('reads a stored JSON string', () => {
    expect(parseConfig('{"a":1}')).toEqual({ config: { a: 1 }, corrupt: false });
  });

  it('reports corruption instead of throwing', () => {
    expect(parseConfig('not json')).toEqual({ config: {}, corrupt: true });
    expect(parseConfig('[1,2]')).toEqual({ config: {}, corrupt: true });
  });

  it('treats absent as empty and not corrupt', () => {
    for (const v of [null, undefined, '']) {
      expect(parseConfig(v)).toEqual({ config: {}, corrupt: false });
    }
  });
});

describe('mergeConfig, the partial update contract', () => {
  const stored = { api_token: 'LIVE', account_id: 'acct_1', last_synced_at: '2026-08-01' };

  it('preserves every stored key the update does not mention', () => {
    const next = mergeConfig(stored, { account_id: 'acct_2' });
    expect(next).toEqual({ api_token: 'LIVE', account_id: 'acct_2', last_synced_at: '2026-08-01' });
  });

  it('keeps the stored secret when the field is submitted blank', () => {
    const next = mergeConfig(stored, { api_token: '', account_id: 'acct_2' });
    expect(next.api_token).toBe('LIVE');
    expect(next.account_id).toBe('acct_2');
  });

  it('replaces a value that is actually supplied', () => {
    expect(mergeConfig(stored, { api_token: 'ROTATED' }).api_token).toBe('ROTATED');
  });

  it('removes a key only when it is explicitly cleared', () => {
    const next = mergeConfig(stored, {}, { clear: ['api_token'] });
    expect('api_token' in next).toBe(false);
    expect(next.account_id).toBe('acct_1');
  });

  it('can be told to treat blank as a real value', () => {
    const next = mergeConfig(stored, { account_id: '' }, { omitBlank: false });
    expect(next.account_id).toBe('');
    expect(next.api_token).toBe('LIVE');
  });

  it('does not mutate the stored object', () => {
    const frozen = { ...stored };
    mergeConfig(stored, { api_token: 'ROTATED' }, { clear: ['account_id'] });
    expect(stored).toEqual(frozen);
  });

  it('ignores a non-object values payload rather than wiping the blob', () => {
    for (const bad of [null, undefined, 'string', 42, ['a']]) {
      expect(mergeConfig(stored, bad)).toEqual(stored);
    }
  });
});

describe('projectConfig', () => {
  it('returns settings by value and secrets by presence only', () => {
    const out = projectConfig({ api_token: 'LIVE', account_id: 'acct_1', last_synced_at: 'x' });
    expect(out.values).toEqual({ account_id: 'acct_1', last_synced_at: 'x' });
    expect(out.secrets).toEqual({ api_token: { set: true } });
    expect(JSON.stringify(out)).not.toContain('LIVE');
  });

  it('reports an empty secret as not set', () => {
    expect(projectConfig({ api_token: '' }).secrets.api_token).toEqual({ set: false });
  });
});

describe('saveIntegrationConfig', () => {
  it('merges a partial update over the real stored blob', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury', values: { account_id: 'acct_2' } },
      rows: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE","account_id":"acct_1"}' }],
    });

    const res = await saveIntegrationConfig(ctx);
    expect(res.status).toBe(200);

    const written = JSON.parse(ctx.__writes[0].patch.config);
    expect(written).toEqual({ api_token: 'LIVE', account_id: 'acct_2' });
  });

  it('never returns a secret value to the caller', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury', values: { account_id: 'acct_2' } },
      rows: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE","account_id":"acct_1"}' }],
    });

    const res = await saveIntegrationConfig(ctx);
    expect(JSON.stringify(res.payload)).not.toContain('LIVE');
    expect(res.payload.secrets).toEqual({ api_token: { set: true } });
    expect(res.payload.values).toEqual({ account_id: 'acct_2' });
  });

  it('is the regression guard for the blank-save data loss', async () => {
    // Exactly the old dialog behaviour: it loaded nothing, the operator typed
    // only the account id, and it saved. Under the old code this persisted
    // {"account_id":"acct_2"} and the token was gone.
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury', values: { api_token: '', account_id: 'acct_2' } },
      rows: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE","account_id":"acct_1"}' }],
    });

    await saveIntegrationConfig(ctx);
    expect(JSON.parse(ctx.__writes[0].patch.config).api_token).toBe('LIVE');
  });

  it('creates the row when the integration is new', async () => {
    const ctx = makeCtx({ user: OWNER, body: { name: 'slack', values: { bot_token: 'xoxb' } }, rows: [] });
    const res = await saveIntegrationConfig(ctx);
    expect(res.status).toBe(200);
    expect(ctx.__writes[0].op).toBe('create');
    expect(JSON.parse(ctx.__writes[0].rec.config)).toEqual({ bot_token: 'xoxb' });
  });

  it('reports a corrupt stored blob rather than silently starting from empty', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury', values: { account_id: 'acct_2' } },
      rows: [{ id: 'i1', name: 'mercury', config: 'not json at all' }],
    });
    const res = await saveIntegrationConfig(ctx);
    expect(res.payload.stored_config_was_corrupt).toBe(true);
  });

  it('refuses a manager, matching the adminOnly entity policy', async () => {
    const ctx = makeCtx({ user: MANAGER, body: { name: 'mercury', values: {} }, rows: [] });
    const res = await saveIntegrationConfig(ctx);
    expect(res.status).toBe(403);
    expect(ctx.__writes).toHaveLength(0);
  });

  it('refuses a portal account', async () => {
    const ctx = makeCtx({ user: BUYER_PORTAL, body: { name: 'mercury', values: {} }, rows: [] });
    expect((await saveIntegrationConfig(ctx)).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const ctx = makeCtx({ user: null, body: { name: 'mercury', values: {} }, rows: [] });
    expect((await saveIntegrationConfig(ctx)).status).toBe(403);
  });

  it('rejects a values payload that is not an object instead of wiping the blob', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury', values: 'oops' },
      rows: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE"}' }],
    });
    const res = await saveIntegrationConfig(ctx);
    expect(res.status).toBe(400);
    expect(ctx.__writes).toHaveLength(0);
  });
});

describe('integrationConfigStatus', () => {
  it('returns non-secret settings and secret presence, never a secret value', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { name: 'mercury' },
      rows: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE","account_id":"acct_1"}' }],
    });

    const res = await integrationConfigStatus(ctx);
    expect(res.status).toBe(200);
    const mercury = res.payload.integrations.mercury;
    expect(mercury.exists).toBe(true);
    expect(mercury.values).toEqual({ account_id: 'acct_1' });
    expect(mercury.secrets).toEqual({ api_token: { set: true } });
    expect(JSON.stringify(res.payload)).not.toContain('LIVE');
  });

  it('reports a missing integration without inventing one', async () => {
    const ctx = makeCtx({ user: OWNER, body: { name: 'stripe' }, rows: [] });
    const res = await integrationConfigStatus(ctx);
    expect(res.payload.integrations.stripe).toEqual({
      exists: false, id: null, values: {}, secrets: {}, keys: [],
    });
  });

  it('reads several integrations in one call', async () => {
    const ctx = makeCtx({
      user: OWNER,
      body: { names: ['mercury', 'stripe'] },
      rows: [{ id: 'i1', name: 'mercury', config: '{"account_id":"a"}' }],
    });
    const res = await integrationConfigStatus(ctx);
    expect(Object.keys(res.payload.integrations)).toEqual(['mercury', 'stripe']);
  });

  it('refuses a manager and a portal account', async () => {
    for (const user of [MANAGER, BUYER_PORTAL, null]) {
      const ctx = makeCtx({ user, body: { name: 'mercury' }, rows: [] });
      expect((await integrationConfigStatus(ctx)).status).toBe(403);
    }
  });
});
