// Integration credential blob handling. Task S4.
//
// IntegrationConfig.config is a JSON encoded string holding a mix of secrets
// (api_token, secret_key, access_token, ...) and ordinary settings (account_id,
// tenant_id, last_synced_at, ...). The generic entity route read-denies the
// whole field, which is correct for the secrets and broke every settings dialog
// for the settings.
//
// The failure was not theoretical. Each dialog did:
//
//   parsed = JSON.parse(record.config || '{}')   // now always {}
//   next   = { ...parsed, ...typedFields }       // merge base is gone
//   update(id, { config: JSON.stringify(next) })  // stored secret destroyed
//
// so opening a connected integration and pressing save wiped the token, while
// the dialog still displayed "Leave blank to keep current". This module and the
// service functions that use it move the read-modify-write to the server, where
// the real stored value is available, and let the client send only what the
// operator actually typed.

// Keys whose values must never be sent to a client. Matched case insensitively
// against the whole key name and as a substring, so `api_token`, `apiToken`,
// `refresh_token` and `oauth_token_secret` are all caught.
const SECRET_KEY_PATTERNS = [
  'secret',
  'token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'private',
  'credential',
];

// Explicit exceptions: names that match a pattern above but are not secret.
// `phone_number_id` is an identifier, not a credential. `token_expires_at` is a
// timestamp. Keep this list short and justified.
const NOT_SECRET = new Set([
  'phone_number_id',
  'token_expires_at',
  'token_type',
  'last_synced_at',
]);

// Per-integration exceptions, for values that match a secret name pattern but
// are genuinely public for that integration.
//
// The Google Picker runs in the browser. Its API key is origin restricted and
// its client id is sent to Google on every sign in, so both have to reach the
// page or the picker cannot initialize at all. Classifying them as secrets
// would not protect anything; it would only break the feature. Note that
// `api_key` stays secret everywhere else, which is what Rebrandly stores.
//
// An entry here is a deliberate, reviewed disclosure. Keep it short.
const PUBLIC_KEYS_BY_INTEGRATION = {
  google_picker: ['api_key', 'client_id', 'app_id'],
};

export function isSecretKey(name, integrationName = '') {
  const key = String(name || '').toLowerCase();
  if (!key) return false;

  const publicForIntegration = PUBLIC_KEYS_BY_INTEGRATION[String(integrationName || '').toLowerCase()];
  if (publicForIntegration && publicForIntegration.includes(key)) return false;

  if (NOT_SECRET.has(key)) return false;
  return SECRET_KEY_PATTERNS.some((p) => key.includes(p));
}

// Parse a stored config string. Never throws: a corrupt blob reads as empty
// rather than failing the request, and the caller can see that it was corrupt.
export function parseConfig(raw) {
  if (raw === null || raw === undefined || raw === '') return { config: {}, corrupt: false };
  if (typeof raw === 'object') return { config: { ...raw }, corrupt: false };
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed, corrupt: false };
    }
    return { config: {}, corrupt: true };
  } catch {
    return { config: {}, corrupt: true };
  }
}

// Merge an incoming partial update over the stored config.
//
// Contract, and the whole point of the task:
//   - a key absent from `values` is left exactly as stored
//   - a key present in `values` replaces the stored value
//   - a key present in `values` with an empty string is treated as "not
//     supplied" when omitBlank is on, which is what every dialog's
//     "leave blank to keep current" placeholder already promises
//   - a key named in `clear` is removed, which is the only way to unset one
//
// Clearing is explicit precisely because blanking is not. An operator who wants
// a field gone has to say so.
export function mergeConfig(stored, values, { clear = [], omitBlank = true } = {}) {
  const next = { ...(stored || {}) };
  const incoming = values && typeof values === 'object' && !Array.isArray(values) ? values : {};

  for (const [key, value] of Object.entries(incoming)) {
    if (omitBlank && (value === '' || value === null || value === undefined)) continue;
    next[key] = value;
  }

  for (const key of Array.isArray(clear) ? clear : []) {
    delete next[String(key)];
  }

  return next;
}

// The client-safe view of a config blob.
//
// Non-secret settings are returned by value, because the dialogs need them to
// prefill (an account id, a tenant id, a category list). Secret values are
// replaced by presence only. Nothing here ever carries secret material, so this
// is safe to hand to any caller already authorized to manage the integration.
export function projectConfig(config, integrationName = '') {
  const values = {};
  const secrets = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (isSecretKey(key, integrationName)) {
      secrets[key] = { set: value !== '' && value !== null && value !== undefined };
    } else {
      values[key] = value;
    }
  }
  return { values, secrets, keys: Object.keys(config || {}).sort() };
}

export default { isSecretKey, parseConfig, mergeConfig, projectConfig };
