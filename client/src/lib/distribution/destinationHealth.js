// Destination circuit breaker. Opens after N consecutive failures, stays open for
// a cooldown, then half-opens; a success closes it. Pure decision logic over an
// injected health store (in-memory mock or the backend adapter).
//
// Stage 3: wired into the live path both ways. snapshot.js reads via
// isBlocked (below) to decide member eligibility (REASON.DESTINATION_UNHEALTHY
// in engine.js), pre-resolved to a boolean the same way withinSchedule
// already is, so a destination given a trial send during its half-open
// window is not permanently excluded from ever being retried - a plain
// `state === 'open'` check, which this replaces, could never observe a
// recovery because routing would exclude the destination before a result
// could ever be recorded again. distributeRun.js's real send path writes via
// recordResult after every real attempt.

export const CIRCUIT = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

export function nextHealth(cur, success, nowMs, opts = {}) {
  const threshold = opts.failureThreshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 60000;
  const h = cur || { state: CIRCUIT.CLOSED, consecutive_failures: 0 };
  if (success) {
    return { state: CIRCUIT.CLOSED, consecutive_failures: 0, last_success_at: new Date(nowMs).toISOString(), disabled_until: null };
  }
  const failures = (h.consecutive_failures || 0) + 1;
  const open = failures >= threshold;
  return {
    state: open ? CIRCUIT.OPEN : h.state === CIRCUIT.HALF_OPEN ? CIRCUIT.OPEN : CIRCUIT.CLOSED,
    consecutive_failures: failures,
    last_failure_at: new Date(nowMs).toISOString(),
    disabled_until: open ? new Date(nowMs + cooldownMs).toISOString() : (h.disabled_until || null),
  };
}

// Is the destination currently blocked from sending? Open until disabled_until,
// then half-open (allow a trial send).
export function isBlocked(h, nowMs) {
  if (!h || h.state === CIRCUIT.CLOSED) return false;
  if (h.state === CIRCUIT.OPEN) {
    if (h.disabled_until && Date.parse(h.disabled_until) > nowMs) return true;
    return false; // cooldown elapsed -> allow a half-open trial
  }
  return false;
}

// A health key identifies one endpoint. Per the DestinationHealth schema,
// sub_delivery_id is the canonical key (the breaker is per endpoint, i.e. per
// SubDelivery, not per buyer); destination_id is retained for the legacy
// (non-native) path only. Accepts either a bare string (treated as
// destination_id, for legacy callers) or { subDeliveryId, destinationId }.
function normalizeKey(key) {
  if (key && typeof key === 'object') {
    return { subDeliveryId: key.subDeliveryId || null, destinationId: key.destinationId || null };
  }
  return { subDeliveryId: null, destinationId: key || null };
}

export function makeInMemoryHealthStore() {
  const map = new Map();
  const mapKey = ({ subDeliveryId, destinationId }) => `sd:${subDeliveryId || ''}|d:${destinationId || ''}`;
  return {
    async get(key) { return map.get(mapKey(normalizeKey(key))) || null; },
    async set(key, h) { map.set(mapKey(normalizeKey(key)), h); return h; },
    async recordResult(key, success, nowMs, opts) {
      const k = mapKey(normalizeKey(key));
      const next = nextHealth(map.get(k), success, nowMs, opts);
      map.set(k, next);
      return next;
    },
    _debug: { map },
  };
}

export function makeEntityHealthStore(db) {
  async function get(rawKey) {
    const { subDeliveryId, destinationId } = normalizeKey(rawKey);
    if (subDeliveryId) {
      const rows = await db.entities.DestinationHealth.filter({ sub_delivery_id: subDeliveryId });
      if (rows[0]) return rows[0];
    }
    if (destinationId) {
      const rows = await db.entities.DestinationHealth.filter({ destination_id: destinationId });
      if (rows[0]) return rows[0];
    }
    return null;
  }
  return {
    get,
    async set(rawKey, h) {
      const { subDeliveryId, destinationId } = normalizeKey(rawKey);
      const cur = await get(rawKey);
      // destination_id is a required legacy column; when only a native
      // sub_delivery_id is known, carry it there too so the row still
      // satisfies the schema without inventing a second identity.
      const patch = { ...h, sub_delivery_id: subDeliveryId || null, destination_id: destinationId || subDeliveryId || null };
      if (cur) return db.entities.DestinationHealth.update(cur.id, patch);
      return db.entities.DestinationHealth.create(patch);
    },
    async recordResult(rawKey, success, nowMs, opts) {
      const cur = await get(rawKey);
      const next = nextHealth(cur, success, nowMs, opts);
      await this.set(rawKey, next);
      return next;
    },
  };
}
