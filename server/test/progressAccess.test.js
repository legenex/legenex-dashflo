import { describe, it, expect } from 'vitest';
import {
  PROGRESS_ENTITIES,
  isOwner,
  authorizeProgress,
  authorizeProgressCtx,
} from '../src/lib/progressAccess.js';
import { ENTITY_POLICY, ROLE, authorizeEntity } from '../src/lib/entityPolicy.js';
import { allowedOrigins, verifySameOrigin } from '../src/middleware/csrf.js';

// The Progress Control Center moved to its own hostname as internal owner
// tooling. These tests pin the rule that makes that separation mean something:
// the owner alone, decided on the server, on every Progress surface.
//
// Being authenticated is not enough. Admin is not enough. A progress_*
// permission key is not enough, and that last one matters most: permission keys
// are assignable from inside the application, so if they still counted, an admin
// could grant themselves the boundary this is supposed to be.

const USERS = {
  anonymous: null,
  owner: { id: 'u1', base_role: 'owner', role: 'admin' },
  admin: { id: 'u2', base_role: 'admin', role: 'admin' },
  manager: { id: 'u3', base_role: 'manager', role: 'user' },
  buyerPortal: { id: 'u4', base_role: 'buyer', role: 'user', linked_buyer_id: 'b1' },
  supplierPortal: { id: 'u5', base_role: 'supplier', role: 'user', linked_supplier_id: 's1' },
  roleless: { id: 'u6' },

  // An admin who has been granted every progress permission key there is. The
  // permission system is not the boundary any more, so this account is refused
  // exactly like any other admin.
  adminWithProgressKeys: {
    id: 'u7',
    base_role: 'admin',
    role: 'admin',
    permissions: JSON.stringify({
      progress_access: true,
      progress_write: true,
      progress_review: true,
      progress_prompts: true,
      progress_admin: true,
    }),
  },

  // A stale or tampered record that claims owner while being linked to a buyer.
  // The link has to win: a portal account that also carries an operator role is
  // the shape a cross-tenant escape takes.
  linkedOwner: { id: 'u8', base_role: 'owner', role: 'admin', linked_buyer_id: 'b2' },
};

describe('owner identification', () => {
  it('recognises only the owner', () => {
    expect(isOwner(USERS.owner)).toBe(true);
    for (const label of ['anonymous', 'admin', 'manager', 'buyerPortal', 'supplierPortal', 'roleless']) {
      expect(isOwner(USERS[label]), label).toBe(false);
    }
  });

  it('refuses an owner role that is linked to a party', () => {
    expect(isOwner(USERS.linkedOwner)).toBe(false);
  });

  it('does not accept the platform admin role as owner', () => {
    // role: 'admin' is the coarse platform field. base_role carries the granular
    // role, and owner is only ever expressed there.
    expect(isOwner({ id: 'x', role: 'admin' })).toBe(false);
  });
});

describe('progress authorization decisions', () => {
  it('lets the owner through', () => {
    expect(authorizeProgress(USERS.owner)).toEqual({ allowed: true });
  });

  it('answers 401 for anonymous and 403 for every signed-in non-owner', () => {
    expect(authorizeProgress(USERS.anonymous).status).toBe(401);
    for (const label of ['admin', 'manager', 'buyerPortal', 'supplierPortal', 'roleless', 'adminWithProgressKeys', 'linkedOwner']) {
      const decision = authorizeProgress(USERS[label]);
      expect(decision.allowed, label).toBe(false);
      expect(decision.status, label).toBe(403);
    }
  });

  it('tells a refused caller nothing about what would have been required', () => {
    // Someone who reaches this is not supposed to know the surface exists, let
    // alone which role or key opens it.
    const decision = authorizeProgress(USERS.admin);
    expect(decision.reason).toBe('Forbidden');
    expect(decision.reason).not.toMatch(/owner|progress|permission/i);
  });

  it('ignores progress permission keys entirely', () => {
    expect(authorizeProgress(USERS.adminWithProgressKeys).allowed).toBe(false);
  });
});

describe('progress authorization from a function context', () => {
  const ctxFor = (tokenUser, storedRecord) => ({
    user: tokenUser,
    db: { entities: { User: { get: async () => storedRecord } } },
  });

  it('authorizes the owner', async () => {
    const decision = await authorizeProgressCtx(ctxFor(USERS.owner, USERS.owner));
    expect(decision.allowed).toBe(true);
  });

  it('refuses an anonymous context without reading the database', async () => {
    const decision = await authorizeProgressCtx({ user: null, db: null });
    expect(decision.status).toBe(401);
  });

  /* The stored record wins over the token.
   *
   * A session lasts 30 days. If an account is demoted from owner, every token it
   * already holds still carries the old claims, so trusting the token would keep
   * the Control Center open for the rest of that window.
   */
  it('refuses a token that claims owner when the stored record no longer says so', async () => {
    const staleToken = { id: 'u1', base_role: 'owner', role: 'admin' };
    const currentRecord = { id: 'u1', base_role: 'manager', role: 'user' };
    const decision = await authorizeProgressCtx(ctxFor(staleToken, currentRecord));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('promotes on the stored record too, so a fresh owner does not wait for a new token', async () => {
    const oldToken = { id: 'u1', base_role: 'manager', role: 'user' };
    const currentRecord = { id: 'u1', base_role: 'owner', role: 'admin' };
    const decision = await authorizeProgressCtx(ctxFor(oldToken, currentRecord));
    expect(decision.allowed).toBe(true);
  });

  it('falls back to the token claims when the record cannot be read', async () => {
    // Conservative direction: a token never carries a role the record did not
    // have when it was issued, so this cannot invent standing.
    const ctx = {
      user: USERS.admin,
      db: { entities: { User: { get: async () => { throw new Error('db down'); } } } },
    };
    const decision = await authorizeProgressCtx(ctx);
    expect(decision.allowed).toBe(false);
  });
});

describe('progress entities on the generic entity route', () => {
  const ACTIONS = ['read', 'create', 'update', 'delete'];

  it('exposes every progress entity to the owner', () => {
    // These were absent from the policy table, which denied them to everyone
    // including the owner and left the Control Center unable to read its own
    // records. Listing them owner-only is what both restores and confines it.
    for (const entity of PROGRESS_ENTITIES) {
      expect(ENTITY_POLICY[entity], entity).toBeDefined();
      for (const action of ACTIONS) {
        expect(authorizeEntity(USERS.owner, entity, action).allowed, `${entity}.${action}`).toBe(true);
      }
    }
  });

  it('refuses every progress entity to every non-owner, on every action', () => {
    for (const entity of PROGRESS_ENTITIES) {
      for (const action of ACTIONS) {
        for (const label of ['admin', 'manager', 'buyerPortal', 'supplierPortal', 'adminWithProgressKeys', 'roleless']) {
          const decision = authorizeEntity(USERS[label], entity, action);
          expect(decision.allowed, `${label} ${entity}.${action}`).toBe(false);
        }
        expect(authorizeEntity(USERS.anonymous, entity, action).status, `${entity}.${action}`).toBe(401);
      }
    }
  });

  it('keeps captured page screenshots owner only', () => {
    // PageSnapshot holds images of internal application pages. It used to be
    // readable by every operator role.
    expect(ENTITY_POLICY.PageSnapshot.read).toEqual([ROLE.OWNER]);
    expect(authorizeEntity(USERS.manager, 'PageSnapshot', 'read').allowed).toBe(false);
    expect(authorizeEntity(USERS.owner, 'PageSnapshot', 'read').allowed).toBe(true);
  });
});

describe('progress host origin', () => {
  const config = {
    publicBaseUrl: 'https://app.dashflo.io',
    progressOrigin: 'https://progress.dashflo.io',
    auth: { cookieName: 'dashos_token' },
  };

  it('counts the progress host as one of ours', () => {
    // Without this the Control Center renders and then every write it makes is
    // refused by the CSRF guard, which is a worse failure than not deploying it.
    const origins = allowedOrigins(config);
    expect(origins.has('https://progress.dashflo.io')).toBe(true);
    expect(origins.has('https://app.dashflo.io')).toBe(true);
  });

  it('accepts a cookie-authenticated write from the progress host', () => {
    const result = verifySameOrigin({
      method: 'POST',
      origin: 'https://progress.dashflo.io',
      hasCookieAuth: true,
      hasHeaderAuth: false,
      allowed: allowedOrigins(config),
    });
    expect(result.ok).toBe(true);
  });

  it('accepts the Google sign-in exchange posted from the progress host', () => {
    // Signing in on the Control Center host is the ordinary same-origin flow:
    // the browser reads /auth/google/config and posts the Google ID token back
    // to the host it was served from. There is no session cookie yet at that
    // point, so nothing is forgeable, and the origin is one of ours either way.
    // No second OAuth flow and no token handed between hosts.
    const result = verifySameOrigin({
      method: 'POST',
      origin: 'https://progress.dashflo.io',
      hasCookieAuth: false,
      hasHeaderAuth: false,
      allowed: allowedOrigins(config),
    });
    expect(result.ok).toBe(true);
  });

  it('still refuses the marketing site and any other origin', () => {
    // The marketing site is a public static bundle and must never hold CSRF
    // standing over the application. Adding the progress host must not have
    // widened anything else.
    for (const origin of ['https://dashflo.io', 'https://evil.example', 'https://progress.dashflo.io.evil.example']) {
      const result = verifySameOrigin({
        method: 'POST',
        origin,
        hasCookieAuth: true,
        hasHeaderAuth: false,
        allowed: allowedOrigins(config),
      });
      expect(result.ok, origin).toBe(false);
    }
  });
});
