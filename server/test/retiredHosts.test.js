// Regression guard for the DashFlo URL contract.
//
// The retired Base44-era hosts (dashboard.legenex.com, api.legenex.com,
// progress.dashboard.legenex.com) are not DashFlo URLs. They survived as
// executable fallbacks in a dozen call sites, so any request that reached a
// fallback silently addressed a system this install does not control: posting
// specs handed to suppliers, OAuth redirect URIs, the public lead endpoint.
//
// This test fails if such a literal is reintroduced into executable client or
// server code. Comments, tests and stored historical data are exempt: the rule
// is about what the running application can address, not about erasing the word
// from the repository.
//
// The public docs pages are deliberately NOT exempt. They render the posting
// endpoint and curl example that suppliers copy, so a stale host there sends
// paid traffic to the retired system just as effectively as a code fallback.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBaseUrl, isRetiredHost, LOOPBACK_BASE_URL, leadsEndpoint } from '../src/lib/urls.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCANNED_ROOTS = ['server/src', 'client/src'];

// Files whose whole purpose is to talk about the retired hosts.
const EXEMPT = [
  /\.test\.[jt]sx?$/,
  // Stored snapshot of a historical backend summary, not executable config.
  /(^|\/)client\/src\/lib\/progress\/backendSummary\.json$/,
];

function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z', ...SCANNED_ROOTS], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return out.filter(
    (rel) => /\.(js|jsx|mjs|json)$/.test(rel) && !EXEMPT.some((re) => re.test(rel)),
  );
}

// Strip comments so a explanatory line naming the old host is not a failure.
function executableText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

describe('retired hosts cannot return to executable code', () => {
  it('has no legenex.com literal in any executable client or server source', () => {
    const offenders = [];
    for (const rel of sourceFiles()) {
      const text = executableText(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      if (/legenex\.com/i.test(text)) {
        const line = text.split('\n').findIndex((l) => /legenex\.com/i.test(l)) + 1;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders, `retired host reintroduced in:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('url resolution never falls back to a retired host', () => {
  it('recognises the retired hosts', () => {
    for (const url of [
      'https://api.legenex.com',
      'https://dashboard.legenex.com/x',
      'https://progress.dashboard.legenex.com',
    ]) {
      expect(isRetiredHost(url), url).toBe(true);
    }
    for (const url of ['https://dashflo.co', 'https://api.dashflo.co', 'http://localhost:4000']) {
      expect(isRetiredHost(url), url).toBe(false);
    }
  });

  it('refuses a retired host stored in the application setting', () => {
    expect(resolveBaseUrl('https://api.legenex.com', {})).toBe(LOOPBACK_BASE_URL);
  });

  it('refuses a retired host left in the environment', () => {
    expect(resolveBaseUrl('', { PUBLIC_BASE_URL: 'https://api.legenex.com' })).toBe(LOOPBACK_BASE_URL);
  });

  it('prefers the application setting, then the environment', () => {
    expect(resolveBaseUrl('https://api.dashflo.co', { PUBLIC_BASE_URL: 'http://localhost:4000' }))
      .toBe('https://api.dashflo.co');
    expect(resolveBaseUrl('', { PUBLIC_BASE_URL: 'https://api.dashflo.co' })).toBe('https://api.dashflo.co');
  });

  it('falls back to loopback rather than a remote host when nothing is configured', () => {
    expect(resolveBaseUrl('', {})).toBe(LOOPBACK_BASE_URL);
    expect(leadsEndpoint('', {})).toBe(`${LOOPBACK_BASE_URL}/functions/leads`);
  });

  it('ignores a value that is not a usable url', () => {
    expect(resolveBaseUrl('not a url', {})).toBe(LOOPBACK_BASE_URL);
    expect(resolveBaseUrl('javascript:alert(1)', {})).toBe(LOOPBACK_BASE_URL);
  });

  it('strips trailing slashes so joined paths do not double up', () => {
    expect(resolveBaseUrl('https://api.dashflo.co///', {})).toBe('https://api.dashflo.co');
  });
});
