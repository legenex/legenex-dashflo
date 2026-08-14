// In-process rate limiting for the routes an anonymous caller can reach.
//
// Dependency free and deliberately simple: a fixed window counter per key, held
// in memory. This is a single-node deployment, so an in-process counter is the
// right size. If the cutover ever runs more than one node, this needs to move
// to a shared store, and that is recorded in STATE.md rather than pretended
// away here.
//
// The point is to stop credential stuffing and brute forcing an OTP, not to
// shape traffic precisely.

const buckets = new Map();

// Drop expired buckets so a long-running process does not accumulate one entry
// per address forever.
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

export function consume(key, limit, windowMs, now = Date.now()) {
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    sweep(now);
    lastSweep = now;
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

// Reset all counters. Used by tests.
export function resetRateLimits() {
  buckets.clear();
  lastSweep = 0;
}

function clientKey(req) {
  // trust proxy is set on the app, so req.ip reflects X-Forwarded-For when the
  // deployment sits behind a reverse proxy.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Build a middleware. `by` optionally adds a second dimension to the key, for
// example the submitted email address, so one address cannot lock out every
// account from a shared NAT.
export function rateLimit({ name, limit, windowMs, by = null }) {
  return function rateLimitMiddleware(req, res, next) {
    const extra = by ? `:${String(by(req) ?? '').slice(0, 200)}` : '';
    const key = `${name}:${clientKey(req)}${extra}`;
    const result = consume(key, limit, windowMs);
    if (result.allowed) {
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      return next();
    }
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(seconds));
    return res.status(429).json({
      error: 'Too many requests',
      message: `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    });
  };
}

export default { rateLimit, consume, resetRateLimits };
