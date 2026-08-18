import { describe, it, expect } from 'vitest';
import { navGroups } from '@/components/layout/navConfig';
import {
  hostScope,
  isAllowedOnProgressHost,
  PROGRESS_ORIGIN,
  PROGRESS_SURFACE_PATHS,
  PROGRESS_AUTH_PATHS,
} from './hostScope';

/* The Progress Control Center is gone from the application, not hidden in it.
 *
 * "Remove the sidebar entry entirely" is a stronger requirement than "hide it
 * from non-owners", and the difference is exactly what these tests hold. A
 * conditionally rendered entry passes a manual check while signed in as the
 * wrong role and still ships the link; an absent entry cannot.
 *
 * This lives here rather than beside navConfig.js because
 * components/progress/OffscreenCapture.jsx globs component and page
 * directories into the production build.
 */

function flatten(groups) {
  return groups.flatMap((group) => [group, ...(group.children || [])]);
}

describe('progress is absent from the application navigation', () => {
  const entries = flatten(navGroups);

  it('has no navigation entry pointing at a progress route', () => {
    const progressPaths = entries
      .map((entry) => entry.path)
      .filter((path) => typeof path === 'string' && path.startsWith('/progress'));
    expect(progressPaths).toEqual([]);
  });

  it('has no navigation entry labelled Progress', () => {
    const labels = entries.map((entry) => entry.label);
    expect(labels).not.toContain('Progress');
  });

  it('has no navigation entry gated on a progress permission key', () => {
    // The keys still exist for stored user records. What must not exist is a
    // nav entry that renders whenever one of them happens to be set.
    const gated = entries.filter((entry) => String(entry.permKey || '').startsWith('progress'));
    expect(gated).toEqual([]);
  });

  it('still has the sections either side of where Progress used to sit', () => {
    // Guards against the removal having taken a neighbouring group with it.
    const labels = entries.map((entry) => entry.label);
    expect(labels).toContain('Tools');
    expect(labels).toContain('Settings');
  });
});

describe('the Control Center is reachable only on its own host', () => {
  it('scopes the progress hostname to progress alone', () => {
    expect(hostScope('progress.dashflo.io')).toBe('progress');
    expect(hostScope('app.dashflo.io')).toBe('dashboard');
  });

  it('serves no operator surface on the progress host', () => {
    // The Control Center owns the root of its own host, and two of its surfaces
    // are spelled the same as an operator one: / is the Command Center there and
    // /settings is Progress Settings. They collide in spelling only. App.jsx
    // chooses one route table per host before any matching happens, so the table
    // that owns Overview and operator Settings is not mounted on that host and
    // cannot be reached by typing either path.
    const ownPaths = new Set(PROGRESS_SURFACE_PATHS);

    const operatorPaths = flatten(navGroups)
      .map((entry) => entry.path)
      .filter((path) => typeof path === 'string')
      .filter((path) => !ownPaths.has(path));

    // Every other path the application navigation can produce must be refused
    // there, so moving Progress out cannot have quietly let the dashboard in.
    expect(operatorPaths.length).toBeGreaterThan(5);
    for (const path of operatorPaths) {
      expect(isAllowedOnProgressHost(path), path).toBe(false);
    }
  });

  it('allows a closed set of paths on the progress host', () => {
    // The allowlist is the surfaces plus the authentication entry points and
    // nothing else. A closed set is the assertion worth holding: it fails when a
    // path is added, which is the moment to decide whether that path belongs on
    // an owner only host, rather than after it is already being served.
    const allowed = [...PROGRESS_SURFACE_PATHS, ...PROGRESS_AUTH_PATHS];
    expect(new Set(allowed).size).toBe(allowed.length);
    for (const path of allowed) {
      expect(isAllowedOnProgressHost(path), path).toBe(true);
    }
    expect(allowed).toContain('/');
    expect(allowed).not.toContain('/progress');
  });

  it('sends the owner to the Control Center host and nowhere else', () => {
    expect(PROGRESS_ORIGIN.startsWith('https://')).toBe(true);
    expect(new URL(PROGRESS_ORIGIN).hostname).toBe('progress.dashflo.io');
  });
});
