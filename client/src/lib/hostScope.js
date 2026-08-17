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

// Paths the progress host is allowed to serve. Everything else redirects to
// /progress rather than rendering, so an operator route cannot be reached by
// typing it into the address bar on that domain.
const PROGRESS_HOST_PATHS = [
  '/progress',
  '/login',
  '/forgot-password',
  '/reset-password',
];

export function isAllowedOnProgressHost(pathname = '') {
  return PROGRESS_HOST_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}

export const isApiHost = (h) => hostScope(h) === 'api';
export const isDocsHost = (h) => hostScope(h) === 'docs';
export const isProgressHost = (h) => hostScope(h) === 'progress';
