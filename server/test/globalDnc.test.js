import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import {
  DNC_STATUS,
  DNC_SCOPE,
  DNC_REJECTION,
  DncKeyMissingError,
  hasDncKey,
  normalizePhone,
  normalizeEmail,
  hashValue,
  hashContact,
  isInForce,
  scopeCovers,
  evaluateSuppression,
  contactHashesFor,
} from '../src/lib/dnc.js';
import dncManage from '../src/functions/dncManage.js';

// Task I2. Global DNC is the first business validation after durable capture,
// so a false negative here contacts someone who opted out. These tests pin the
// normalization, the keyed hashing, the effective window, the scope rules, and
// the fail-closed behaviour when the key is absent.

const ORIGINAL_KEY = process.env.DNC_HASH_KEY;
process.env.DNC_HASH_KEY = 'test-only-key-not-a-real-secret';

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.DNC_HASH_KEY;
  else process.env.DNC_HASH_KEY = ORIGINAL_KEY;
});

function makeCtx({ user, body, rows = [] }) {
  const store = rows.map((r) => ({ ...r }));
  let seq = 0;
  let response = null;
  return {
    __store: store,
    get __response() { return response; },
    user,
    body,
    json: (payload, status = 200) => { response = { payload, status }; return response; },
    db: {
      entities: {
        DncEntry: {
          filter: async (query) => {
            const pairs = Object.entries(query);
            return store
              .filter((r) => pairs.every(([f, v]) => r[f] === v))
              .map((r) => ({ ...r }));
          },
          get: async (id) => store.find((r) => r.id === id) ?? null,
          create: async (rec) => {
            seq += 1;
            const row = { id: `d${seq}`, ...rec };
            store.push(row);
            return row;
          },
          update: async (id, patch) => {
            const row = store.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return row;
          },
        },
      },
    },
  };
}

const OWNER = { id: 'u1', base_role: 'owner' };
const MANAGER = { id: 'u3', base_role: 'manager' };
const BUYER_PORTAL = { id: 'u4', base_role: 'buyer', linked_buyer_id: 'b1' };

describe('normalization', () => {
  it('normalizes US and Canada phone numbers to E.164', () => {
    for (const input of ['5125551234', '(512) 555-1234', '512-555-1234', '1 512 555 1234', '+1 (512) 555-1234']) {
      expect(normalizePhone(input)).toBe('+15125551234');
    }
  });

  it('returns null for something that is not a routable number', () => {
    for (const input of ['', '   ', 'abc', '123', null, undefined]) {
      expect(normalizePhone(input)).toBeNull();
    }
  });

  it('lowercases and trims email without folding plus tags', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    // A plus tag is a different address for consent purposes. Folding it would
    // suppress somebody who never opted out.
    expect(normalizeEmail('ada+leads@example.com')).toBe('ada+leads@example.com');
    expect(normalizeEmail('ada+leads@example.com')).not.toBe(normalizeEmail('ada@example.com'));
  });

  it('returns null for a non address', () => {
    for (const input of ['', 'not-an-email', '@example.com', 'ada@', null]) {
      expect(normalizeEmail(input)).toBeNull();
    }
  });

  it('matches the same person written several ways', () => {
    const a = hashContact('phone', '(512) 555-1234');
    const b = hashContact('phone', '+1 512 555 1234');
    const c = hashContact('phone', '15125551234');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('keyed hashing', () => {
  it('never returns the raw value and is not a bare sha256', async () => {
    const crypto = await import('node:crypto');
    const normalized = '+15125551234';
    const hash = hashValue('phone', normalized);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain('5125551234');

    const bare = crypto.createHash('sha256').update(`phone:${normalized}`, 'utf8').digest('hex');
    // If this were a plain hash, the ten billion number keyspace would be
    // walkable offline. The HMAC key is what stops that.
    expect(hash).not.toBe(bare);
  });

  it('produces a different hash under a different key', () => {
    const before = hashValue('phone', '+15125551234');
    process.env.DNC_HASH_KEY = 'a-different-key';
    const after = hashValue('phone', '+15125551234');
    process.env.DNC_HASH_KEY = 'test-only-key-not-a-real-secret';
    expect(after).not.toBe(before);
  });

  it('separates the two contact kinds', () => {
    // A phone and an email that happened to normalize alike must not collide.
    expect(hashValue('phone', 'x')).not.toBe(hashValue('email', 'x'));
  });

  it('refuses to hash at all when the key is missing', () => {
    const saved = process.env.DNC_HASH_KEY;
    delete process.env.DNC_HASH_KEY;
    expect(hasDncKey()).toBe(false);
    expect(() => hashValue('phone', '+15125551234')).toThrow(DncKeyMissingError);
    process.env.DNC_HASH_KEY = saved;
  });
});

describe('effective window', () => {
  const at = new Date('2026-08-15T12:00:00Z');

  it('suppresses an active entry with no dates', () => {
    expect(isInForce({ status: DNC_STATUS.ACTIVE }, at)).toBe(true);
  });

  it('does not suppress before it begins', () => {
    expect(isInForce({ status: DNC_STATUS.ACTIVE, effective_from: '2026-09-01T00:00:00Z' }, at)).toBe(false);
  });

  it('does not suppress after it ends', () => {
    expect(isInForce({ status: DNC_STATUS.ACTIVE, effective_to: '2026-08-01T00:00:00Z' }, at)).toBe(false);
  });

  it('suppresses inside the window', () => {
    expect(isInForce({
      status: DNC_STATUS.ACTIVE,
      effective_from: '2026-08-01T00:00:00Z',
      effective_to: '2026-09-01T00:00:00Z',
    }, at)).toBe(true);
  });

  it('never suppresses once expired, whatever the dates say', () => {
    expect(isInForce({ status: DNC_STATUS.EXPIRED, effective_from: '2020-01-01T00:00:00Z' }, at)).toBe(false);
  });
});

describe('scope', () => {
  it('global covers everything', () => {
    expect(scopeCovers({ scope: DNC_SCOPE.GLOBAL }, { vertical: 'mva' })).toBe(true);
    expect(scopeCovers({ scope: DNC_SCOPE.GLOBAL }, {})).toBe(true);
    // An entry with no scope set is treated as global, which is the safe default.
    expect(scopeCovers({}, {})).toBe(true);
  });

  it('vertical covers only its own vertical', () => {
    const e = { scope: DNC_SCOPE.VERTICAL, scope_value: 'mva' };
    expect(scopeCovers(e, { vertical: 'mva' })).toBe(true);
    expect(scopeCovers(e, { vertical: 'workers_comp' })).toBe(false);
    expect(scopeCovers(e, {})).toBe(false);
  });

  it('campaign covers only its own campaign', () => {
    const e = { scope: DNC_SCOPE.CAMPAIGN, scope_value: 'c1' };
    expect(scopeCovers(e, { campaign_id: 'c1' })).toBe(true);
    expect(scopeCovers(e, { campaign_id: 'c2' })).toBe(false);
  });

  it('a narrow entry with no scope value covers nothing', () => {
    // An incompletely configured entry does nothing rather than suppressing
    // everyone, which would be the other, much louder failure.
    expect(scopeCovers({ scope: DNC_SCOPE.VERTICAL }, { vertical: 'mva' })).toBe(false);
  });
});

describe('evaluateSuppression', () => {
  it('suppresses on an in-force global entry and reports a stable reason', () => {
    const v = evaluateSuppression({
      entries: [{ id: 'd1', contact_kind: 'phone', status: DNC_STATUS.ACTIVE, reason: 'consumer request' }],
    });
    expect(v.suppressed).toBe(true);
    expect(v.matched).toBe('phone');
    expect(v.reason).toBe(DNC_REJECTION.code);
    expect(v.reason).toBe('DNC_SUPPRESSED');
    expect(v.message).toBe(DNC_REJECTION.message);
    expect(v.entry_reason).toBe('consumer request');
  });

  it('does not suppress when nothing matched', () => {
    expect(evaluateSuppression({ entries: [] }).suppressed).toBe(false);
  });

  it('ignores an expired entry but honours an active one alongside it', () => {
    const v = evaluateSuppression({
      entries: [
        { id: 'd1', contact_kind: 'phone', status: DNC_STATUS.EXPIRED },
        { id: 'd2', contact_kind: 'phone', status: DNC_STATUS.ACTIVE },
      ],
    });
    expect(v.suppressed).toBe(true);
    expect(v.entry_id).toBe('d2');
  });

  it('never echoes the contact value in its verdict', () => {
    const v = evaluateSuppression({
      entries: [{ id: 'd1', contact_kind: 'phone', contact_hash: 'abc', status: DNC_STATUS.ACTIVE }],
    });
    expect(JSON.stringify(v)).not.toContain('abc');
  });
});

describe('contactHashesFor', () => {
  it('hashes both contact fields and reports which could not be read', () => {
    const { hashes, unresolvable } = contactHashesFor({ phone: '5125551234', email: 'nope' });
    expect(hashes.map((h) => h.kind)).toEqual(['phone']);
    expect(hashes[0].hash).toBe(hashContact('phone', '5125551234'));
    // An unreadable contact is reported, not silently treated as clean.
    expect(unresolvable).toEqual(['email']);
  });

  it('skips absent fields without calling them unresolvable', () => {
    const { hashes, unresolvable } = contactHashesFor({ phone: '5125551234' });
    expect(hashes).toHaveLength(1);
    expect(unresolvable).toEqual([]);
  });
});

describe('dncManage service function', () => {
  let ctx;
  beforeEach(() => { ctx = null; });

  it('adds an entry, storing a hash and a mask but never the raw value', async () => {
    ctx = makeCtx({ user: OWNER, body: { op: 'add', kind: 'phone', value: '(512) 555-1234', reason: 'consumer request' } });
    const res = await dncManage(ctx);

    expect(res.status).toBe(200);
    const stored = ctx.__store[0];
    expect(stored.contact_hash).toBe(hashContact('phone', '5125551234'));
    expect(JSON.stringify(ctx.__store)).not.toContain('5125551234');
    expect(stored.contact_display).toBe('+1********34');
    expect(stored.actor).toBe('u1');
    expect(stored.status).toBe('active');
    expect(JSON.stringify(res.payload)).not.toContain('5125551234');
  });

  it('requires a reason', async () => {
    ctx = makeCtx({ user: OWNER, body: { op: 'add', kind: 'phone', value: '5125551234' } });
    expect((await dncManage(ctx)).status).toBe(400);
    expect(ctx.__store).toHaveLength(0);
  });

  it('refuses a narrow scope with no scope value', async () => {
    ctx = makeCtx({ user: OWNER, body: { op: 'add', kind: 'phone', value: '5125551234', reason: 'x', scope: 'vertical' } });
    expect((await dncManage(ctx)).status).toBe(400);
  });

  it('finds a suppressed contact however it is written', async () => {
    ctx = makeCtx({
      user: MANAGER,
      body: { op: 'check', contacts: [{ kind: 'phone', value: '+1 512 555 1234' }] },
      rows: [{ id: 'd1', contact_kind: 'phone', contact_hash: hashContact('phone', '5125551234'), status: 'active' }],
    });
    const res = await dncManage(ctx);
    expect(res.payload.suppressed).toBe(true);
    expect(res.payload.results[0].reason).toBe('DNC_SUPPRESSED');
  });

  it('reports an unreadable contact as not checkable rather than clean', async () => {
    ctx = makeCtx({ user: MANAGER, body: { op: 'check', contacts: [{ kind: 'phone', value: 'garbage' }] } });
    const res = await dncManage(ctx);
    expect(res.payload.results[0].checkable).toBe(false);
    expect(res.payload.suppressed).toBe(false);
  });

  it('expires an entry without deleting it', async () => {
    ctx = makeCtx({
      user: OWNER,
      body: { op: 'expire', id: 'd1', reason: 'consumer re-consented' },
      rows: [{ id: 'd1', contact_kind: 'phone', contact_hash: 'h', status: 'active' }],
    });
    const res = await dncManage(ctx);
    expect(res.payload.success).toBe(true);
    // Still present, still auditable.
    expect(ctx.__store).toHaveLength(1);
    expect(ctx.__store[0].status).toBe('expired');
    expect(ctx.__store[0].expired_by).toBe('u1');
    expect(ctx.__store[0].expired_reason).toBe('consumer re-consented');
  });

  it('is idempotent on expiring an already expired entry', async () => {
    ctx = makeCtx({
      user: OWNER,
      body: { op: 'expire', id: 'd1' },
      rows: [{ id: 'd1', contact_kind: 'phone', contact_hash: 'h', status: 'expired', expired_by: 'someone_else' }],
    });
    const res = await dncManage(ctx);
    expect(res.payload.already_expired).toBe(true);
    expect(ctx.__store[0].expired_by).toBe('someone_else');
  });

  it('imports in bulk and reports counts without leaking the list', async () => {
    ctx = makeCtx({
      user: OWNER,
      body: {
        op: 'import',
        batch_id: 'batch1',
        entries: [
          { kind: 'phone', value: '5125551234' },
          { kind: 'phone', value: '(512) 555-1234' },
          { kind: 'email', value: 'ada@example.com' },
          { kind: 'phone', value: 'garbage' },
        ],
      },
    });
    const res = await dncManage(ctx);

    expect(res.payload.received).toBe(4);
    expect(res.payload.added).toBe(2);
    expect(res.payload.duplicate).toBe(1);
    expect(res.payload.rejected).toBe(1);
    // The rejection report names the row, not the contact.
    expect(res.payload.rejected_rows).toEqual([
      { row: 4, kind: 'phone', reason: 'not a valid contact of this kind' },
    ]);
    expect(JSON.stringify(res.payload)).not.toContain('5125551234');
    expect(JSON.stringify(res.payload)).not.toContain('ada@example.com');
    expect(ctx.__store.every((r) => r.import_batch_id === 'batch1')).toBe(true);
  });

  it('refuses a portal account', async () => {
    ctx = makeCtx({ user: BUYER_PORTAL, body: { op: 'check', contacts: [] } });
    expect((await dncManage(ctx)).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    ctx = makeCtx({ user: null, body: { op: 'check', contacts: [] } });
    expect((await dncManage(ctx)).status).toBe(403);
  });

  it('fails closed with 503 when the hash key is not configured', async () => {
    const saved = process.env.DNC_HASH_KEY;
    delete process.env.DNC_HASH_KEY;

    ctx = makeCtx({ user: OWNER, body: { op: 'check', contacts: [{ kind: 'phone', value: '5125551234' }] } });
    const res = await dncManage(ctx);

    // Returning "not suppressed" here would contact people who opted out, so
    // the endpoint refuses to answer at all.
    expect(res.status).toBe(503);
    expect(res.payload.code).toBe('DNC_KEY_MISSING');

    process.env.DNC_HASH_KEY = saved;
  });
});
