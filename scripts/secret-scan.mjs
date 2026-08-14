// Repository secret scan.
//
// Invariant: never store authorization headers, cookies, raw API keys or
// secrets in lead payloads, logs, exports, fixtures, commits or prompts.
//
// This scans tracked files for credential-shaped literals. It is deliberately
// conservative about what counts as a finding, because a scanner that cries
// wolf gets disabled. Placeholder and example values are allowed by pattern,
// not by a path allowlist, so a real key cannot hide behind a fixture path.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SKIP_PATHS = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /package-lock\.json$/,
  /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip)$/i,
];

// Values that are obviously not live credentials.
const PLACEHOLDER = /^(?:|x{3,}|y{3,}|0+|1+|test|example|sample|placeholder|changeme|your[-_]?\w*|redacted|dummy|fake|none|null|undefined|<[^>]*>|\$\{[^}]*\}|process\.env\.\w+)$/i;

function isPlaceholder(value) {
  const v = String(value).trim();
  if (PLACEHOLDER.test(v)) return true;
  if (/redacted|example|placeholder|dummy|sample|your[-_]|xxxx|notareal|test[-_]?key/i.test(v)) return true;
  // Repeated single character, e.g. aaaaaaaaaaaa
  if (/^(.)\1{7,}$/.test(v)) return true;
  return false;
}

// A credential literal looks random. Field-name tokens (phone_verified,
// lead_age_days) and prose ("Authenticated by API key") do not, and matching
// them turns the scan into noise that gets switched off.
//
// The test: does the value contain an alphanumeric run of at least six
// characters that mixes at least two digits with at least two letters? That is
// what a generated key looks like and what a snake_case identifier or an
// English sentence does not.
function looksRandom(value) {
  const v = String(value).trim();
  if (/\s/.test(v)) return false; // prose, not a credential
  for (const run of v.match(/[A-Za-z0-9]{6,}/g) || []) {
    const digits = (run.match(/\d/g) || []).length;
    const letters = (run.match(/[A-Za-z]/g) || []).length;
    if (digits >= 2 && letters >= 2) return true;
  }
  // Long unbroken high-entropy strings (base64 / hex blobs) still count.
  return /[A-Za-z0-9+/=_-]{32,}/.test(v);
}

const RULES = [
  {
    id: 'private-key',
    // eslint-disable-next-line no-useless-escape
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    describe: () => 'PEM private key block',
    valueOf: () => null,
  },
  {
    id: 'aws-access-key',
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    describe: (m) => `AWS access key id (${m[0].slice(0, 4)}...)`,
    valueOf: (m) => m[0],
  },
  {
    id: 'stripe-key',
    re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g,
    describe: () => 'Stripe secret key',
    valueOf: (m) => m[0],
  },
  {
    id: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    describe: () => 'Slack token',
    valueOf: (m) => m[0],
  },
  {
    id: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    describe: () => 'Google API key',
    valueOf: (m) => m[0],
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    describe: () => 'JSON Web Token',
    valueOf: (m) => m[0],
  },
  {
    id: 'authorization-header-literal',
    re: /['"`]?[Aa]uthorization['"`]?\s*[:=]\s*['"`](?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})['"`]/g,
    describe: () => 'hardcoded Authorization header value',
    valueOf: (m) => m[1],
    requiresEntropy: true,
  },
  {
    id: 'assigned-secret',
    // key/secret/token/password assigned a long literal
    re: /\b(?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"`]([^'"`\n]{12,})['"`]/gi,
    describe: () => 'credential assigned a literal value',
    valueOf: (m) => m[1],
    requiresEntropy: true,
  },
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

const findings = [];

for (const rel of trackedFiles()) {
  if (SKIP_PATHS.some((re) => re.test(rel))) continue;
  const abs = path.join(repoRoot, rel);
  let content;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue; // binary

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(content)) !== null) {
      const value = rule.valueOf(m);
      if (value != null && isPlaceholder(value)) continue;
      if (rule.requiresEntropy && value != null && !looksRandom(value)) continue;
      const line = content.slice(0, m.index).split('\n').length;
      findings.push({ file: rel, line, rule: rule.id, describe: rule.describe(m) });
    }
  }
}

if (findings.length > 0) {
  console.error(`[secret-scan] ${findings.length} potential secret(s) found:`);
  for (const f of findings) {
    // Never print the matched value itself.
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.describe}`);
  }
  console.error('[secret-scan] Remove the literal and use a server-side secret reference instead.');
  process.exit(1);
}

console.log('[secret-scan] OK: no credential-shaped literals in tracked files.');
