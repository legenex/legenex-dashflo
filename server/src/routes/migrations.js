import express from 'express';
import multer from 'multer';
import { runMigrationImport, MigrationValidationError, MIGRATION_ERROR_CODE } from '../lib/migrationImport.js';

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

/* One structured line per migration attempt, and one per outcome.
 *
 * A migration preview that fails in production used to leave nothing behind: the
 * route answered with a generic message and wrote no log, so "it did nothing"
 * was all anyone could say about it afterwards. These lines are what make the
 * next failure diagnosable.
 *
 * What is recorded is shape and outcome: which mode, which package kind, how
 * many bytes arrived, how long it took, the run id the migration_run row is
 * keyed by, and the stable error code. What is never recorded is the passphrase,
 * any decrypted value, any record field, any credential, or a stack trace. A
 * migration package is the single most credential-dense file this system
 * handles, so the log line is built from a fixed set of scalars rather than
 * from anything the package supplied.
 *
 * The user id is included because this is an audited owner action and the
 * migration_run row already carries it. The email is not.
 */
export function migrationLogLine(fields) {
  const parts = ['[migration]'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}

function logMigration(fields) {
  const line = migrationLogLine(fields);
  if (fields.outcome === 'failed') console.warn(line);
  else console.log(line);
}

function uploadOne(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    const status = tooBig ? 413 : 400;
    const code = tooBig ? MIGRATION_ERROR_CODE.TOO_LARGE : MIGRATION_ERROR_CODE.BAD_UPLOAD;
    logMigration({
      mode: req.path.endsWith('/apply') ? 'apply' : 'preview',
      outcome: 'failed',
      stage: 'upload',
      code,
      status,
      multer_code: error.code || 'unknown',
    });
    return res.status(status).json({
      error: tooBig ? 'Migration file exceeds 250 MB' : 'Invalid migration upload',
      code,
    });
  });
}

async function handle(req, res) {
  const kind = String(req.body?.kind || 'ordinary');
  const mode = req.path.endsWith('/apply') ? 'apply' : 'preview';
  const bytes = req.file?.buffer?.length || 0;
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

  const refuse = (status, error, code, extra = {}) => {
    logMigration({
      mode, kind, outcome: 'failed', code, status, bytes, ms: elapsedMs().toFixed(0), ...extra,
    });
    return res.status(status).json({ error, code });
  };

  if (!authorized(req.user, kind)) {
    return refuse(
      req.user ? 403 : 401,
      kind === 'owner' ? 'Owner migration import is owner only' : 'Forbidden',
      MIGRATION_ERROR_CODE.UNAUTHORIZED,
      { stage: 'authorize' },
    );
  }
  if (!req.file?.buffer) {
    return refuse(400, 'Choose a migration file', MIGRATION_ERROR_CODE.BAD_UPLOAD, { stage: 'upload' });
  }

  logMigration({ mode, kind, outcome: 'started', bytes, user_id: req.user?.id || 'unknown' });

  let bundle;
  try {
    bundle = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    return refuse(
      400,
      'Migration file is not valid JSON',
      MIGRATION_ERROR_CODE.BAD_UPLOAD,
      { stage: 'parse' },
    );
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
    logMigration({
      mode,
      kind,
      outcome: 'ok',
      run_id: result.run_id,
      bytes,
      ms: elapsedMs().toFixed(0),
      entities: result.entities_present?.length ?? 0,
      records: result.records_present ?? 0,
      can_apply: result.can_apply === true,
    });
    return res.json(result);
  } catch (error) {
    const validation = error instanceof MigrationValidationError;
    const status = validation ? error.status : 500;
    const code = validation ? (error.code || MIGRATION_ERROR_CODE.VALIDATION_FAILED) : MIGRATION_ERROR_CODE.INTERNAL;

    // An unexpected failure is the case the old handler lost entirely: it
    // answered "Migration import failed" and wrote nothing anywhere. The
    // message stays generic for the browser, and the server keeps the class and
    // the message it was actually given. Neither carries package contents: this
    // is a database or programming failure, not a decrypted value.
    logMigration({
      mode,
      kind,
      outcome: 'failed',
      stage: 'import',
      code,
      status,
      run_id: error.runId || null,
      bytes,
      ms: elapsedMs().toFixed(0),
      error_name: validation ? undefined : (error?.name || 'Error'),
      detail: validation ? undefined : JSON.stringify(String(error?.message || '').slice(0, 200)),
    });

    return res.status(status).json({
      error: validation ? error.message : 'Migration import failed',
      code,
      run_id: error.runId || null,
    });
  } finally {
    bundle = null;
  }
}

router.post('/preview', uploadOne, handle);
router.post('/apply', uploadOne, handle);

export default router;
