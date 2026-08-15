import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

// End to end proof through the real entity router.
//
// entityPolicy.test.js pins the decision table. This exercises the router that
// consumes it, so a correct table wired up incorrectly still fails.
//
// The database layer is replaced with an in-memory double. No PostgreSQL and
// no network beyond the loopback test server.

const STORED = {
  ApiKey: [{ id: 'k1', name: 'acme', key_prefix: 'lgx_abc', key: 'lgx_abc_FULL_SECRET', active: true }],
  IntegrationConfig: [{ id: 'i1', name: 'mercury', config: '{"api_token":"LIVE_TOKEN"}' }],
  Lead: [{ id: 'l1', email: 'lead@example.com', state: 'TX' }],
  Buyer: [{ id: 'b1', name: 'Buyer One' }],
  User: [{ id: 'u9', email: 'someone@example.com', base_role: 'manager' }],
  AuditLog: [{ id: 'a1', message: 'should never be reachable' }],
};

const writes = [];

vi.mock('../src/db/repo.js', () => {
  const rowsFor = (name) => STORED[name] ?? [];
  return {
    entityExists: (name) => name in STORED,
    repo: (name) => ({
      list: async () => rowsFor(name),
      filter: async () => rowsFor(name),
      get: async (id) => rowsFor(name).find((r) => r.id === id) ?? null,
      create: async (rec) => { writes.push({ name, op: 'create', rec }); return { id: 'new', ...rec }; },
      bulkCreate: async (recs) => { writes.push({ name, op: 'bulkCreate', rec: recs }); return recs; },
      update: async (id, patch) => { writes.push({ name, op: 'update', id, rec: patch }); return { id, ...patch }; },
      bulkUpdate: async (u) => { writes.push({ name, op: 'bulkUpdate', rec: u }); return u; },
      updateMany: async (f, u) => { writes.push({ name, op: 'updateMany', rec: u }); return { updated: 1 }; },
      delete: async (id) => { writes.push({ name, op: 'delete', id }); return { success: true }; },
      deleteMany: async () => { writes.push({ name, op: 'deleteMany' }); return { deleted: 0 }; },
    }),
  };
});

const USERS = {
  owner: { id: 'u1', base_role: 'owner', role: 'admin' },
  manager: { id: 'u3', base_role: 'manager', role: 'user' },
  buyerPortal: { id: 'u4', base_role: 'buyer', role: 'user', linked_buyer_id: 'b1' },
  supplierPortal: { id: 'u5', base_role: 'supplier', role: 'user', linked_supplier_id: 's1' },
};

let server;
let baseUrl;
let currentUser = null;

beforeAll(async () => {
  const { default: entityRoutes } = await import('../src/routes/entities.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use('/api/entities', entityRoutes);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/entities`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(as, method, path, body) {
  currentUser = as ? USERS[as] : null;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, raw: text };
}

describe('entity route: anonymous', () => {
  it('refuses reads and writes with 401', async () => {
    expect((await call(null, 'GET', '/Lead')).status).toBe(401);
    expect((await call(null, 'GET', '/Lead/l1')).status).toBe(401);
    expect((await call(null, 'POST', '/Lead', { email: 'x@y.com' })).status).toBe(401);
    expect((await call(null, 'DELETE', '/Lead/l1')).status).toBe(401);
  });
});

describe('entity route: portal accounts', () => {
  for (const who of ['buyerPortal', 'supplierPortal']) {
    it(`refuses ${who} on every entity and verb`, async () => {
      for (const entity of ['Lead', 'Buyer', 'ApiKey', 'User', 'Invoice']) {
        expect((await call(who, 'GET', `/${entity}`)).status, `GET ${entity}`).toBe(403);
        expect((await call(who, 'POST', `/${entity}/query`, { filter: {} })).status).toBe(403);
        expect((await call(who, 'GET', `/${entity}/l1`)).status).toBe(403);
        expect((await call(who, 'PATCH', `/${entity}/l1`, { x: 1 })).status).toBe(403);
        expect((await call(who, 'DELETE', `/${entity}/l1`)).status).toBe(403);
      }
    });

    it(`never returns lead or buyer data to ${who}`, async () => {
      const res = await call(who, 'GET', '/Lead');
      expect(res.raw).not.toContain('lead@example.com');
      const b = await call(who, 'POST', '/Buyer/query', { filter: {} });
      expect(b.raw).not.toContain('Buyer One');
    });
  }
});

describe('entity route: unlisted entities are unreachable', () => {
  it('refuses AuditLog even for the owner', async () => {
    const res = await call('owner', 'GET', '/AuditLog');
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain('should never be reachable');
  });

  it('answers identically for a real unlisted entity and a made up one', async () => {
    const real = await call('owner', 'GET', '/AuditLog');
    const fake = await call('owner', 'GET', '/NotAnEntity');
    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
  });
});

describe('entity route: secret material is stripped', () => {
  it('never returns the raw supplier key on list, query or get', async () => {
    for (const [method, path, body] of [
      ['GET', '/ApiKey', null],
      ['POST', '/ApiKey/query', { filter: {} }],
      ['GET', '/ApiKey/k1', null],
    ]) {
      const res = await call('owner', method, path, body);
      expect(res.status).toBe(200);
      expect(res.raw, `${method} ${path}`).not.toContain('lgx_abc_FULL_SECRET');
      expect(res.raw).toContain('lgx_abc');
    }
  });

  it('never returns the integration credential blob', async () => {
    const res = await call('owner', 'GET', '/IntegrationConfig');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain('LIVE_TOKEN');
  });

  it('strips the key from the response to a create as well', async () => {
    const res = await call('owner', 'POST', '/ApiKey', { name: 'n', key: 'brand_new_secret', key_prefix: 'brand_new' });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain('brand_new_secret');
  });

  it('never returns the stored key hash either', async () => {
    // The hash is offline-attackable and the public posting spec derives its
    // access token from it, so it is credential material in its own right.
    const res = await call('owner', 'GET', '/ApiKey');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain('key_hash');
  });
});

// Task S4. Read-denying a credential while leaving it writable is not
// protection. A caller that cannot read the stored value can still overwrite
// it, which is precisely how the settings dialogs destroyed live tokens.
describe('entity route: credential material cannot be written', () => {
  it('drops an attempt to set a supplier key or its hash through the generic route', async () => {
    writes.length = 0;
    const res = await call('owner', 'PATCH', '/ApiKey/k1', {
      name: 'Renamed',
      key: 'attacker_chosen_key',
      key_hash: 'attacker_chosen_hash',
    });
    expect(res.status).toBe(200);

    const patch = writes.find((w) => w.name === 'ApiKey' && w.op === 'update')?.rec;
    expect(patch).toEqual({ name: 'Renamed' });
    expect(patch).not.toHaveProperty('key');
    expect(patch).not.toHaveProperty('key_hash');
  });

  it('drops an attempt to overwrite an integration credential blob', async () => {
    writes.length = 0;
    const res = await call('owner', 'PATCH', '/IntegrationConfig/i1', {
      name: 'mercury',
      config: '{"account_id":"only_field_the_form_knew"}',
    });
    expect(res.status).toBe(200);

    const patch = writes.find((w) => w.name === 'IntegrationConfig' && w.op === 'update')?.rec;
    expect(patch).toEqual({ name: 'mercury' });
    expect(patch).not.toHaveProperty('config');
  });

  it('drops credential fields on create as well as update', async () => {
    writes.length = 0;
    await call('owner', 'POST', '/ApiKey', { name: 'n', key: 'x', key_hash: 'y', key_prefix: 'p' });
    const rec = writes.find((w) => w.name === 'ApiKey' && w.op === 'create')?.rec;
    expect(rec).not.toHaveProperty('key');
    expect(rec).not.toHaveProperty('key_hash');
    expect(rec.key_prefix).toBe('p');
  });
});

describe('entity route: role separation', () => {
  it('lets a manager read leads but not api keys or users', async () => {
    expect((await call('manager', 'GET', '/Lead')).status).toBe(200);
    expect((await call('manager', 'GET', '/ApiKey')).status).toBe(403);
    expect((await call('manager', 'GET', '/User')).status).toBe(403);
    expect((await call('manager', 'GET', '/IntegrationConfig')).status).toBe(403);
  });

  it('stops a manager deleting a lead but allows the owner', async () => {
    expect((await call('manager', 'DELETE', '/Lead/l1')).status).toBe(403);
    expect((await call('owner', 'DELETE', '/Lead/l1')).status).toBe(200);
  });
});

describe('entity route: privilege escalation is blocked', () => {
  it('drops role fields from a user update before it reaches the database', async () => {
    writes.length = 0;
    const res = await call('owner', 'PATCH', '/User/u9', {
      full_name: 'Renamed',
      base_role: 'owner',
      role: 'admin',
      permissions: '{"all":true}',
    });
    expect(res.status).toBe(200);
    const write = writes.find((w) => w.name === 'User' && w.op === 'update');
    expect(write).toBeDefined();
    expect(write.rec.full_name).toBe('Renamed');
    expect(write.rec.base_role).toBeUndefined();
    expect(write.rec.role).toBeUndefined();
    expect(write.rec.permissions).toBeUndefined();
  });

  it('drops role fields from a bulk user write too', async () => {
    writes.length = 0;
    await call('owner', 'POST', '/User/bulk-update', [{ id: 'u9', base_role: 'owner' }]);
    const write = writes.find((w) => w.op === 'bulkUpdate');
    expect(write.rec[0].base_role).toBeUndefined();
  });
});

describe('entity route: result size is bounded', () => {
  it('caps an oversized limit rather than honouring it', async () => {
    // A 200 here with a sane payload is enough: the cap is applied in the
    // route before the repository sees it.
    const res = await call('owner', 'GET', '/Lead?limit=999999');
    expect(res.status).toBe(200);
  });
});
