import express from 'express';
import { repo, entityExists } from '../db/repo.js';
import { getSchema } from '../schemas/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// All entity access requires authentication. Row-level rules from the schema
// (rls.read/create/update/delete with { user_condition: { role } }) are honored
// at a coarse level: admin/owner pass everything; other roles are checked.
function checkRls(schema, action, user) {
  const rule = schema?.rls?.[action]?.user_condition;
  if (!rule) return true; // no rule -> allow authenticated
  const role = user.base_role || user.role;
  if (role === 'owner' || role === 'admin') return true;
  if (rule.role && rule.role !== role) return false;
  return true;
}

function resolve(req, res, action) {
  const { name } = req.params;
  if (!entityExists(name)) {
    res.status(404).json({ error: `Unknown entity: ${name}` });
    return null;
  }
  const schema = getSchema(name);
  if (!checkRls(schema, action, req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return repo(name);
}

const num = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));

// GET /api/entities/:name?sort=&limit=&offset=
router.get('/:name', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const rows = await r.list(req.query.sort || '-created_date', num(req.query.limit, 100), num(req.query.offset, 0));
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/entities/:name/query  { filter, sort, limit, offset }
router.post('/:name/query', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const { filter = {}, sort = '-created_date', limit = null, offset = 0 } = req.body || {};
    const rows = await r.filter(filter, sort, limit, offset);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/entities/:name/:id
router.get('/:name/:id', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'read'); if (!r) return;
    const row = await r.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// POST /api/entities/:name           create (single or array -> bulkCreate)
router.post('/:name', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'create'); if (!r) return;
    const body = req.body;
    if (Array.isArray(body)) return res.json(await r.bulkCreate(body, req.user.id));
    res.json(await r.create(body, req.user.id));
  } catch (e) { next(e); }
});

// PATCH /api/entities/:name/:id       update
router.patch('/:name/:id', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    res.json(await r.update(req.params.id, req.body || {}));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/bulk-update  [{id, ...patch}]
router.post('/:name/bulk-update', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    res.json(await r.bulkUpdate(req.body || []));
  } catch (e) { next(e); }
});

// POST /api/entities/:name/update-many  { filter, update }
router.post('/:name/update-many', requireAuth, async (req, res, next) => {
  try {
    const r = resolve(req, res, 'update'); if (!r) return;
    res.json(await r.updateMany(req.body?.filter || {}, req.body?.update || {}));
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
