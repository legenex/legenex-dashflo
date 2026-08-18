import { describe, it, expect } from 'vitest';
import {
  hostScope,
  isAllowedOnProgressHost,
  isProgressAuthPath,
  canonicalProgressPath,
  progressHostUrl,
  PROGRESS_ORIGIN,
  PROGRESS_ROOT_PATH,
  PROGRESS_SURFACE_PATHS,
  PROGRESS_AUTH_PATHS,
} from './hostScope';

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

  it('serves the Command Center at the root of the progress host', () => {
    // The Control Center is the whole of that host, so its address is the host.
    // This is the assertion the blank page failed: / was refused, redirected to
    // /progress, and nothing was ever drawn.
    expect(PROGRESS_ROOT_PATH).toBe('/');
    expect(isAllowedOnProgressHost('/')).toBe(true);
    expect(canonicalProgressPath('/')).toBe('/');
    expect(PROGRESS_SURFACE_PATHS).toContain('/');
  });

  it('allows the Control Center surfaces and the auth paths, and nothing else', () => {
    [...PROGRESS_SURFACE_PATHS, ...PROGRESS_AUTH_PATHS]
      .forEach((p) => expect(isAllowedOnProgressHost(p), p).toBe(true));

    // Operator surfaces, the portals, the docs and the public application form
    // must all be unreachable on that domain. / and /settings are absent from
    // this list on purpose: on the progress host they are the Command Center and
    // Progress Settings, served by the progress route table. The operator table
    // that owns Overview and operator Settings is never mounted there.
    ['/leads', '/campaigns', '/finances', '/portal', '/supplier-portal', '/docs', '/apply', '/register', '/operations']
      .forEach((p) => expect(isAllowedOnProgressHost(p), p).toBe(false));
  });

  it('treats /progress as retired rather than canonical', () => {
    // The namespace the Control Center used to live under. It resolves, by
    // mapping onto the canonical path, and it is never the canonical path.
    expect(isAllowedOnProgressHost('/progress')).toBe(false);
    expect(canonicalProgressPath('/progress')).toBe('/');
    expect(canonicalProgressPath('/progress/')).toBe('/');
    expect(canonicalProgressPath('/progress/findings')).toBe('/findings');
    expect(canonicalProgressPath('/progress/review')).toBe('/review');
    expect(canonicalProgressPath('/progress/settings')).toBe('/settings');
    // A nested detail path under a surface keeps its tail.
    expect(canonicalProgressPath('/progress/review/leads-view')).toBe('/review/leads-view');
  });

  it('sends anything the Control Center does not serve to the Command Center', () => {
    // Never a dead end and never a rendered operator surface. Both matter: the
    // first is the bug that shipped, the second is the security boundary.
    ['/progress/leads', '/leads', '/campaigns', '/portal', '/docs', '/nonsense']
      .forEach((p) => expect(canonicalProgressPath(p), p).toBe('/'));
  });

  it('leaves the authentication paths alone', () => {
    // An unauthenticated visitor must be able to reach a login form. Rewriting
    // these onto the Command Center would send them to a page they cannot see,
    // and rewriting /login to /login is a reload loop.
    PROGRESS_AUTH_PATHS.forEach((p) => {
      expect(isProgressAuthPath(p), p).toBe(true);
      expect(canonicalProgressPath(p), p).toBe(p);
    });
    expect(isProgressAuthPath('/')).toBe(false);
    expect(isProgressAuthPath('/findings')).toBe(false);
  });

  it('builds the Control Center URL the application host hands off to', () => {
    // What app.dashflo.io/progress redirects an owner to. The canonical URL has
    // no /progress in it, which is also what the Google OAuth origin must be.
    expect(progressHostUrl('/progress')).toBe('https://progress.dashflo.io/');
    expect(progressHostUrl('/progress/findings')).toBe('https://progress.dashflo.io/findings');
    expect(progressHostUrl('/progress/review', '?page=leads', '#top'))
      .toBe('https://progress.dashflo.io/review?page=leads#top');
    // The Google Authorized JavaScript origin is an origin, never a path.
    expect(new URL(progressHostUrl('/progress')).origin).toBe(PROGRESS_ORIGIN);
  });
});
