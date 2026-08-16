import { describe, it, expect } from 'vitest';
import {
  ROLE,
  resolveRoleClass,
  ENTITY_POLICY,
  READ_DENY_FIELDS,
  authorizeEntity,
  projectRead,
  sanitizeWrite,
} from '../src/lib/entityPolicy.js';
import { entityNames } from '../src/schemas/index.js';

// The authorization matrix for the generic entity route.
//
// The route previously allowed every authenticated user whenever a schema
// carried no row-level rule, and sixty of the ninety schemas carry no rule.
// These tests pin the inverted default: absent from the policy table means
// denied, for every role and every action.

const ACTIONS = ['read', 'create', 'update', 'delete'];

const USERS = {
  anonymous: null,
  owner: { id: 'u1', base_role: 'owner', role: 'admin' },
  admin: { id: 'u2', base_role: 'admin', role: 'admin' },
  manager: { id: 'u3', base_role: 'manager', role: 'user' },
  buyerPortal: { id: 'u4', base_role: 'buyer', role: 'user', linked_buyer_id: 'b1' },
  supplierPortal: { id: 'u5', base_role: 'supplier', role: 'user', linked_supplier_id: 's1' },
  // An account that carries an operator role but is linked to a party. The
  // link must win, otherwise a portal user with a stale role field escapes.
  linkedManager: { id: 'u6', base_role: 'manager', role: 'user', linked_buyer_id: 'b2' },
  roleless: { id: 'u7' },
};

describe('role class resolution', () => {
  it('classifies each account shape', () => {
    expect(resolveRoleClass(USERS.anonymous)).toBe(ROLE.ANONYMOUS);
    expect(resolveRoleClass(USERS.owner)).toBe(ROLE.OWNER);
    expect(resolveRoleClass(USERS.admin)).toBe(ROLE.ADMIN);
    expect(resolveRoleClass(USERS.manager)).toBe(ROLE.MANAGER);
    expect(resolveRoleClass(USERS.buyerPortal)).toBe(ROLE.PORTAL);
    expect(resolveRoleClass(USERS.supplierPortal)).toBe(ROLE.PORTAL);
    expect(resolveRoleClass(USERS.roleless)).toBe(ROLE.UNKNOWN);
  });

  it('treats a linked party id as portal even when the role says manager', () => {
    expect(resolveRoleClass(USERS.linkedManager)).toBe(ROLE.PORTAL);
  });

  it('treats a supplier link as portal even with no base_role', () => {
    expect(resolveRoleClass({ id: 'x', linked_supplier_id: 's9' })).toBe(ROLE.PORTAL);
  });
});

describe('deny by default', () => {
  it('denies every entity absent from the policy table, for every role and action', () => {
    const unlisted = entityNames.filter((n) => !ENTITY_POLICY[n]);
    // The audit's central finding: most schemas carry no rule. Those must be
    // denied now, not allowed.
    expect(unlisted.length).toBeGreaterThan(0);

    for (const entity of unlisted) {
      for (const action of ACTIONS) {
        for (const [label, user] of Object.entries(USERS)) {
          const d = authorizeEntity(user, entity, action);
          expect(d.allowed, `${label} should not ${action} ${entity}`).toBe(false);
        }
      }
    }
  });

  it('denies an entity name that does not exist at all', () => {
    for (const action of ACTIONS) {
      expect(authorizeEntity(USERS.owner, 'NoSuchEntity', action).allowed).toBe(false);
    }
  });

  it('does not leak whether an unlisted entity exists', () => {
    const real = authorizeEntity(USERS.owner, 'AuditLog', 'read');
    const fake = authorizeEntity(USERS.owner, 'TotallyMadeUp', 'read');
    expect(real.status).toBe(fake.status);
    expect(real.reason).toBe(fake.reason);
  });
});

describe('anonymous access', () => {
  it('is refused with 401 on every listed entity and action', () => {
    for (const entity of Object.keys(ENTITY_POLICY)) {
      for (const action of ACTIONS) {
        const d = authorizeEntity(null, entity, action);
        expect(d.allowed).toBe(false);
        expect(d.status).toBe(401);
      }
    }
  });
});

describe('portal accounts are locked out of the generic route', () => {
  const portals = ['buyerPortal', 'supplierPortal', 'linkedManager'];

  it('cannot perform any action on any listed entity', () => {
    for (const label of portals) {
      for (const entity of Object.keys(ENTITY_POLICY)) {
        for (const action of ACTIONS) {
          const d = authorizeEntity(USERS[label], entity, action);
          expect(d.allowed, `${label} ${action} ${entity}`).toBe(false);
          expect(d.status).toBe(403);
        }
      }
    }
  });

  it('specifically cannot reach cross-tenant or money records', () => {
    const sensitive = ['Buyer', 'Supplier', 'Lead', 'Invoice', 'BankTransaction', 'User', 'ApiKey'];
    for (const label of portals) {
      for (const entity of sensitive) {
        expect(authorizeEntity(USERS[label], entity, 'read').allowed).toBe(false);
        expect(authorizeEntity(USERS[label], entity, 'update').allowed).toBe(false);
      }
    }
  });
});

describe('operator role separation', () => {
  it('lets a manager work the operational entities', () => {
    for (const entity of ['Lead', 'Campaign', 'RouteGroup', 'Buyer', 'Supplier']) {
      expect(authorizeEntity(USERS.manager, entity, 'read').allowed).toBe(true);
    }
  });

  it('keeps a manager out of configuration and secret bearing entities', () => {
    const adminOnly = [
      'AppSettings', 'ApiConnector', 'LeadByteConnector', 'HlrSettings',
      'EmailValidationSettings', 'BotConfig', 'NotificationRule', 'Webhook',
      'OutboundWebhook', 'InboundWebhookRoute', 'PullSource', 'ReferenceKey',
      'ApiKey', 'IntegrationConfig', 'User', 'BankTransaction',
    ];
    for (const entity of adminOnly) {
      for (const action of ACTIONS) {
        expect(
          authorizeEntity(USERS.manager, entity, action).allowed,
          `manager should not ${action} ${entity}`,
        ).toBe(false);
      }
    }
  });

  it('stops a manager deleting a lead or a buyer', () => {
    expect(authorizeEntity(USERS.manager, 'Lead', 'delete').allowed).toBe(false);
    expect(authorizeEntity(USERS.manager, 'Buyer', 'delete').allowed).toBe(false);
    expect(authorizeEntity(USERS.owner, 'Lead', 'delete').allowed).toBe(true);
  });

  it('stops anyone writing function-owned ledgers through the route', () => {
    for (const label of ['owner', 'admin', 'manager']) {
      for (const action of ['create', 'update', 'delete']) {
        expect(
          authorizeEntity(USERS[label], 'WalletTransaction', action).allowed,
          `${label} ${action} WalletTransaction`,
        ).toBe(false);
      }
      expect(authorizeEntity(USERS[label], 'WalletTransaction', 'read').allowed).toBe(true);
    }
  });

  it('never allows deleting money records through the route', () => {
    for (const label of ['owner', 'admin', 'manager']) {
      expect(authorizeEntity(USERS[label], 'BankTransaction', 'delete').allowed).toBe(false);
      expect(authorizeEntity(USERS[label], 'BankTransaction', 'create').allowed).toBe(false);
    }
  });
});

describe('secret material never leaves through the route', () => {
  it('strips the raw supplier key from a record and from a list', () => {
    const row = { id: 'k1', name: 'acme', key_prefix: 'lgx_abcdef', key: 'lgx_abcdef_full_value', active: true };
    const one = projectRead('ApiKey', row);
    expect(one.key).toBeUndefined();
    expect(one.key_prefix).toBe('lgx_abcdef');
    expect(one.active).toBe(true);

    const many = projectRead('ApiKey', [row, { ...row, id: 'k2' }]);
    expect(many).toHaveLength(2);
    for (const r of many) expect(r.key).toBeUndefined();
  });

  it('strips the integration credential blob', () => {
    const row = { id: 'i1', name: 'mercury', config: '{"api_token":"live-value"}' };
    const projected = projectRead('IntegrationConfig', row);
    expect(projected.config).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('live-value');
  });

  it('strips the legacy buyer credential while preserving buyer metadata', () => {
    const row = { id: 'b1', company_name: 'Acme Buyer', buyer_api_key: 'buyer-secret', active: true };
    const projected = projectRead('Buyer', row);
    expect(projected.buyer_api_key).toBeUndefined();
    expect(projected.company_name).toBe('Acme Buyer');
  });

  it('does not mutate the record it was given', () => {
    const row = { id: 'k1', key: 'secret-value' };
    projectRead('ApiKey', row);
    expect(row.key).toBe('secret-value');
  });

  it('leaves entities with no read denial untouched', () => {
    const row = { id: 'l1', email: 'a@b.com' };
    expect(projectRead('Lead', row)).toEqual(row);
  });

  it('covers every entity whose schema declares a secret bearing field', () => {
    // If a new secret bearing entity is exposed, it must appear here too.
    for (const entity of Object.keys(READ_DENY_FIELDS)) {
      expect(ENTITY_POLICY[entity], `${entity} is projected but not policied`).toBeDefined();
    }
  });
});

describe('privilege escalation through writes is blocked', () => {
  it('drops role and permission fields from a user write', () => {
    const patch = {
      full_name: 'New Name',
      role: 'admin',
      base_role: 'owner',
      permissions: '{"everything":true}',
      linked_buyer_id: 'b1',
    };
    const clean = sanitizeWrite('User', patch);
    expect(clean.full_name).toBe('New Name');
    expect(clean.role).toBeUndefined();
    expect(clean.base_role).toBeUndefined();
    expect(clean.permissions).toBeUndefined();
    expect(clean.linked_buyer_id).toBeUndefined();
  });

  it('applies the same stripping to a bulk write', () => {
    const rows = sanitizeWrite('User', [{ id: 'a', base_role: 'owner' }, { id: 'b', role: 'admin' }]);
    expect(rows[0].base_role).toBeUndefined();
    expect(rows[1].role).toBeUndefined();
  });

  it('does not mutate the payload it was given', () => {
    const patch = { base_role: 'owner' };
    sanitizeWrite('User', patch);
    expect(patch.base_role).toBe('owner');
  });

  it('does not let the generic buyer route replace a buyer credential', () => {
    const clean = sanitizeWrite('Buyer', { company_name: 'Acme', buyer_api_key: 'replacement' });
    expect(clean.company_name).toBe('Acme');
    expect(clean.buyer_api_key).toBeUndefined();
  });
});

describe('the policy table itself', () => {
  it('names only entities that actually exist', () => {
    for (const entity of Object.keys(ENTITY_POLICY)) {
      expect(entityNames, `${entity} is policied but has no schema`).toContain(entity);
    }
  });

  it('gives every listed entity an explicit list for every action', () => {
    for (const [entity, policy] of Object.entries(ENTITY_POLICY)) {
      for (const action of ACTIONS) {
        expect(Array.isArray(policy[action]), `${entity}.${action}`).toBe(true);
      }
    }
  });

  it('never grants an action to the portal or anonymous class', () => {
    for (const [entity, policy] of Object.entries(ENTITY_POLICY)) {
      for (const action of ACTIONS) {
        expect(policy[action], `${entity}.${action}`).not.toContain(ROLE.PORTAL);
        expect(policy[action], `${entity}.${action}`).not.toContain(ROLE.ANONYMOUS);
      }
    }
  });
});
