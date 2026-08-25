// Concurrency-safe cap/reservation store built on the ONE atomic primitive the backend
// is proven to provide: compare-and-swap via updateMany on an expected value
// (the same pattern processLead.nextLeadId uses). No assumed DB unique index, no
// assumed cross-entity transaction (both unverified - see PRODUCTION-BLOCKERS
// CAP-3). If a later live verification shows CAS is insufficient, that is the
// PB-008/009 stop-and-present point, not a silent downgrade.
//
// Interface (all async):
//   incrementIfBelow(key, limit, meta?) -> boolean  // atomic: increments iff count < limit;
//                                                    // meta populates reporting columns on first create only
//   decrement(key) -> void
//   getCount(key) -> number
//   claim(key) -> boolean                      // atomic 0->1; true only for the first caller
//   putReservation(rec) -> rec
//   getReservation(idempotencyKey, memberId) -> rec | null
//   awaitReservation(idempotencyKey, memberId) -> rec   // resolves once the owner writes it
//   updateReservation(id, patch) -> void

// ---- Honest in-memory CAS store (for tests) ----
// Models real CAS: every increment reads a versioned value, yields (opening the
// race window so concurrent callers interleave), then commits ONLY if the version
// is unchanged, else retries. This is what a correct the backend CAS loop does.
export function makeInMemoryCasStore({ yieldFn } = {}) {
  const counters = new Map(); // key -> { value, version }
  const claims = new Map();   // key -> true
  const reservations = [];
  let seq = 0;
  const microYield = yieldFn || (() => new Promise((r) => setTimeout(r, 0)));

  async function incrementIfBelow(key, limit, meta = null, maxRetry = 100) {
    void meta; // no reporting columns in the in-memory test double
    for (let i = 0; i < maxRetry; i++) {
      const cur = counters.get(key) || { value: 0, version: 0 };
      const { value, version } = cur;
      await microYield(); // race window: other callers may run between read and commit
      if (value >= limit) return false;
      const latest = counters.get(key) || { value: 0, version: 0 };
      if (latest.version !== version) continue; // CAS lost -> retry
      counters.set(key, { value: value + 1, version: version + 1 });
      return true;
    }
    return false;
  }

  async function decrement(key) {
    for (let i = 0; i < 100; i++) {
      const cur = counters.get(key) || { value: 0, version: 0 };
      const { value, version } = cur;
      await microYield();
      const latest = counters.get(key) || { value: 0, version: 0 };
      if (latest.version !== version) continue;
      counters.set(key, { value: Math.max(0, value - 1), version: version + 1 }); // never negative
      return;
    }
  }

  async function getCount(key) { return (counters.get(key) || { value: 0 }).value; }

  // Atomic claim: exactly one concurrent caller sees the transition to claimed.
  // Modeled as a value-0-to-1 CAS on a dedicated key. Uses its OWN `claims`
  // map, deliberately separate from `counters`/getCount - so a read-only
  // "has this been claimed" peek must go through isClaimed below, never
  // through getCount('claim:'+key) (that would only happen to work for the
  // entity adapter, whose claim() is itself built on incrementIfBelow).
  async function claim(key) {
    const cur = claims.get(key);
    await microYield();
    if (claims.get(key)) return false; // already claimed (post-yield recheck)
    if (cur) return false;
    claims.set(key, true);
    return true;
  }

  // Read-only: has `key` been claimed (by anyone, ever)? Never mutates.
  async function isClaimed(key) { return !!claims.get(key); }

  async function putReservation(rec) {
    const row = { ...rec, id: 'r' + (++seq) };
    reservations.push(row);
    return row;
  }
  async function getReservation(idempotencyKey, memberId) {
    return reservations.find((r) => r.idempotency_key === idempotencyKey && r.route_member_id === memberId) || null;
  }
  async function awaitReservation(idempotencyKey, memberId, tries = 1000) {
    for (let i = 0; i < tries; i++) {
      const r = await getReservation(idempotencyKey, memberId);
      if (r) return r;
      await microYield();
    }
    return null;
  }
  async function updateReservation(id, patch) {
    const r = reservations.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }

  return {
    incrementIfBelow, decrement, getCount, claim, isClaimed,
    putReservation, getReservation, awaitReservation, updateReservation,
    _debug: { counters, reservations },
  };
}

// ---- Real the backend adapter (runs when deployed; NEEDS-ENV to verify live) ----
// Uses CapCounter for windowed counts and a claim CapCounter for dedup, each via
// updateMany CAS. `db` is api.asServiceRole.
//
// scope_key is the ONE canonical lookup key, used by every reader and writer
// (this store, and snapshotLoader.js's eligibility pre-check) so the two can
// never independently drift into different key shapes for the same scope
// (a prior version of snapshotLoader.js queried by scope_type/scope_id/window,
// fields this store never wrote, so an exhausted cap silently reported as
// eligible at the trace/snapshot level even though the atomic reserve()
// below correctly blocked it). scope_type/scope_id/window/window_start/limit
// are populated at row-creation time, from the same key components, purely
// for operator reporting/debugging - never read back for matching.
export function makeEntityCapStore(db) {
  async function ensureCounter(key, meta) {
    // create-if-missing, then reconcile to a single canonical row (lowest id) so
    // a concurrent create does not leave uncontrolled duplicates.
    let rows = await db.entities.CapCounter.filter({ scope_key: key });
    if (!rows.length) {
      try {
        await db.entities.CapCounter.create({ scope_key: key, count: 0, ...(meta || {}) });
      } catch (err) {
        // A concurrent first-time caller on this exact key can win the real
        // DB-level unique constraint on scope_key (server/src/db/schema.js)
        // between this function's own empty pre-check filter and its
        // create() call. That is not a failure - it means the counter now
        // genuinely exists, just not created by us; fall through to re-read
        // it. Only a filter that comes back STILL empty after this means
        // something is actually broken, and that original error is what
        // propagates.
        rows = await db.entities.CapCounter.filter({ scope_key: key });
        if (!rows.length) throw err;
      }
      if (!rows.length) rows = await db.entities.CapCounter.filter({ scope_key: key });
    }
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return rows[0];
  }

  async function incrementIfBelow(key, limit, meta = null, maxRetry = 25) {
    for (let i = 0; i < maxRetry; i++) {
      const row = await ensureCounter(key, meta);
      const value = Number(row.count || 0);
      if (value >= limit) return false;
      // CAS: only update the row still at the expected count.
      const res = await db.entities.CapCounter.updateMany(
        { id: row.id, count: value }, { $set: { count: value + 1 } },
      );
      if (res && res.updated > 0) return true; // won the CAS
      // else another writer moved the count; retry
    }
    return false;
  }

  async function decrement(key) {
    for (let i = 0; i < 25; i++) {
      const row = await ensureCounter(key);
      const value = Number(row.count || 0);
      const next = Math.max(0, value - 1);
      const res = await db.entities.CapCounter.updateMany(
        { id: row.id, count: value }, { $set: { count: next } },
      );
      if (res && res.updated > 0) return;
    }
  }

  async function getCount(key) {
    const row = await ensureCounter(key);
    return Number(row.count || 0);
  }

  async function claim(key) {
    // claim is incrementIfBelow(key, 1): only the first caller wins 0 -> 1.
    return incrementIfBelow(`claim:${key}`, 1);
  }

  // Read-only: has `key` been claimed (by anyone, ever)? Queries directly
  // rather than through ensureCounter, so a peek never creates a row as a
  // side effect.
  async function isClaimed(key) {
    const rows = await db.entities.CapCounter.filter({ scope_key: `claim:${key}` });
    return !!(rows && rows[0] && Number(rows[0].count || 0) >= 1);
  }

  async function getReservation(idempotencyKey, memberId) {
    const rows = await db.entities.CapReservation.filter({ idempotency_key: idempotencyKey, route_member_id: memberId });
    return rows[0] || null;
  }
  async function awaitReservation(idempotencyKey, memberId, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const r = await getReservation(idempotencyKey, memberId);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    return null;
  }
  async function putReservation(rec) { return db.entities.CapReservation.create(rec); }
  async function updateReservation(id, patch) { return db.entities.CapReservation.update(id, patch); }

  return { incrementIfBelow, decrement, getCount, claim, isClaimed, getReservation, awaitReservation, putReservation, updateReservation };
}
