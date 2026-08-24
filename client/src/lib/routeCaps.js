// Pure helpers for RouteMember.caps, the exact shape
// client/src/lib/distribution/engine.js's exhaustedCap gate reads:
//   { total: { limit }, hourly: { limit }, daily: { limit }, weekly: { limit }, monthly: { limit } }
// `count` is never written here - it is injected at evaluation time from the
// real CapCounter rows (snapshot.js). Split out from RouteCapsEditor.jsx so
// this can be unit tested without a DOM environment.

export const CAP_WINDOWS = [
  { key: 'total', label: 'Total (lifetime)' },
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

export function parseCaps(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function capLimit(caps, key) {
  const w = caps[key];
  if (w == null) return '';
  const n = typeof w === 'object' ? w.limit : w;
  return n == null ? '' : String(n);
}

export function withCapLimit(caps, key, raw) {
  const next = { ...caps };
  if (raw === '' || raw == null) {
    delete next[key];
  } else {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) next[key] = { limit: n };
  }
  return next;
}

export function serializeCaps(caps) {
  return Object.keys(caps).length ? JSON.stringify(caps) : '';
}
