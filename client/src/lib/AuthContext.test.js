import { describe, it, expect } from 'vitest';
import { resolvePermissions } from './AuthContext.jsx';

/* Regression coverage for the production gap: resolvePermissions (client)
 * and resolveRoleClass (server, entityPolicy.js) must agree on what a user
 * record with no base_role and no admin signal resolves to. Before this
 * fix, the client fell back to 'manager' (a full operator UI: nav visible,
 * the full-page Delivery editor rendered with live Save/Rename/Duplicate/
 * Archive controls) while the server's resolveRoleClass fell back to
 * ROLE.UNKNOWN (403 on every entity read/write) - a page that looks
 * editable and only fails after Save. See server/test/rolePermissionParity.test.js
 * for the server-side half of this same contract, exercised against the
 * real resolveRoleClass function so the two suites cannot silently drift.
 */
describe('resolvePermissions', () => {
  it('owner: full permissions, role "owner"', () => {
    const { role, perms } = resolvePermissions({ base_role: 'owner', role: 'admin' });
    expect(role).toBe('owner');
    expect(perms.dist_webhooks).toBe(true);
    expect(perms.finances).toBe(true);
  });

  it('admin (base_role set): everything except finances/bank_feed/master-admin', () => {
    const { role, perms } = resolvePermissions({ base_role: 'admin', role: 'admin' });
    expect(role).toBe('admin');
    expect(perms.dist_webhooks).toBe(true);
    expect(perms.finances).toBeUndefined();
  });

  it('manager (base_role set): operator access, no finances', () => {
    const { role, perms } = resolvePermissions({ base_role: 'manager', role: 'user' });
    expect(role).toBe('manager');
    expect(perms.dist_webhooks).toBe(true);
    expect(perms.operations).toBe(true);
    expect(perms.finances).toBeUndefined();
  });

  it('legacy admin (no base_role, legacy role="admin"): still resolves to the real admin preset', () => {
    const { role, perms } = resolvePermissions({ role: 'admin' });
    expect(role).toBe('admin');
    expect(perms.dist_webhooks).toBe(true);
  });

  // The actual regression: no base_role, and the legacy role field is
  // 'user' (or anything other than 'admin') - there is no real signal this
  // account should have any operator access at all.
  it('legacy account with no base_role and role="user": empty permissions, not the old "manager" default', () => {
    const { role, perms } = resolvePermissions({ role: 'user' });
    expect(role).toBe('unknown');
    expect(Object.keys(perms)).toHaveLength(0);
    expect(perms.dist_webhooks).toBeUndefined();
    expect(perms.overview).toBeUndefined();
  });

  it('a record with no role field and no base_role at all also resolves to empty permissions', () => {
    const { role, perms } = resolvePermissions({});
    expect(role).toBe('unknown');
    expect(Object.keys(perms)).toHaveLength(0);
  });

  it('buyer/supplier presets are unaffected and still stripped of operator-only keys', () => {
    const buyer = resolvePermissions({ base_role: 'buyer' });
    expect(buyer.role).toBe('buyer');
    expect(buyer.perms.dist_webhooks).toBeUndefined();
    expect(buyer.perms.overview).toBe(true);

    const supplier = resolvePermissions({ base_role: 'supplier' });
    expect(supplier.role).toBe('supplier');
    expect(supplier.perms.finances).toBeUndefined();
  });

  it('an explicit stored permissions object overrides the preset, even for an unknown role', () => {
    const { perms } = resolvePermissions({ role: 'user', permissions: JSON.stringify({ overview: true }) });
    // sanitizePermissions does not strip anything for 'unknown', so an
    // explicitly stored permissions blob is honored as-is - only the
    // PRESET fallback (no stored permissions at all) changed with this fix.
    expect(perms.overview).toBe(true);
  });

  it('no user at all resolves to null role and empty permissions (unchanged)', () => {
    expect(resolvePermissions(null)).toEqual({ role: null, perms: {} });
  });
});
