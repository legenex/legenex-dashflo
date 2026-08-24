import { describe, it, expect } from 'vitest';
import { CIRCUIT, nextHealth, isBlocked, makeInMemoryHealthStore, makeEntityHealthStore } from './destinationHealth.js';

const NOW = Date.parse('2026-08-25T00:00:00Z');

describe('nextHealth (pure decision logic)', () => {
  it('a success always resets to closed with zero consecutive failures', () => {
    const h = nextHealth({ state: CIRCUIT.OPEN, consecutive_failures: 4 }, true, NOW);
    expect(h.state).toBe(CIRCUIT.CLOSED);
    expect(h.consecutive_failures).toBe(0);
    expect(h.disabled_until).toBe(null);
    expect(h.last_success_at).toBe(new Date(NOW).toISOString());
  });

  it('stays closed below the failure threshold', () => {
    const h = nextHealth(null, false, NOW, { failureThreshold: 5 });
    expect(h.state).toBe(CIRCUIT.CLOSED);
    expect(h.consecutive_failures).toBe(1);
    expect(h.disabled_until).toBe(null);
  });

  it('opens exactly at the failure threshold and sets a cooldown', () => {
    let h = null;
    for (let i = 0; i < 4; i++) h = nextHealth(h, false, NOW, { failureThreshold: 5, cooldownMs: 60000 });
    expect(h.state).toBe(CIRCUIT.CLOSED);
    h = nextHealth(h, false, NOW, { failureThreshold: 5, cooldownMs: 60000 });
    expect(h.state).toBe(CIRCUIT.OPEN);
    expect(h.consecutive_failures).toBe(5);
    expect(h.disabled_until).toBe(new Date(NOW + 60000).toISOString());
  });

  it('a further failure while already open keeps it open (does not reset the cooldown clock backwards)', () => {
    const opened = nextHealth({ state: CIRCUIT.OPEN, consecutive_failures: 5, disabled_until: new Date(NOW).toISOString() }, false, NOW + 1000, { failureThreshold: 5 });
    expect(opened.state).toBe(CIRCUIT.OPEN);
    expect(opened.consecutive_failures).toBe(6);
  });
});

describe('isBlocked (cooldown-aware read side)', () => {
  it('closed is never blocked', () => {
    expect(isBlocked({ state: CIRCUIT.CLOSED }, NOW)).toBe(false);
  });
  it('open and still within the cooldown window is blocked', () => {
    expect(isBlocked({ state: CIRCUIT.OPEN, disabled_until: new Date(NOW + 1000).toISOString() }, NOW)).toBe(true);
  });
  it('open past the cooldown window is not blocked (half-open trial allowed)', () => {
    expect(isBlocked({ state: CIRCUIT.OPEN, disabled_until: new Date(NOW - 1000).toISOString() }, NOW)).toBe(false);
  });
  it('open with no disabled_until at all is not blocked (fails open rather than blocking forever on bad data)', () => {
    expect(isBlocked({ state: CIRCUIT.OPEN }, NOW)).toBe(false);
  });
  it('no record at all is not blocked', () => {
    expect(isBlocked(null, NOW)).toBe(false);
  });
});

describe('makeInMemoryHealthStore key normalization', () => {
  it('sub_delivery_id and destination_id are independent keys', async () => {
    const store = makeInMemoryHealthStore();
    await store.recordResult({ subDeliveryId: 'sd1' }, false, NOW);
    await store.recordResult({ destinationId: 'd1' }, false, NOW);
    const bySd = await store.get({ subDeliveryId: 'sd1' });
    const byDest = await store.get({ destinationId: 'd1' });
    expect(bySd.consecutive_failures).toBe(1);
    expect(byDest.consecutive_failures).toBe(1);
    // Recording again against sub_delivery_id must not touch the destination_id-keyed record.
    await store.recordResult({ subDeliveryId: 'sd1' }, false, NOW);
    expect((await store.get({ subDeliveryId: 'sd1' })).consecutive_failures).toBe(2);
    expect((await store.get({ destinationId: 'd1' })).consecutive_failures).toBe(1);
  });

  it('accepts a bare string key as legacy destination_id, for backward compatibility', async () => {
    const store = makeInMemoryHealthStore();
    await store.recordResult('legacy-dest-1', false, NOW);
    expect((await store.get('legacy-dest-1')).consecutive_failures).toBe(1);
    expect((await store.get({ destinationId: 'legacy-dest-1' })).consecutive_failures).toBe(1);
  });
});

describe('makeEntityHealthStore key normalization (backend adapter)', () => {
  function fakeDb() {
    const rows = [];
    let nextId = 1;
    return {
      rows,
      entities: {
        DestinationHealth: {
          async filter(q) {
            return rows.filter((r) => Object.entries(q).every(([k, v]) => r[k] === v));
          },
          async create(rec) {
            const row = { id: `h${nextId++}`, ...rec };
            rows.push(row);
            return row;
          },
          async update(id, patch) {
            const row = rows.find((r) => r.id === id);
            Object.assign(row, patch);
            return row;
          },
        },
      },
    };
  }

  it('prefers sub_delivery_id as the lookup key when present', async () => {
    const db = fakeDb();
    const store = makeEntityHealthStore(db);
    await store.recordResult({ subDeliveryId: 'sd1', destinationId: 'd1-legacy-alias' }, false, NOW);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].sub_delivery_id).toBe('sd1');
    // Second call with the same subDeliveryId must update the same row, not create a second.
    await store.recordResult({ subDeliveryId: 'sd1', destinationId: 'd1-legacy-alias' }, false, NOW);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].consecutive_failures).toBe(2);
  });

  it('falls back to destination_id when no sub_delivery_id is known (legacy path)', async () => {
    const db = fakeDb();
    const store = makeEntityHealthStore(db);
    await store.recordResult({ destinationId: 'd1' }, false, NOW);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].destination_id).toBe('d1');
    expect(db.rows[0].sub_delivery_id).toBe(null);
  });

  it('always writes a non-null destination_id (schema requires it) even for a native-only key', async () => {
    const db = fakeDb();
    const store = makeEntityHealthStore(db);
    await store.recordResult({ subDeliveryId: 'sd1' }, false, NOW);
    expect(db.rows[0].destination_id).toBe('sd1'); // carried over, not left null
  });
});
