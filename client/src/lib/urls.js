// The one place the DashFlo client decides what its own URLs are.
//
// Every base URL the browser needs resolves from the origin it was actually
// served from, or from configuration, never from a hardcoded host. The retired
// Base44-era legenex.com hosts are not DashFlo URLs, and a fallback that
// addresses them sends supplier posting instructions and OAuth callbacks to a
// system this install does not control.

export const LOOPBACK_BASE_URL = 'http://localhost:4000';

const RETIRED_HOST_PATTERN = /(^|\.)legenex\.com$/i;

const stripTrailingSlashes = (value) => String(value || '').replace(/\/+$/, '');

export function isRetiredHost(value) {
  try {
    return RETIRED_HOST_PATTERN.test(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

function usable(value) {
  if (!value) return false;
  try {
    const { protocol } = new URL(String(value));
    if (protocol !== 'http:' && protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return !isRetiredHost(value);
}

// settingValue is the public_base_url application setting when one is loaded.
// Same origin is preferred over any configured value, because the browser is
// already talking to the right server: that is what makes /api same-origin and
// keeps cookies working without CORS.
export function resolveBaseUrl(settingValue, loc = typeof window === 'undefined' ? null : window.location) {
  const sameOrigin = loc && loc.origin ? loc.origin : '';
  for (const candidate of [sameOrigin, settingValue]) {
    if (usable(candidate)) return stripTrailingSlashes(candidate);
  }
  return LOOPBACK_BASE_URL;
}

// Where suppliers post leads and where inbound webhooks arrive. Shown in the
// operator UI and copied by suppliers, so it must be this install's own host.
export const resolveApiBaseUrl = (settingValue, loc) => resolveBaseUrl(settingValue, loc);

export const leadsEndpoint = (settingValue, loc) =>
  `${resolveApiBaseUrl(settingValue, loc)}/functions/leads`;

export default { LOOPBACK_BASE_URL, isRetiredHost, resolveBaseUrl, resolveApiBaseUrl, leadsEndpoint };
