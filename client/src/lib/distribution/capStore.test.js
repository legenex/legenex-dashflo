import { describe, it, expect } from 'vitest';
import { makeInMemoryCasStore, makeEntityCapStore } from './capStore.js';

// The mock models real CAS: read a versioned value, yield (interleave), commit
// only if unchanged, else retry. These tests fail if the CAS logic is broken.

describe('CAS store incrementIfBelow (atomic under concurrency)', () => {
  it('25 concurrent increments against limit 5 yield exactly 5', async () => {
    const s = makeInMemoryCasStore();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => s.incrementIfBelow('cap', 5)),
    );
    expect(results.filter(Boolean).length).toBe(5);
    expect(await s.getCount('cap')).toBe(5);
  });

  it('never exceeds the limit even with many rounds', async () => {
    const s = makeInMemoryCasStore();
    const rounds = await Promise.all(Array.from({ length: 100 }, () => s.incrementIfBelow('cap', 10)));
    expect(rounds.filter(Boolean).length).toBe(10);
    expect(await s.getCount('cap')).toBe(10);
  });

  it('decrement never goes negative under concurrency', async () => {
    const s = makeInMemoryCasStore();
    await s.incrementIfBelow('cap', 100);
    await Promise.all(Array.from({ length: 10 }, () => s.decrement('cap')));
    expect(await s.getCount('cap')).toBe(0);
  });

  it('separate window keys are isolated', async () => {
    const s = makeInMemoryCasStore();
    await Promise.all([
      ...Array.from({ length: 10 }, () => s.incrementIfBelow('daily:2026-07-13', 3)),
      ...Array.from({ length: 10 }, () => s.incrementIfBelow('daily:2026-07-14', 3)),
    ]);
    expect(await s.getCount('daily:2026-07-13')).toBe(3);
    expect(await s.getCount('daily:2026-07-14')).toBe(3);
  });

  it('claim is won by exactly one concurrent caller', async () => {
    const s = makeInMemoryCasStore();
    const wins = await Promise.all(Array.from({ length: 12 }, () => s.claim('resv:k:m')));
    expect(wins.filter(Boolean).length).toBe(1);
  });

  it('isClaimed read-only-peeks a claim without mutating or itself claiming', async () => {
    const s = makeInMemoryCasStore();
    expect(await s.isClaimed('winner:lead-1')).toBe(false);
    await s.claim('winner:lead-1');
    expect(await s.isClaimed('winner:lead-1')).toBe(true);
    // A second real claim attempt still correctly loses; peeking never wins it.
    expect(await s.claim('winner:lead-1')).toBe(false);
  });
});

// Regression (adversarial review): the entity (real-database) store's
// ensureCounter did filter -> create-if-missing -> filter again, with NO
// database-level uniqueness backing it. Two concurrent FIRST-TIME callers on
// the exact same brand-new key could both see an empty pre-check filter and
// both successfully create their own row, so BOTH would then win their own
// independent CAS - defeating every exactly-once guarantee (cap windows, the
// lead-level winner claim, wallet claimTxn) built on top of this store.
// server/src/db/schema.js now adds a real unique index on scope_key;
// this simulates the resulting unique-constraint violation a real
// concurrent create would raise, and proves ensureCounter recovers by
// reading the row the other caller won rather than throwing or duplicating.
describe('makeEntityCapStore: concurrent first-time create on the same brand-new key', () => {
  function makeRacyDb({ yieldFn } = {}) {
    const rows = [];
    let seq = 0;
    const microYield = yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
    return {
      _debug: { rows },
      entities: {
        CapCounter: {
          async filter(q) {
            return rows.filter((r) => Object.entries(q).every(([k, v]) => r[k] === v));
          },
          async create(rec) {
            await microYield(); // real DB round-trip latency: the race window
            if (rows.some((r) => r.scope_key === rec.scope_key)) {
              const err = new Error('duplicate key value violates unique constraint "e_cap_counter_scope_key_idx"');
              err.code = '23505';
              throw err;
            }
            const row = { id: 'cc' + (++seq), ...rec };
            rows.push(row);
            return row;
          },
          async updateMany(match, { $set }) {
            const matches = rows.filter((r) => Object.entries(match).every(([k, v]) => r[k] === v));
            for (const r of matches) Object.assign(r, $set);
            return { updated: matches.length };
          },
        },
      },
    };
  }

  it('two concurrent first-time claims on the same key converge on exactly one row, and exactly one wins the claim', async () => {
    const db = makeRacyDb();
    const store = makeEntityCapStore(db);
    const [a, b] = await Promise.all([store.claim('winner:lead-1'), store.claim('winner:lead-1')]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(db._debug.rows.filter((r) => r.scope_key === 'claim:winner:lead-1')).toHaveLength(1); // one canonical row, not two
  });

  it('two concurrent first-time incrementIfBelow calls on the same brand-new cap window do not both succeed past the limit', async () => {
    const db = makeRacyDb();
    const store = makeEntityCapStore(db);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.incrementIfBelow('route_member:m1:daily:2026-08-25', 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // limit 1: exactly one caller succeeds
    expect(await store.getCount('route_member:m1:daily:2026-08-25')).toBe(1);
    expect(db._debug.rows.filter((r) => r.scope_key === 'route_member:m1:daily:2026-08-25')).toHaveLength(1);
  });
});
