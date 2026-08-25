import { describe, it, expect } from 'vitest';
import { resolveSubDeliveryCredential } from '../src/lib/subDeliveryCredential.js';

// Regression coverage for a real, previously-shipped bug: every one of the
// three call sites (processLead.js, campaignDeliveryTest.js,
// nativeRetryRunner.js) filtered IntegrationConfig by a `key` field and read
// `.value` off the row directly. Neither exists on the real schema (`name` +
// a JSON `config` string - see IntegrationConfig.json and
// saveIntegrationConfig.js, the only writer). Every credential_ref has
// therefore always resolved to {}, so a configured outbound credential was
// silently never sent. This module is the single fixed implementation all
// three call sites now share.

function makeDb(rows = []) {
  return {
    entities: {
      IntegrationConfig: {
        filter: async (query) => {
          const [[field, value]] = Object.entries(query);
          return rows.filter((r) => r[field] === value).map((r) => ({ ...r }));
        },
      },
    },
  };
}

describe('resolveSubDeliveryCredential', () => {
  it('resolves a real credential saved the way saveIntegrationConfig.js actually stores it (name + JSON config.token)', async () => {
    const db = makeDb([{ id: 'ic1', name: 'walker_advertising_auth', config: JSON.stringify({ token: 'fixture-not-a-real-secret-value' }) }]);
    const headers = await resolveSubDeliveryCredential(db, 'walker_advertising_auth');
    expect(headers).toEqual({ Authorization: 'fixture-not-a-real-secret-value' });
  });

  it('the pre-fix shape (filtering by `key`, reading `.value`) would never have matched this row', async () => {
    const rows = [{ id: 'ic1', name: 'walker_advertising_auth', config: JSON.stringify({ token: 'fixture-not-a-real-secret-value' }) }];
    const legacyMatch = rows.filter((r) => r.key === 'walker_advertising_auth');
    expect(legacyMatch).toHaveLength(0);
  });

  it('returns {} for no ref', async () => {
    expect(await resolveSubDeliveryCredential(makeDb([]), null)).toEqual({});
    expect(await resolveSubDeliveryCredential(makeDb([]), '')).toEqual({});
  });

  it('returns {} when no IntegrationConfig row matches the ref (fails closed, not throwing)', async () => {
    const db = makeDb([{ id: 'ic1', name: 'someone_else', config: JSON.stringify({ token: 'x' }) }]);
    expect(await resolveSubDeliveryCredential(db, 'walker_advertising_auth')).toEqual({});
  });

  it('returns {} when the matched row has no token field in its config', async () => {
    const db = makeDb([{ id: 'ic1', name: 'walker_advertising_auth', config: JSON.stringify({ account_id: 'AG1' }) }]);
    expect(await resolveSubDeliveryCredential(db, 'walker_advertising_auth')).toEqual({});
  });

  it('returns {} for a corrupt/non-JSON config blob rather than throwing', async () => {
    const db = makeDb([{ id: 'ic1', name: 'walker_advertising_auth', config: '{not json' }]);
    expect(await resolveSubDeliveryCredential(db, 'walker_advertising_auth')).toEqual({});
  });

  it('returns {} when the entity/store is unavailable', async () => {
    const db = { entities: { IntegrationConfig: { filter: async () => { throw new Error('no store'); } } } };
    expect(await resolveSubDeliveryCredential(db, 'walker_advertising_auth')).toEqual({});
  });
});
