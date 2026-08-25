import { describe, it, expect } from 'vitest';
import saveSubDeliveryHeaders from '../src/functions/saveSubDeliveryHeaders.js';

const OPERATOR = { id: 'u1', base_role: 'operator' };

function makeDb(sub) {
  const writes = [];
  return {
    writes,
    entities: {
      SubDelivery: {
        get: async (id) => (sub && sub.id === id ? sub : null),
        update: async (id, patch) => { writes.push({ id, patch }); return { id, ...sub, ...patch }; },
      },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('saveSubDeliveryHeaders', () => {
  // The actual bug this closes: entityPolicy.js's READ_TRANSFORM_FIELDS
  // redacts a secret-shaped header value to the literal string "[redacted]"
  // before a SubDelivery ever reaches the browser. The editor loads that
  // value into an editable row and, without this merge, would resubmit
  // "[redacted]" as if it were the real value on the very next save -
  // permanently destroying the real Authorization header.
  it('preserves the real stored value for a header the operator never actually touched', async () => {
    const sub = { id: 'sd1', headers: JSON.stringify({ 'X-Env': 'prod', Authorization: 'Bearer real-secret-value' }) };
    const db = makeDb(sub);
    const res = await saveSubDeliveryHeaders(ctxFor(db, {
      subDeliveryId: 'sd1',
      headers: JSON.stringify({ 'X-Env': 'prod', Authorization: '[redacted]' }),
    }));
    expect(res.success).toBe(true);
    const written = JSON.parse(db.writes[0].patch.headers);
    expect(written.Authorization).toBe('Bearer real-secret-value');
    expect(written['X-Env']).toBe('prod');
  });

  it('writes a genuinely new value for a key the operator actually retyped, even a secret-shaped one', async () => {
    const sub = { id: 'sd1', headers: JSON.stringify({ Authorization: 'Bearer old-value' }) };
    const db = makeDb(sub);
    await saveSubDeliveryHeaders(ctxFor(db, {
      subDeliveryId: 'sd1',
      headers: JSON.stringify({ Authorization: 'Bearer brand-new-value' }),
    }));
    const written = JSON.parse(db.writes[0].patch.headers);
    expect(written.Authorization).toBe('Bearer brand-new-value');
  });

  it('drops a key the operator removed from the row list, even if it was previously stored', async () => {
    const sub = { id: 'sd1', headers: JSON.stringify({ 'X-Env': 'prod', 'X-Old': 'value' }) };
    const db = makeDb(sub);
    await saveSubDeliveryHeaders(ctxFor(db, { subDeliveryId: 'sd1', headers: JSON.stringify({ 'X-Env': 'prod' }) }));
    const written = JSON.parse(db.writes[0].patch.headers);
    expect(written).toEqual({ 'X-Env': 'prod' });
  });

  it('accepts a brand-new secret-shaped key that was never stored before (not treated as a placeholder)', async () => {
    const sub = { id: 'sd1', headers: '' };
    const db = makeDb(sub);
    await saveSubDeliveryHeaders(ctxFor(db, { subDeliveryId: 'sd1', headers: JSON.stringify({ Authorization: 'Bearer fresh' }) }));
    const written = JSON.parse(db.writes[0].patch.headers);
    expect(written.Authorization).toBe('Bearer fresh');
  });

  it('writes an empty string, not "{}", when every header is removed', async () => {
    const sub = { id: 'sd1', headers: JSON.stringify({ 'X-Env': 'prod' }) };
    const db = makeDb(sub);
    await saveSubDeliveryHeaders(ctxFor(db, { subDeliveryId: 'sd1', headers: '' }));
    expect(db.writes[0].patch.headers).toBe('');
  });

  it('404s for an unknown subDeliveryId', async () => {
    const db = makeDb(null);
    const res = await saveSubDeliveryHeaders(ctxFor(db, { subDeliveryId: 'nope', headers: '{}' }));
    expect(res.__status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });

  it('400s when subDeliveryId is missing', async () => {
    const res = await saveSubDeliveryHeaders(ctxFor(makeDb(null), { headers: '{}' }));
    expect(res.__status).toBe(400);
  });

  it('requires an authenticated user', async () => {
    const db = makeDb({ id: 'sd1', headers: '' });
    await expect(saveSubDeliveryHeaders({ user: null, db, body: { subDeliveryId: 'sd1', headers: '{}' }, json: (d, s) => ({ __status: s, ...d }) }))
      .rejects.toThrow();
  });
});
