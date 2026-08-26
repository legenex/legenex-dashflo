import { describe, it, expect } from 'vitest';
import { keyForLocation, firstAllowedPath, sanitizePermissions, PATH_KEYS } from './permissions.js';

describe('keyForLocation', () => {
  it('gates the top-level Webhooks list on dist_webhooks', () => {
    expect(keyForLocation('/webhooks', '')).toBe('dist_webhooks');
  });

  // Regression: the full-page Delivery editor (/webhooks/:deliveryId,
  // /webhooks/new) was added without updating keyForLocation, so it fell
  // through to `PATH_KEYS[pathname] || null` -> null for any nested path.
  // PermissionRoute treats a null key as "no gating key, render freely" -
  // any authenticated user, regardless of role, could open the editor's
  // Save/Rename/Duplicate/Archive controls, only to have every write 403
  // server-side. This is the actual production bug this test pins.
  it('gates a Delivery detail route (/webhooks/:deliveryId) on the same dist_webhooks key as the list', () => {
    expect(keyForLocation('/webhooks/6a5a8d809fe2a933ca284252', '')).toBe('dist_webhooks');
  });

  it('gates the new-delivery route (/webhooks/new) on dist_webhooks', () => {
    expect(keyForLocation('/webhooks/new', '')).toBe('dist_webhooks');
  });

  it('still gates buyer/supplier detail routes on their list permission (unchanged)', () => {
    expect(keyForLocation('/buyers/b1', '')).toBe('dist_buyers');
    expect(keyForLocation('/suppliers/s1', '')).toBe('dist_suppliers');
    expect(keyForLocation('/distribution/buyers/b1', '')).toBe('dist_buyers');
  });

  it('resolves every exact PATH_KEYS entry unchanged', () => {
    for (const [path, key] of Object.entries(PATH_KEYS)) {
      expect(keyForLocation(path, '')).toBe(key);
    }
  });

  it('returns null for a path with no gating key at all', () => {
    expect(keyForLocation('/some/totally/unknown/path', '')).toBe(null);
  });

  it('settings profile tab is always accessible; other tabs resolve their key', () => {
    expect(keyForLocation('/settings', '?tab=profile')).toBe(null);
    expect(keyForLocation('/settings', '?tab=users')).toBe('set_users');
    expect(keyForLocation('/settings', '')).toBe('set_integrations');
  });
});

describe('firstAllowedPath', () => {
  it('returns null when no permission key is granted (matches the unknown-role shape)', () => {
    expect(firstAllowedPath(() => false)).toBe(null);
  });

  it('returns the first path in priority order the caller can reach', () => {
    expect(firstAllowedPath((k) => k === 'reports')).toBe('/reports');
  });
});

describe('sanitizePermissions', () => {
  it('strips distribution/finance/operations/progress keys from buyer and supplier roles', () => {
    const perms = { dist_webhooks: true, finances: true, operations: true, overview: true };
    const out = sanitizePermissions('buyer', perms);
    expect(out.dist_webhooks).toBeUndefined();
    expect(out.finances).toBeUndefined();
    expect(out.operations).toBeUndefined();
    expect(out.overview).toBe(true);
  });

  it('leaves a non-partner role unchanged', () => {
    const perms = { dist_webhooks: true, overview: true };
    expect(sanitizePermissions('manager', perms)).toEqual(perms);
    expect(sanitizePermissions('unknown', perms)).toEqual(perms);
  });
});
