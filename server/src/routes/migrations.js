import express from 'express';
import multer from 'multer';
import { runMigrationImport, MigrationValidationError } from '../lib/migrationImport.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 5 },
});

function permissionsOf(user) {
  try {
    return typeof user?.permissions === 'string' ? JSON.parse(user.permissions || '{}') : (user?.permissions || {});
  } catch {
    return {};
  }
}

export function authorized(user, kind) {
  if (!user) return false;
  if (user.base_role === 'buyer' || user.base_role === 'supplier'
    || user.linked_buyer_id || user.linked_supplier_id) return false;
  if (kind === 'owner') return user.base_role === 'owner';
  return user.base_role === 'owner' || permissionsOf(user).set_export_import === true;
}

function uploadOne(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Migration file exceeds 250 MB' : 'Invalid migration upload' });
  });
}

async function handle(req, res) {
  const kind = String(req.body?.kind || 'ordinary');
  const mode = req.path.endsWith('/apply') ? 'apply' : 'preview';
  if (!authorized(req.user, kind)) {
    return res.status(req.user ? 403 : 401).json({ error: kind === 'owner' ? 'Owner migration import is owner only' : 'Forbidden' });
  }
  if (!req.file?.buffer) return res.status(400).json({ error: 'Choose a migration file' });

  let bundle;
  try {
    bundle = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Migration file is not valid JSON' });
  }

  try {
    const result = await runMigrationImport({
      kind,
      mode,
      bundle,
      passphrase: kind === 'owner' ? String(req.body?.passphrase || '') : '',
      confirmed: req.body?.confirmed === 'true',
      user: req.user,
    });
    return res.json(result);
  } catch (error) {
    const status = error instanceof MigrationValidationError ? error.status : 500;
    return res.status(status).json({
      error: error instanceof MigrationValidationError ? error.message : 'Migration import failed',
      run_id: error.runId || null,
    });
  } finally {
    bundle = null;
  }
}

router.post('/preview', uploadOne, handle);
router.post('/apply', uploadOne, handle);

export default router;
