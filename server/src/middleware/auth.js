import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { repo } from '../db/repo.js';

// Extract a bearer token from Authorization header or cookie.
function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies?.[config.auth.cookieName]) return req.cookies[config.auth.cookieName];
  return null;
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
  });
}

// Resolve the current user (or null) and attach to req.user. Never throws.
export async function attachUser(req, _res, next) {
  const token = tokenFromRequest(req);
  if (!token) { req.user = null; return next(); }
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    const user = await repo('User').get(payload.sub);
    req.user = user || null;
  } catch {
    req.user = null;
  }
  next();
}

// Gate a route: 401 if not authenticated.
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  next();
}

// Gate a route by role (defaults to admin/owner for write operations).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const role = req.user.base_role || req.user.role;
    if (!roles.includes(role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

export default { attachUser, requireAuth, requireRole, signToken };
