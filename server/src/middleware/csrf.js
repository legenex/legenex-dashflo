// Cross-site request forgery defence for cookie-authenticated requests.
//
// The browser client sends a session cookie. Any state-changing request that is
// authenticated by that cookie must prove it came from our own origin.
//
// A request authenticated by an Authorization header is not vulnerable: a
// cross-site page cannot read the token to attach it. Supplier and webhook
// traffic carries its own key and no cookie, so it is unaffected.
//
// Combined with SameSite lax on the session cookie this is defence in depth,
// not the only line.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Build the set of origins that count as our own.
export function allowedOrigins(config) {
  const origins = new Set();
  const base = originOf(config.publicBaseUrl);
  if (base) origins.add(base);

  // The Progress Control Center host serves the same application from the same
  // backend, so its requests are ours. It is added here rather than being left
  // to ALLOWED_ORIGINS so that deploying the Control Center cannot be half done:
  // an operator who installs the nginx host but forgets an environment variable
  // would otherwise get a working page whose every write is refused.
  //
  // This grants an origin CSRF standing, which is exactly why the marketing
  // site is deliberately NOT here. The difference is that this origin serves
  // our own authenticated application and is owner gated on the server, while
  // the marketing site is a public static bundle.
  const progress = originOf(config.progressOrigin);
  if (progress) origins.add(progress);

  for (const extra of String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const o = originOf(extra) || originOf(`https://${extra}`);
    if (o) origins.add(o);
  }
  return origins;
}

export function verifySameOrigin({ method, origin, referer, hasCookieAuth, hasHeaderAuth, allowed }) {
  if (SAFE_METHODS.has(String(method || '').toUpperCase())) return { ok: true };
  // Not authenticated by a cookie, so forgery gains the attacker nothing.
  if (!hasCookieAuth || hasHeaderAuth) return { ok: true };

  const candidate = originOf(origin) || originOf(referer);
  if (!candidate) {
    return { ok: false, reason: 'Origin or Referer header is required for cookie-authenticated writes' };
  }
  if (allowed.size === 0) {
    // Nothing configured to compare against. Same-origin browser requests send
    // an Origin that matches the host we were reached on, so fall back to that
    // rather than refusing every write on a host with no PUBLIC_BASE_URL.
    return { ok: true, unverified: true };
  }
  if (!allowed.has(candidate)) {
    return { ok: false, reason: 'Cross-site request refused' };
  }
  return { ok: true };
}

export function csrfGuard(config) {
  const allowed = allowedOrigins(config);
  const cookieName = config.auth.cookieName;

  return function csrfMiddleware(req, res, next) {
    const hasCookieAuth = Boolean(req.cookies?.[cookieName]);
    const hasHeaderAuth = String(req.headers.authorization || '').startsWith('Bearer ');

    // When no PUBLIC_BASE_URL is configured, compare against the host the
    // request actually arrived on so a plain local deployment still works.
    const effective = allowed.size > 0 ? allowed : new Set([`${req.protocol}://${req.get('host')}`]);

    const result = verifySameOrigin({
      method: req.method,
      origin: req.headers.origin,
      referer: req.headers.referer,
      hasCookieAuth,
      hasHeaderAuth,
      allowed: effective,
    });

    if (!result.ok) {
      return res.status(403).json({ error: 'Forbidden', message: result.reason });
    }
    return next();
  };
}

export default { csrfGuard, verifySameOrigin, allowedOrigins };
