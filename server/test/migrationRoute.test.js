import { describe, expect, it } from 'vitest';
import { authorized } from '../src/routes/migrations.js';

describe('migration route authorization', () => {
  it('allows only the real owner to import an encrypted owner package', () => {
    expect(authorized({ base_role: 'owner' }, 'owner')).toBe(true);
    expect(authorized({ base_role: 'admin', permissions: { set_export_import: true } }, 'owner')).toBe(false);
    expect(authorized(null, 'owner')).toBe(false);
  });

  it('allows an owner or explicitly permitted internal user to import ordinary data', () => {
    expect(authorized({ base_role: 'owner' }, 'ordinary')).toBe(true);
    expect(authorized({ base_role: 'admin', permissions: JSON.stringify({ set_export_import: true }) }, 'ordinary')).toBe(true);
    expect(authorized({ base_role: 'manager', permissions: { set_export_import: false } }, 'ordinary')).toBe(false);
  });

  it('keeps buyer and supplier portal identities out of every migration route', () => {
    expect(authorized({ base_role: 'buyer', permissions: { set_export_import: true } }, 'ordinary')).toBe(false);
    expect(authorized({ base_role: 'supplier', permissions: { set_export_import: true } }, 'ordinary')).toBe(false);
    expect(authorized({ base_role: 'admin', linked_buyer_id: 'buyer-1', permissions: { set_export_import: true } }, 'ordinary')).toBe(false);
    expect(authorized({ base_role: 'owner', linked_supplier_id: 'supplier-1' }, 'owner')).toBe(false);
  });
});
