// The one place DashFlo decides what its own URLs are.
//
// Before this module, a dozen call sites each carried their own
// 'https://api.legenex.com' string as a fallback. Those hosts belong to the
// retired Base44-era deployment, not to DashFlo, so any request that reached a
// fallback silently addressed someone else's system: posting specs handed to
// suppliers, OAuth redirect URIs, and the public lead endpoint all pointed off
// this install. A hardcoded host is never evidence of where this application is
// deployed.
//
// Resolution order, first usable value wins:
//   1. the public_base_url application setting, when the caller passes one
//   2. PUBLIC_BASE_URL from the environment
//   3. the loopback default, which is where a local checkout actually serves
//
// There is deliberately no remote-host default. If a deployment forgets to set
// PUBLIC_BASE_URL it addresses itself on loopback, which fails locally and
// loudly, rather than succeeding against a host nobody controls.

import config from '../config.js';

export const LOOPBACK_BASE_URL = 'http://localhost:4000';

// Retired hosts. Kept only so resolution can reject them if one survives in a
// stored application setting or a stale environment variable.
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

// settingValue is the stored public_base_url application setting, when the
// caller has one loaded. Everything else falls back through the chain above.
export function resolveBaseUrl(settingValue, env = process.env) {
  for (const candidate of [settingValue, env.PUBLIC_BASE_URL, config.publicBaseUrl]) {
    if (usable(candidate)) return stripTrailingSlashes(candidate);
  }
  return LOOPBACK_BASE_URL;
}

// Where suppliers post leads, where webhooks and OAuth callbacks arrive. A
// split-host deployment uses PUBLIC_API_BASE_URL; single-host installs fall
// back to PUBLIC_BASE_URL.
export const resolveApiBaseUrl = (settingValue, env = process.env) =>
  [settingValue, env.PUBLIC_API_BASE_URL, env.PUBLIC_BASE_URL, config.publicApiBaseUrl, config.publicBaseUrl]
    .find(usable)
    ?.replace(/\/+$/, '') || LOOPBACK_BASE_URL;

export const leadsEndpoint = (settingValue, env = process.env) =>
  `${resolveApiBaseUrl(settingValue, env)}/functions/leads`;

export const functionUrl = (name, settingValue, env = process.env) =>
  `${resolveApiBaseUrl(settingValue, env)}/functions/${name}`;

export default {
  LOOPBACK_BASE_URL,
  isRetiredHost,
  resolveBaseUrl,
  resolveApiBaseUrl,
  leadsEndpoint,
  functionUrl,
};
