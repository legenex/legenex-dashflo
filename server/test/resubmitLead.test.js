import { describe, it, expect, vi } from 'vitest';
import resubmitLead, { resolveSupplierCredential } from '../src/functions/resubmitLead.js';

// resubmitLead replaces the old client pattern (ApiKey.filter({id: ...}) then
// read .key off the result), which always returned undefined because the
// generic entity route strips key/key_hash unconditionally (entityPolicy.js,
// Task S4). See docs/STATE.md, "Full production acceptance, part 2", finding
// 2, for the real production bug this fixes: 712 of 1984 leads carried a
// supplier_key_id that no longer resolves to any current ApiKey.

let ranProcessLead;
vi.mock('../src/functions/index.js', () => ({
  getFunction: (name) => {
    if (name !== 'processLead') return null;
    return async (ctx) => ranProcessLead(ctx);
  },
}));

function makeDb({ leads = [], apiKeys = [], suppliers = [] } = {}) {
  const byId = (rows) => (id) => rows.find((r) => r.id === id) || null;
  const byField = (rows) => async (query) => {
    const [[field, value]] = Object.entries(query);
    return rows.filter((r) => r[field] === value);
  };
  return {
    entities: {
      Lead: { get: async (id) => byId(leads)(id) },
      ApiKey: { get: async (id) => byId(apiKeys)(id), filter: byField(apiKeys) },
      Supplier: { filter: byField(suppliers) },
    },
  };
}

const ADMIN = { id: 'u1', base_role: 'admin', role: 'admin' };
const MANAGER = { id: 'u2', base_role: 'manager', role: 'user' };

describe('resolveSupplierCredential', () => {
  it('trusts supplier_key_id as-is when it resolves to a live, active key (current valid key)', async () => {
    const db = makeDb({
      apiKeys: [{ id: 'k1', supplier_id: 's1', supplier_name: 'Acme Leads', active: true }],
    });
    const lead = { supplier_key_id: 'k1', supplier_name: 'Acme Leads' };
    const result = await resolveSupplierCredential(db, lead);
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe('supplier_key_id');
    expect(result.apiKey).toEqual({ id: 'k1', supplier_id: 's1', supplier_name: 'Acme Leads', active: true });
  });

  it('falls back to the Supplier record when supplier_key_id is stale (resolves to nothing)', async () => {
    const db = makeDb({
      suppliers: [{ id: 'sup1', name: 'LeadFlow' }],
      apiKeys: [{ id: 'k-new', supplier_id: 'sup1', supplier_name: 'LeadFlow', active: true }],
    });
    // supplier_key_id points at an id that no longer exists - the exact
    // production scenario (LeadFlow's key was reissued with a new id).
    const lead = { supplier_key_id: 'k-old-deleted', supplier_name: 'LeadFlow' };
    const result = await resolveSupplierCredential(db, lead);
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe('supplier_name_fallback');
    expect(result.apiKey.id).toBe('k-new');
  });

  it('does not trust a supplier_key_id that resolves to a real but inactive key - falls back instead', async () => {
    const db = makeDb({
      suppliers: [{ id: 'sup1', name: 'LeadFlow' }],
      apiKeys: [
        { id: 'k-disabled', supplier_id: 'sup1', supplier_name: 'LeadFlow', active: false },
        { id: 'k-new', supplier_id: 'sup1', supplier_name: 'LeadFlow', active: true },
      ],
    });
    const lead = { supplier_key_id: 'k-disabled', supplier_name: 'LeadFlow' };
    const result = await resolveSupplierCredential(db, lead);
    expect(result.ok).toBe(true);
    expect(result.apiKey.id).toBe('k-new');
  });

  it('fails with a specific reason when there is no key id and no supplier_name (missing key)', async () => {
    const db = makeDb({});
    const result = await resolveSupplierCredential(db, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_SUPPLIER_IDENTITY');
  });

  it('fails with a specific reason when the fallback supplier has no active key at all (missing key)', async () => {
    const db = makeDb({
      suppliers: [{ id: 'sup1', name: 'Dormant Co' }],
      apiKeys: [{ id: 'k1', supplier_id: 'sup1', supplier_name: 'Dormant Co', active: false }],
    });
    const result = await resolveSupplierCredential(db, { supplier_name: 'Dormant Co' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_ACTIVE_KEY');
  });

  it('fails with a specific reason when the supplier name matches no Supplier record', async () => {
    const db = makeDb({});
    const result = await resolveSupplierCredential(db, { supplier_name: 'Nobody Inc' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SUPPLIER_NOT_FOUND');
  });

  it('fails with a specific reason on supplier ambiguity (two Supplier records share a name)', async () => {
    const db = makeDb({
      suppliers: [{ id: 'sup1', name: 'Acme' }, { id: 'sup2', name: 'Acme' }],
    });
    const result = await resolveSupplierCredential(db, { supplier_name: 'Acme' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SUPPLIER_AMBIGUOUS');
  });

  it('fails with a specific reason on key ambiguity (one supplier, two active keys)', async () => {
    const db = makeDb({
      suppliers: [{ id: 'sup1', name: 'Acme' }],
      apiKeys: [
        { id: 'k1', supplier_id: 'sup1', supplier_name: 'Acme', active: true },
        { id: 'k2', supplier_id: 'sup1', supplier_name: 'Acme', active: true },
      ],
    });
    const result = await resolveSupplierCredential(db, { supplier_name: 'Acme' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('KEY_AMBIGUOUS');
  });
});

describe('resubmitLead (server function)', () => {
  it('refuses a non-admin caller', async () => {
    const db = makeDb({});
    const res = await resubmitLead({ user: MANAGER, db, body: { id: 'l1' }, json: (body, status = 200) => ({ __httpResponse: true, body, status }) });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('rejects an empty request', async () => {
    const db = makeDb({});
    const res = await resubmitLead({ user: ADMIN, db, body: {}, json: (body, status = 200) => ({ __httpResponse: true, body, status }) });
    expect(res.status).toBe(400);
  });

  it('replays intake with the resolved key and never returns raw key material, for a bulk mixed success/failure batch', async () => {
    const FIXTURE_RAW_KEY_VALUE = 'dshflo-sup-this-is-the-only-place-this-fixture-value-lives';
    const db = makeDb({
      leads: [
        { id: 'good', raw_payload: JSON.stringify({ email: 'a@b.com' }), supplier_key_id: 'k1', supplier_name: 'Acme' },
        { id: 'bad', raw_payload: JSON.stringify({ email: 'c@d.com' }), supplier_key_id: null, supplier_name: '' },
      ],
      apiKeys: [{ id: 'k1', supplier_id: 'sup1', supplier_name: 'Acme', active: true, key: FIXTURE_RAW_KEY_VALUE, key_hash: 'irrelevant-hash' }],
    });

    ranProcessLead = vi.fn(async (ctx) => {
      // The pipeline receives the resolved record, not a raw key string.
      expect(ctx.__resolvedApiKey).toEqual(expect.objectContaining({ id: 'k1' }));
      expect(ctx.body).toEqual({ email: 'a@b.com' });
      return { ok: true, acceptance: 'accepted', lead_status: 'accepted', lead_id: 'new1' };
    });

    const jsonFn = (body, status = 200) => ({ __httpResponse: true, body, status });
    const res = await resubmitLead({ user: ADMIN, db, body: { ids: ['good', 'bad'] }, json: jsonFn });

    expect(res.body.success).toBe(true);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results.find((r) => r.id === 'good').ok).toBe(true);
    expect(res.body.results.find((r) => r.id === 'bad').ok).toBe(false);
    expect(res.body.results.find((r) => r.id === 'bad').code).toBe('NO_SUPPLIER_IDENTITY');
    expect(ranProcessLead).toHaveBeenCalledTimes(1); // "bad" never reaches the pipeline at all

    // The whole response, serialized exactly as it would leave the server,
    // never contains the raw key or its hash.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(FIXTURE_RAW_KEY_VALUE);
    expect(serialized).not.toContain('irrelevant-hash');
  });

  it('reports a lead that does not exist', async () => {
    const db = makeDb({ leads: [] });
    const jsonFn = (body, status = 200) => ({ __httpResponse: true, body, status });
    const res = await resubmitLead({ user: ADMIN, db, body: { id: 'ghost' }, json: jsonFn });
    expect(res.body.results[0]).toEqual(expect.objectContaining({ id: 'ghost', ok: false, code: 'LEAD_NOT_FOUND' }));
  });

  it('surfaces a pipeline rejection (e.g. duplicate) as a structured, non-throwing result', async () => {
    const db = makeDb({
      leads: [{ id: 'dup', raw_payload: '{}', supplier_key_id: 'k1', supplier_name: 'Acme' }],
      apiKeys: [{ id: 'k1', supplier_id: 'sup1', supplier_name: 'Acme', active: true }],
    });
    ranProcessLead = vi.fn(async () => ({ ok: true, acceptance: 'duplicate', lead_status: 'duplicate' }));
    const jsonFn = (body, status = 200) => ({ __httpResponse: true, body, status });
    const res = await resubmitLead({ user: ADMIN, db, body: { id: 'dup' }, json: jsonFn });
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[0].acceptance).toBe('duplicate');
  });
});
