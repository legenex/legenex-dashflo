// The authorization matrix, taken from the implementation rather than the menu.
//
// A hidden menu entry is not an authorization control. Everything here calls
// the server-side decision functions and the real function handlers directly,
// the way somebody with a session cookie and curl would.
//
// The roles are the ones resolveRoleClass actually produces. Note that `role`
// and `base_role` are different axes: the owner bootstrap writes
// role='admin', base_role='owner', so an owner is also an admin by the `role`
// field. Anything that gates on role==='admin' therefore admits both, and
// that distinction is what several of these tests pin.

import { describe, it, expect } from 'vitest';
import { ROLE, resolveRoleClass, authorizeEntity, projectRead, sanitizeWrite } from '../src/lib/entityPolicy.js';
import { authorizeFunction, isPublicFunction, PUBLIC_FUNCTIONS } from '../src/lib/functionPolicy.js';

const OWNER = { id: 'u-owner', email: 'owner@test', role: 'admin', base_role: 'owner' };
const ADMIN = { id: 'u-admin', email: 'admin@test', role: 'admin', base_role: 'admin' };
const MANAGER = { id: 'u-manager', email: 'manager@test', role: 'user', base_role: 'manager' };
const SUPPLIER = { id: 'u-sup', email: 'sup@test', role: 'user', base_role: 'supplier', linked_supplier_id: 's1' };
const BUYER = { id: 'u-buy', email: 'buy@test', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };
// A portal account that also carries an operator role. The linked id must win.
const SNEAKY_PORTAL = { id: 'u-sneak', email: 'sneak@test', role: 'admin', base_role: 'owner', linked_buyer_id: 'b1' };

describe('role resolution', () => {
  it('maps each account shape to the class the policy expects', () => {
    expect(resolveRoleClass(OWNER)).toBe(ROLE.OWNER);
    expect(resolveRoleClass(ADMIN)).toBe(ROLE.ADMIN);
    expect(resolveRoleClass(MANAGER)).toBe(ROLE.MANAGER);
    expect(resolveRoleClass(SUPPLIER)).toBe(ROLE.PORTAL);
    expect(resolveRoleClass(BUYER)).toBe(ROLE.PORTAL);
    expect(resolveRoleClass(null)).toBe(ROLE.ANONYMOUS);
  });

  it('treats a linked party id as portal even when the account claims owner', () => {
    // Otherwise a portal account with a stray operator role escapes its scope.
    expect(resolveRoleClass(SNEAKY_PORTAL)).toBe(ROLE.PORTAL);
  });

  it('refuses an unrecognised role rather than defaulting it to something useful', () => {
    expect(resolveRoleClass({ base_role: 'wizard' })).toBe(ROLE.UNKNOWN);
    expect(authorizeEntity({ base_role: 'wizard' }, 'Lead', 'read').allowed).toBe(false);
  });
});

describe('generic entity route', () => {
  const cases = [
    // entity,        action,   owner, admin, manager, portal, anonymous
    ['Lead', 'read', true, true, true, false, false],
    ['Lead', 'delete', true, true, false, false, false],
    ['ApiKey', 'read', true, true, false, false, false],
    ['ApiKey', 'update', true, true, false, false, false],
    ['IntegrationConfig', 'read', true, true, false, false, false],
    ['User', 'read', true, true, false, false, false],
    ['User', 'update', true, true, false, false, false],
    ['BankTransaction', 'read', true, true, false, false, false],
    ['Invoice', 'create', true, true, false, false, false],
    ['DncEntry', 'create', false, false, false, false, false],
    ['DncEntry', 'delete', false, false, false, false, false],
  ];

  it.each(cases)('%s %s is permitted only where the policy says', (entity, action, owner, admin, manager, portal, anon) => {
    expect(authorizeEntity(OWNER, entity, action).allowed, 'owner').toBe(owner);
    expect(authorizeEntity(ADMIN, entity, action).allowed, 'admin').toBe(admin);
    expect(authorizeEntity(MANAGER, entity, action).allowed, 'manager').toBe(manager);
    expect(authorizeEntity(BUYER, entity, action).allowed, 'portal').toBe(portal);
    expect(authorizeEntity(null, entity, action).allowed, 'anonymous').toBe(anon);
  });

  it('denies every authentication-adjacent entity that is not in the policy table', () => {
    // Deny by default is the whole design. These are the entities an attacker
    // would reach for, and none of them is listed.
    for (const entity of [
      'AuthAuditEvent', 'ContractVersion', 'AuditLog', 'Invitation',
      'SystemKey', 'BuyerApiKey', 'KeyAuditEvent',
    ]) {
      for (const actor of [OWNER, ADMIN, MANAGER, BUYER, null]) {
        const decision = authorizeEntity(actor, entity, 'read');
        expect(decision.allowed, `${entity} for ${actor?.base_role || 'anonymous'}`).toBe(false);
      }
    }
  });

  it('never exposes Progress records to a non-owner, whatever the policy level is', () => {
    // Deliberately does not assert what the owner may do. The Progress
    // relocation is rewriting that half of the policy, and an assertion about
    // it here would be pinning a state that is being replaced. What must hold
    // either way is that nobody below owner reads these.
    for (const entity of ['ProgressPage', 'ProgressSnapshot', 'ReleaseGate', 'ReviewThread', 'ChangeRequest', 'PromptDraft']) {
      for (const actor of [ADMIN, MANAGER, SUPPLIER, BUYER, SNEAKY_PORTAL, null]) {
        for (const action of ['read', 'create', 'update', 'delete']) {
          expect(
            authorizeEntity(actor, entity, action).allowed,
            `${entity}.${action} for ${actor?.base_role || 'anonymous'}`,
          ).toBe(false);
        }
      }
    }
  });

  it('never returns credential material even to an owner', () => {
    const apiKey = projectRead('ApiKey', { id: 'k1', key: 'raw-value', key_hash: 'hash-value', key_prefix: 'dshflo_sup_x' });
    expect(apiKey).not.toHaveProperty('key');
    expect(apiKey).not.toHaveProperty('key_hash');
    expect(apiKey.key_prefix).toBe('dshflo_sup_x');

    expect(projectRead('Buyer', { buyer_api_key: 'raw' })).not.toHaveProperty('buyer_api_key');
    expect(projectRead('IntegrationConfig', { config: 'raw' })).not.toHaveProperty('config');
    expect(projectRead('DncEntry', { contact_hash: 'h' })).not.toHaveProperty('contact_hash');
  });

  it('refuses to let the route write a role or a portal link', () => {
    // Self-escalation through the generic route. Without this an admin could
    // PATCH their own base_role to owner, or attach themselves to a buyer.
    const patched = sanitizeWrite('User', {
      full_name: 'Fine', role: 'admin', base_role: 'owner',
      permissions: '{"everything":true}', linked_buyer_id: 'b1', linked_supplier_id: 's1',
    });
    expect(patched).toEqual({ full_name: 'Fine' });
  });

  it('refuses to let the route write credential material', () => {
    expect(sanitizeWrite('ApiKey', { name: 'ok', key: 'x', key_hash: 'y' })).toEqual({ name: 'ok' });
    expect(sanitizeWrite('Buyer', { company_name: 'ok', buyer_api_key: 'x' })).toEqual({ company_name: 'ok' });
  });
});

describe('generic function route', () => {
  it('requires a session for anything not on the reviewed public allowlist', () => {
    for (const name of ['systemKeys', 'issueApiKey', 'progressSync', 'progressReadiness', 'progressPrompt', 'systemExport', 'listUsers']) {
      const decision = authorizeFunction(null, name);
      expect(decision.allowed, name).toBe(false);
      expect(decision.status).toBe(401);
    }
  });

  it('keeps the public allowlist to the surfaces that authenticate their own caller', () => {
    // A regression here is somebody adding an admin tool to the allowlist.
    const names = Object.keys(PUBLIC_FUNCTIONS).sort();
    expect(names).toEqual([
      'buyerFeedbackWebhook', 'callWebhook', 'getOnboardingContext', 'health',
      'leadbyteWebhook', 'leads', 'metaOauthCallback', 'migrateSource', 'spec',
      'submitBuyerOnboarding', 'validate', 'webhook',
    ]);
    for (const name of ['systemKeys', 'issueApiKey', 'progressSync', 'systemExport', 'dncManage']) {
      expect(isPublicFunction(name), name).toBe(false);
    }
  });
});

// ── Progress ────────────────────────────────────────────────────────────────
//
// The Progress handlers gate on the caller's own record, re-read from the
// database rather than taken from the session, so a stale session cannot carry
// a role the account no longer has. These run the real handlers.

async function runProgress(name, user) {
  const handler = (await import(`../src/functions/${name}.js`)).default;
  const db = {
    entities: new Proxy({}, {
      get: (cache, entity) => (cache[entity] ||= {
        get: async (id) => (entity === 'User' && user && id === user.id ? user : null),
        list: async () => [],
        filter: async () => [],
        create: async (r) => r,
        update: async (id, patch) => ({ id, ...patch }),
      }),
    }),
  };
  return handler({
    db, user, body: {}, env: process.env,
    req: { method: 'POST', headers: {}, get: () => null },
    json: (body, status = 200) => ({ __httpResponse: true, body, status }),
  });
}

describe('Progress authorization', () => {
  const handlers = ['progressSync', 'progressReadiness', 'progressPrompt'];

  it.each(handlers)('%s refuses an anonymous caller', async (name) => {
    const result = await runProgress(name, null);
    expect(result.status).toBe(401);
  });

  it.each(handlers)('%s refuses a supplier portal account', async (name) => {
    const result = await runProgress(name, SUPPLIER);
    expect(result.status).toBe(403);
  });

  it.each(handlers)('%s refuses a buyer portal account', async (name) => {
    const result = await runProgress(name, BUYER);
    expect(result.status).toBe(403);
  });

  it.each(handlers)('%s refuses a portal account carrying an operator role', async (name) => {
    const result = await runProgress(name, SNEAKY_PORTAL);
    expect(result.status).toBe(403);
  });

  it.each(handlers)('%s refuses a manager with no progress permission', async (name) => {
    const result = await runProgress(name, { ...MANAGER, permissions: '{}' });
    expect(result.status).toBe(403);
  });

  it.each(handlers)('%s refuses a manager holding only progress_write', async (name) => {
    // progress_write is the weakest Progress key. Whether the boundary ends up
    // at owner or at progress_admin, this account is below both.
    const result = await runProgress(name, { ...MANAGER, permissions: '{"progress_write":true}' });
    expect(result.status).toBe(403);
  });

  it.each(handlers)('%s re-reads the caller record rather than trusting the session', async (name) => {
    // A session issued while the account was privileged must not keep working
    // after the stored record is downgraded. The handlers read User.get(id),
    // so a session claiming admin against a stored manager is refused.
    const staleSession = { id: 'u-manager', email: 'manager@test', role: 'admin', base_role: 'admin' };
    const handler = (await import(`../src/functions/${name}.js`)).default;
    const db = {
      entities: new Proxy({}, {
        get: (cache, entity) => (cache[entity] ||= {
          // The stored record is a manager with no Progress permission.
          get: async () => ({ ...MANAGER, permissions: '{}' }),
          list: async () => [], filter: async () => [],
          create: async (r) => r, update: async (id, patch) => ({ id, ...patch }),
        }),
      }),
    };
    const result = await handler({
      db, user: staleSession, body: {}, env: process.env,
      req: { method: 'POST', headers: {}, get: () => null },
      json: (body, status = 200) => ({ __httpResponse: true, body, status }),
    });
    expect(result.status).toBe(403);
  });
});
