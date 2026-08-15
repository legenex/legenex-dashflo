import { describe, it, expect } from 'vitest';
import {
  DEV_JWT_SECRET,
  collectStartupProblems,
  assertStartupConfig,
} from '../src/lib/startupChecks.js';

// The server used to fall back to a known development JWT secret, so a
// production deploy that forgot to set JWT_SECRET signed tokens anyone could
// forge. These tests pin that production now refuses to start instead.

const GOOD_SECRET = 'k7Qw2sVb9YtR4mLp8ZnA6xCd3FgH1jKe';
const prodConfig = (over = {}) => ({
  env: 'production',
  publicBaseUrl: 'https://dash.example.com',
  auth: { jwtSecret: GOOD_SECRET, cookieName: 'dashos_token' },
  db: { connectionString: 'postgres://u:p@db/app' },
  ...over,
});
const prodEnv = { PGHOST: 'db', PGDATABASE: 'app' };

describe('development and test are left permissive', () => {
  it('reports no problems outside production even with the dev secret', () => {
    for (const env of ['development', 'test', undefined]) {
      const problems = collectStartupProblems({
        env,
        publicBaseUrl: '',
        auth: { jwtSecret: DEV_JWT_SECRET },
        db: {},
      }, {});
      expect(problems).toEqual([]);
    }
  });
});

describe('production refuses unsafe secrets', () => {
  it('refuses the development fallback secret', () => {
    const problems = collectStartupProblems(
      prodConfig({ auth: { jwtSecret: DEV_JWT_SECRET } }), prodEnv);
    expect(problems.join(' ')).toMatch(/development or placeholder/);
  });

  it('refuses the placeholder from .env.example', () => {
    const problems = collectStartupProblems(
      prodConfig({ auth: { jwtSecret: 'change-me-to-a-long-random-string' } }), prodEnv);
    expect(problems.join(' ')).toMatch(/development or placeholder/);
  });

  it('refuses an empty secret', () => {
    const problems = collectStartupProblems(prodConfig({ auth: { jwtSecret: '' } }), prodEnv);
    expect(problems.join(' ')).toMatch(/JWT_SECRET is not set/);
  });

  it('refuses a short secret', () => {
    const problems = collectStartupProblems(prodConfig({ auth: { jwtSecret: 'abc123' } }), prodEnv);
    expect(problems.join(' ')).toMatch(/shorter than 32/);
  });

  it('accepts a long unique secret', () => {
    expect(collectStartupProblems(prodConfig(), prodEnv)).toEqual([]);
  });
});

describe('production requires its own origin and a real database', () => {
  it('refuses a missing public base url', () => {
    const problems = collectStartupProblems(prodConfig({ publicBaseUrl: '' }), prodEnv);
    expect(problems.join(' ')).toMatch(/PUBLIC_BASE_URL is not set/);
  });

  it('refuses a plaintext public base url', () => {
    const problems = collectStartupProblems(prodConfig({ publicBaseUrl: 'http://dash.example.com' }), prodEnv);
    expect(problems.join(' ')).toMatch(/must be an https URL/);
  });

  // Running the local checkout in production-like mode is how the operator
  // proves a build before it is deployed, and there is no certificate for
  // localhost. Loopback over plain http is exempt; nothing else is, so a real
  // host that forgets TLS is still refused.
  it('allows plaintext only on loopback origins', () => {
    for (const url of [
      'http://localhost:4000',
      'http://127.0.0.1:4000',
      'http://[::1]:4000',
      'https://localhost:4000',
    ]) {
      expect(collectStartupProblems(prodConfig({ publicBaseUrl: url }), prodEnv)).toEqual([]);
    }
  });

  it('still refuses plaintext for non-loopback hosts', () => {
    for (const url of [
      'http://dashflo.co',
      'http://api.dashflo.co',
      'http://192.168.1.10:4000',
      'http://localhost.attacker.example',
      'http://notlocalhost',
    ]) {
      const problems = collectStartupProblems(prodConfig({ publicBaseUrl: url }), prodEnv);
      expect(problems.join(' '), url).toMatch(/must be an https URL/);
    }
  });

  it('refuses a public base url it cannot parse', () => {
    const problems = collectStartupProblems(prodConfig({ publicBaseUrl: 'not a url' }), prodEnv);
    expect(problems.join(' ')).toMatch(/must be an https URL/);
  });

  it('refuses when no database is configured', () => {
    const problems = collectStartupProblems(prodConfig({ db: {} }), {});
    expect(problems.join(' ')).toMatch(/No database is configured/);
  });

  it('refuses the default postgres password', () => {
    const problems = collectStartupProblems(
      prodConfig({ db: {} }), { ...prodEnv, PGPASSWORD: 'postgres' });
    expect(problems.join(' ')).toMatch(/PGPASSWORD is still the default/);
  });
});

describe('assertStartupConfig', () => {
  it('throws and names every problem at once', () => {
    let error;
    try {
      assertStartupConfig({
        env: 'production',
        publicBaseUrl: '',
        auth: { jwtSecret: DEV_JWT_SECRET },
        db: {},
      }, {});
    } catch (e) { error = e; }

    expect(error).toBeDefined();
    expect(error.message).toMatch(/Refusing to start in production/);
    expect(error.message).toMatch(/JWT_SECRET/);
    expect(error.message).toMatch(/PUBLIC_BASE_URL/);
    expect(error.message).toMatch(/database/);
  });

  it('does not throw for an acceptable production configuration', () => {
    expect(() => assertStartupConfig(prodConfig(), prodEnv)).not.toThrow();
  });

  it('never puts the secret value in the error message', () => {
    // Distinctive so a match proves a leak rather than colliding with an
    // ordinary word in the message.
    const secret = 'Zq7vNb';
    let error;
    try {
      assertStartupConfig(prodConfig({ auth: { jwtSecret: secret } }), prodEnv);
    } catch (e) { error = e; }
    expect(error.message).not.toContain(secret);
  });
});
