// Production startup validation.
//
// The server used to fall back to a known development JWT secret, which meant a
// production deploy that forgot to set JWT_SECRET would happily sign tokens
// anyone could forge. Missing configuration must stop the boot, not be papered
// over with a default.
//
// Development and test are left permissive on purpose: a local checkout should
// run without a secret ceremony. The checks bite when NODE_ENV is production.

// The value config.js falls back to when JWT_SECRET is unset. Anything equal to
// this, or obviously a placeholder, is refused in production.
export const DEV_JWT_SECRET = 'dev-insecure-change-me';

const PLACEHOLDER_SECRETS = new Set([
  DEV_JWT_SECRET,
  'change-me-to-a-long-random-string',
  'changeme',
  'secret',
  'password',
  'test',
]);

const MIN_SECRET_LENGTH = 32;

// Only these three hostnames may serve production-like mode over plain http.
// Running the local checkout with NODE_ENV=production is how a build is proved
// before deployment, and no certificate exists for localhost.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isProduction(env) {
  return String(env || '').toLowerCase() === 'production';
}

// Compare the parsed hostname, never a prefix of the string. A substring test
// would accept http://localhost.attacker.example, which is not loopback at all.
// An unparseable value is not loopback, so it stays subject to the https rule.
export function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(String(value));
    return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Returns a list of problems. Empty means the configuration is acceptable.
export function collectStartupProblems(config, env = process.env) {
  const problems = [];
  if (!isProduction(config.env)) return problems;

  const secret = config.auth?.jwtSecret ?? '';

  if (!secret) {
    problems.push('JWT_SECRET is not set. Production will not start without it.');
  } else if (PLACEHOLDER_SECRETS.has(secret) || /^(change|placeholder|example)/i.test(secret)) {
    problems.push(
      'JWT_SECRET is still a development or placeholder value. Generate a unique random secret for this environment.',
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters. Use a long random value.`);
  }

  // A production deploy behind TLS needs to know its own origin to set cookies
  // and build links correctly.
  if (!config.publicBaseUrl) {
    problems.push('PUBLIC_BASE_URL is not set. It is required in production for cookies and emailed links.');
  } else if (!/^https:\/\//i.test(config.publicBaseUrl) && !isLoopbackUrl(config.publicBaseUrl)) {
    problems.push('PUBLIC_BASE_URL must be an https URL in production, except on loopback.');
  }

  // A database must be configured explicitly rather than falling back to the
  // local development defaults.
  const db = config.db || {};
  if (!db.connectionString && !env.PGHOST && !env.PGDATABASE) {
    problems.push('No database is configured. Set DATABASE_URL, or PGHOST and PGDATABASE.');
  }
  if (!db.connectionString && (env.PGPASSWORD ?? '') === 'postgres') {
    problems.push('PGPASSWORD is still the default value. Set a real database password.');
  }

  return problems;
}

// Throw if production configuration is unsafe. Called during boot, before the
// server begins listening.
export function assertStartupConfig(config, env = process.env) {
  const problems = collectStartupProblems(config, env);
  if (problems.length === 0) return;

  const message = [
    'Refusing to start in production with unsafe configuration:',
    ...problems.map((p) => `  - ${p}`),
    '',
    'Fix the environment and start again. See server/.env.example.',
  ].join('\n');

  throw new Error(message);
}

export default { DEV_JWT_SECRET, isProduction, collectStartupProblems, assertStartupConfig };
