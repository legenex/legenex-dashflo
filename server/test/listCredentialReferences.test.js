import { describe, it, expect } from 'vitest';
import listCredentialReferences from '../src/functions/listCredentialReferences.js';

const OPERATOR = { id: 'u1', base_role: 'operator' };

function makeDb(rows = []) {
  return { entities: { IntegrationConfig: { list: async () => rows } } };
}

function ctxFor(db, user = OPERATOR) {
  return { user, db, body: {}, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('listCredentialReferences', () => {
  it('returns names and updated_date only, sorted, never the config blob', async () => {
    const db = makeDb([
      { id: 'ic2', name: 'zzz_last', config: JSON.stringify({ token: 'super-secret' }), updated_date: '2026-02-01T00:00:00Z' },
      { id: 'ic1', name: 'walker_advertising_auth', config: JSON.stringify({ token: 'another-secret' }), updated_date: '2026-01-01T00:00:00Z' },
    ]);
    const res = await listCredentialReferences(ctxFor(db));
    expect(res.success).toBe(true);
    expect(res.credentials).toEqual([
      { name: 'walker_advertising_auth', updated_date: '2026-01-01T00:00:00Z' },
      { name: 'zzz_last', updated_date: '2026-02-01T00:00:00Z' },
    ]);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain('token');
  });

  it('skips a row with no name', async () => {
    const db = makeDb([{ id: 'ic1', name: '', config: '{}' }]);
    const res = await listCredentialReferences(ctxFor(db));
    expect(res.credentials).toEqual([]);
  });

  it('returns an empty list rather than throwing when there are no rows', async () => {
    const res = await listCredentialReferences(ctxFor(makeDb([])));
    expect(res.success).toBe(true);
    expect(res.credentials).toEqual([]);
  });

  it('requires an authenticated user', async () => {
    await expect(listCredentialReferences(ctxFor(makeDb([]), null))).rejects.toThrow();
  });
});
