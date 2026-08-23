import { describe, expect, it } from 'vitest';
import { customFieldCatalog } from './customFieldCatalog.js';

const fields = Array.from({ length: 84 }, (_, index) => ({
  id: `field-${index + 1}`,
  field_name: `field_${index + 1}`,
  auto_created: index < 19,
}));

describe('persisted custom field catalog', () => {
  it('keeps the complete persisted catalog as the defined set', () => {
    expect(customFieldCatalog(fields).defined).toHaveLength(84);
  });

  it('keeps auto-detected candidates as a labelled subset', () => {
    const catalog = customFieldCatalog(fields);
    expect(catalog.autoDetected).toHaveLength(19);
    expect(catalog.defined).toHaveLength(84);
  });

  it('fails closed to empty arrays for an invalid response shape', () => {
    expect(customFieldCatalog(null)).toEqual({ defined: [], autoDetected: [] });
    expect(customFieldCatalog({ count: 84 })).toEqual({ defined: [], autoDetected: [] });
  });
});
