import express from 'express';
import { repo, entityExists } from '../db/repo.js';
import { requireAuth } from '../middleware/auth.js';
import { authorizeEntity, projectRead, sanitizeWrite } from '../lib/entityPolicy.js';

const router = express.Router();

// Resolve an entity for an action, or answer the request with the reason it is
// not allowed. Authorization is deny by default: see lib/entityPolicy.js. An
// entity absent from the policy table is refused for every role.
//
// The entity is checked for existence only after authorization passes, so this
// route cannot be used to enumerate which entities exist.
function resolve(req, res, action) {
  const { name } = req.params;

  const decision = authorizeEntity(req.user, name, action);
  if (!decision.allowed) {
    res.status(decision.status).json({
      error: decision.status === 401 ? 'Unauthorized' : 'Forbidden',
      message: decision.reason,
    });
    return null;
  }

  if (!entityExists(name)) {
    res.status(404).json({ error: `Unknown entity: ${name}` });
    return null;
  }

  return repo(name);
}

const num = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));

// Bound how many rows one request can pull, so a single call cannot stream the
// whole table out of the database.
const MAX_LIMIT = 1000;
const boundLimit = (v, d) => Math.min(Math.max(num(v, d) || d, 1), MAX_LIMIT);

// GET /api/entities/:name?sort=&limit=&offset=
router.get('/:name', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const rows = await r.list(req.query.sort || '-created_date', boundLimit(req.query.limit, 100), num(req.query.offset, 0));
    res.json(projectRead(req.params.name, rows));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/query  { filter, sort, limit, offset }
router.post('/:name/query', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const { filter = {}, sort = '-created_date', limit = null, offset = 0 } = req.body || {};
    const rows = await r.filter(filter, sort, limit == null ? MAX_LIMIT : boundLimit(limit, 100), offset);
    res.json(projectRead(req.params.name, rows));
  } catch (e) { next(e); }
});

// GET /api/entities/:name/:id
router.get('/:name/:id', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const row = await r.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(projectRead(req.params.name, row));
  } catch (e) { next(e); }
});

// POST /api/entities/:name           create (single or array -> bulkCreate)
router.post('/:name', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'create'); if (!r) return;
    const body = sanitizeWrite(req.params.name, req.body);
    if (Array.isArray(body)) return res.json(projectRead(req.params.name, await r.bulkCreate(body, req.user.id)));
    res.json(projectRead(req.params.name, await r.create(body, req.user.id)));
  } catch (e) { next(e); }
});

// PATCH /api/entities/:name/:id       update
router.patch('/:name/:id', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    const patch = sanitizeWrite(req.params.name, req.body || {});
    res.json(projectRead(req.params.name, await r.update(req.params.id, patch)));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/bulk-update  [{id, ...patch}]
router.post('/:name/bulk-update', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    const updates = sanitizeWrite(req.params.name, req.body || []);
    res.json(projectRead(req.params.name, await r.bulkUpdate(updates)));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/update-many  { filter, update }
router.post('/:name/update-many', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    const update = sanitizeWrite(req.params.name, req.body?.update || {});
    res.json(await r.updateMany(req.body?.filter || {}, update));
  } catch (e) { next(e); }
});

// DELETE /api/entities/:name/:id
router.delete('/:name/:id', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'delete'); if (!r) return;
    res.json(await r.delete(req.params.id));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/delete-many  { filter }
router.post('/:name/delete-many', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'delete'); if (!r) return;
    res.json(await r.deleteMany(req.body?.filter || {}));
  } catch (e) { next(e); }
});

export default router;
