// Which experience a hostname is allowed to serve.
//
// Extracted from App.jsx so the rules are testable. Host scoping is a security
// boundary, not a convenience: the progress subdomain exposes findings, migration
// risk, release gates and prompts, and must never fall through to the operator
// dashboard or the public docs.
//
// Exactly one scope wins for any hostname, and the order below is the precedence.

// Where the Progress Control Center lives. One constant so the redirect from the
// retired /progress route, and anything else that needs to name the host, cannot
// drift from the host the app actually recognises.
export const PROGRESS_ORIGIN = 'https://progress.dashflo.io';

export function hostScope(hostname = '') {
  const h = String(hostname).toLowerCase();

  // api.dashflo.io exists only to serve backend functions. Never gates on auth.
  if (/(^|\.)api\./.test(h)) return 'api';

  // The Progress Control Center subdomain. Checked before docs and before the
  // default so no other surface can be reached on it.
  if (/^progress\./.test(h)) return 'progress';

  // Public documentation subdomain, anonymous.
  if (/(^|\.)docs\./.test(h)) return 'docs';

  return 'dashboard';
}

// The Control Center is the whole of this host, so its address is the root of
// the host. progress.dashflo.io/ IS the Command Center.
export const PROGRESS_ROOT_PATH = '/';

// The namespace the Control Center used to live under, back when it was a
// section of the operator app. It is retired: it still resolves, by redirecting
// onto the canonical path, and it is never the canonical path itself.
export const PROGRESS_LEGACY_PREFIX = '/progress';

// Every surface the progress host serves. The route table, the Control Center
// navigation and the host allowlist all read this list, so a surface cannot be
// routable without being allowed, or allowed without being routable.
//
// Two of these read like operator paths and are not. On this host there is no
// operator route table mounted at all: App.jsx picks one table per host before
// any matching happens, so / is the Command Center and /settings is Progress
// Settings here, and Overview and operator Settings exist only on the
// application host.
export const PROGRESS_SURFACE_PATHS = Object.freeze([
  PROGRESS_ROOT_PATH,
  '/review',
  '/findings',
  '/changes',
  '/prompts',
  '/activity',
  '/migration',
  '/gates',
  '/settings',
]);

// The only paths this host serves to somebody who is not signed in. They are
// never rewritten, or an unauthenticated visitor could not reach a login form.
export const PROGRESS_AUTH_PATHS = Object.freeze([
  '/login',
  '/forgot-password',
  '/reset-password',
]);

// A browser can arrive with a trailing slash, a query string or a fragment.
// Compare the path alone, so /review/ and /review?x=1 are the same surface.
function normalisePath(pathname = '') {
  const raw = String(pathname == null ? '' : pathname);
  const path = raw.split('?')[0].split('#')[0];
  if (!path) return PROGRESS_ROOT_PATH;
  const rooted = path.startsWith('/') ? path : `/${path}`;
  if (rooted === PROGRESS_ROOT_PATH) return PROGRESS_ROOT_PATH;
  return rooted.replace(/\/+$/, '') || PROGRESS_ROOT_PATH;
}

export function isProgressAuthPath(pathname = '') {
  return PROGRESS_AUTH_PATHS.includes(normalisePath(pathname));
}

// Paths the progress host is allowed to serve. Everything else redirects to the
// Command Center rather than rendering, so an operator route cannot be reached
// by typing it into the address bar on that domain.
export function isAllowedOnProgressHost(pathname = '') {
  const path = normalisePath(pathname);
  if (path === PROGRESS_ROOT_PATH) return true;
  if (isProgressAuthPath(path)) return true;
  return PROGRESS_SURFACE_PATHS.some(
    (p) => p !== PROGRESS_ROOT_PATH && (path === p || path.startsWith(`${p}/`)),
  );
}

// The canonical progress-host path for any path a browser can arrive with.
//
// The retired namespace maps onto its root equivalent: /progress is the Command
// Center, /progress/findings is /findings. Anything this host does not serve
// lands on the Command Center, so a stale operator link cannot render here and
// cannot 404 into a dead end either.
export function canonicalProgressPath(pathname = '') {
  const path = normalisePath(pathname);
  let mapped = path;
  if (path === PROGRESS_LEGACY_PREFIX) {
    mapped = PROGRESS_ROOT_PATH;
  } else if (path.startsWith(`${PROGRESS_LEGACY_PREFIX}/`)) {
    mapped = normalisePath(path.slice(PROGRESS_LEGACY_PREFIX.length));
  }
  return isAllowedOnProgressHost(mapped) ? mapped : PROGRESS_ROOT_PATH;
}

// The absolute Control Center URL for a path served on the application host.
// Built from the path the application itself served, never from anything a
// query string supplied, so this stays a fixed redirect to one known origin.
export function progressHostUrl(pathname = PROGRESS_ROOT_PATH, search = '', hash = '') {
  return `${PROGRESS_ORIGIN}${canonicalProgressPath(pathname)}${search || ''}${hash || ''}`;
}

export const isApiHost = (h) => hostScope(h) === 'api';
export const isDocsHost = (h) => hostScope(h) === 'docs';
export const isProgressHost = (h) => hostScope(h) === 'progress';
