import { describe, it, expect } from 'vitest';
import { resolveRoleClass, ROLE } from '../src/lib/entityPolicy.js';
import { resolvePermissions } from '../../client/src/lib/AuthContext.jsx';

// Regression coverage for a real production gap: the client (resolvePermissions,
// gating what the operator UI renders - nav items, the full-page Delivery
// editor's Save/Rename/Duplicate/Archive controls) and the server
// (resolveRoleClass, gating every actual entity read/write on the generic
// route) used to disagree about a user record with no base_role and no
// admin signal - the client granted it a full 'manager'-equivalent UI, the
// server denied it as ROLE.UNKNOWN. That produced exactly the failure mode
// this suite exists to prevent: a page that looks fully editable and only
// fails after the operator clicks Save.
//
// This test imports the REAL functions from both sides (not a re-typed copy
// of either), so a future change to either resolver that reopens the gap
// fails here rather than silently drifting again.
const OPERATOR_SERVER_ROLES = new Set([ROLE.OWNER, ROLE.ADMIN, ROLE.MANAGER]);

function clientGrantsOperatorAccess(user) {
  const { role, perms } = resolvePermissions(user);
  if (role === 'owner') return true;
  if (role === 'buyer' || role === 'supplier' || role === 'unknown' || !role) return false;
  // 'admin'/'manager': real operator access is granted by definition once
  // resolved to one of these roles (the preset always includes at least
  // dist_webhooks - see permissions.js's ROLE_PRESETS), independent of the
  // specific permission object shape a test constructs.
  return !!perms.dist_webhooks || Object.keys(perms).length > 0;
}

describe('client/server role resolution parity', () => {
  it.each([
    ['owner', { base_role: 'owner', role: 'admin' }],
    ['admin (base_role set)', { base_role: 'admin', role: 'admin' }],
    ['manager (base_role set)', { base_role: 'manager', role: 'user' }],
    ['legacy admin (no base_role, legacy role=admin)', { role: 'admin' }],
  ])('%s: client grants operator UI access and the server accepts an operator entity action', (label, user) => {
    expect(clientGrantsOperatorAccess(user)).toBe(true);
    expect(OPERATOR_SERVER_ROLES.has(resolveRoleClass(user))).toBe(true);
  });

  it.each([
    ['legacy account, no base_role, role=user (the actual regression shape)', { role: 'user' }],
    ['no role field and no base_role at all', {}],
  ])('%s: client shows NO operator UI, and the server denies every entity action (ROLE.UNKNOWN)', (label, user) => {
    expect(clientGrantsOperatorAccess(user)).toBe(false);
    expect(resolveRoleClass(user)).toBe(ROLE.UNKNOWN);
    expect(OPERATOR_SERVER_ROLES.has(resolveRoleClass(user))).toBe(false);
  });

  it.each([
    ['buyer portal', { base_role: 'buyer' }],
    ['supplier portal', { base_role: 'supplier' }],
    ['linked buyer account regardless of base_role', { base_role: 'manager', linked_buyer_id: 'b1' }],
  ])('%s: client shows no operator UI, and the server classifies as PORTAL, never an operator role', (label, user) => {
    expect(clientGrantsOperatorAccess(user)).toBe(false);
    expect(resolveRoleClass(user)).toBe(ROLE.PORTAL);
  });

  it('an anonymous (no user) request is denied on both sides', () => {
    expect(clientGrantsOperatorAccess(null)).toBe(false);
    expect(resolveRoleClass(null)).toBe(ROLE.ANONYMOUS);
  });
});
