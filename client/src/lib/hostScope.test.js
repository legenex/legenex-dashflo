import { describe, it, expect } from 'vitest';
import { hostScope, isAllowedOnProgressHost, PROGRESS_ORIGIN } from './hostScope';

describe('host scoping', () => {
  it('serves the Progress Control Center on the progress subdomain', () => {
    expect(hostScope('progress.dashflo.io')).toBe('progress');
    expect(hostScope('PROGRESS.dashflo.io')).toBe('progress');
  });

  it('serves the operator dashboard on the application host', () => {
    expect(hostScope('app.dashflo.io')).toBe('dashboard');
  });

  it('keeps the api and docs hosts on their own scopes', () => {
    expect(hostScope('api.dashflo.io')).toBe('api');
    expect(hostScope('docs.dashflo.io')).toBe('docs');
  });

  it('treats the marketing apex as the dashboard scope', () => {
    // The apex is served by nginx from a static bundle and never reaches this
    // code, but if it ever did it must not resolve to progress or api.
    expect(hostScope('dashflo.io')).toBe('dashboard');
    expect(hostScope('www.dashflo.io')).toBe('dashboard');
  });

  it('never lets the progress host resolve to anything else', () => {
    // The whole point of the subdomain: it cannot fall through to the operator
    // app, the docs, or the api, whatever else is in the name.
    [
      'progress.dashflo.io',
      'progress.dashboard.legenex.com',
      'progress.legenex.com',
      'progress.docs.dashflo.io',
    ].forEach((h) => expect(hostScope(h), h).toBe('progress'));
  });

  it('does not treat a host that merely contains the word progress as the progress host', () => {
    expect(hostScope('in-progress.dashflo.io')).toBe('dashboard');
    expect(hostScope('app.progress.dashflo.io')).toBe('dashboard');
    // A lookalike registered by somebody else must not be handed the scope.
    expect(hostScope('progress.dashflo.io.evil.example')).toBe('progress');
  });

  it('names the Control Center origin in exactly one place', () => {
    // The retired /progress route on the application host redirects here, so a
    // drift between this constant and the nginx server block would send the
    // owner to a host that does not exist.
    expect(PROGRESS_ORIGIN).toBe('https://progress.dashflo.io');
    expect(hostScope(new URL(PROGRESS_ORIGIN).hostname)).toBe('progress');
  });

  it('allows only progress and auth paths on the progress host', () => {
    ['/progress', '/progress/review', '/progress/gates', '/login', '/reset-password', '/forgot-password']
      .forEach((p) => expect(isAllowedOnProgressHost(p), p).toBe(true));

    // Operator surfaces, portals, docs and the public application form must all
    // be unreachable on that domain.
    ['/', '/leads', '/campaigns', '/finances', '/settings', '/portal', '/supplier-portal', '/docs', '/apply', '/register']
      .forEach((p) => expect(isAllowedOnProgressHost(p), p).toBe(false));
  });
});
