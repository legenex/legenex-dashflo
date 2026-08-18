import express from 'express';
import multer from 'multer';
import { runMigrationImport, MigrationValidationError, MIGRATION_ERROR_CODE } from '../lib/migrationImport.js';
import {
  finishProgress, isValidProgressId, progressSink, readProgress, startProgress,
} from '../lib/migrationProgress.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 6 },
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

  // Progress is optional. An older client, or a caller that does not send an id,
  // gets exactly the previous behaviour.
  const progressId = String(req.body?.progress_id || '');
  const tracked = isValidProgressId(progressId)
    && Boolean(startProgress({ id: progressId, userId: req.user.id, mode, kind, bytes }));
  const progress = (tracked && progressSink(progressId)) || undefined;
  const endProgress = (failed, code) => {
    if (tracked) finishProgress(progressId, { failed, code });
  };

  let bundle;
  try {
    progress?.stage('parsing');
    bundle = JSON.parse(req.file.buffer.toString('utf8'));
    // The upload buffer is dead the moment it has been parsed, and for a large
    // owner package it is over a hundred megabytes of ciphertext held alongside
    // the parsed object for the whole decrypt. Dropping the reference here lets
    // it be collected during the expensive part rather than at the end of the
    // request. `bytes` was captured before this point, so logging is unaffected.
    req.file.buffer = null;
  } catch {
    endProgress(true, MIGRATION_ERROR_CODE.BAD_UPLOAD);
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
      ...(progress ? { progress } : {}),
    });
    endProgress(false, null);
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
    endProgress(true, code);

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

/* Poll one import's progress.
 *
 * Authorisation is the same gate the import itself passes, and the record is
 * additionally scoped to the user that created it, so an authorised operator
 * still cannot read another operator's run. An unknown or foreign id is a 404
 * rather than a 403: this endpoint does not confirm that somebody else's
 * migration exists.
 */
router.get('/progress/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Forbidden', code: MIGRATION_ERROR_CODE.UNAUTHORIZED });
  const id = String(req.params.id || '');
  if (!isValidProgressId(id)) return res.status(400).json({ error: 'Invalid progress id', code: MIGRATION_ERROR_CODE.BAD_UPLOAD });
  const state = readProgress(id, req.user.id);
  if (!state) return res.status(404).json({ error: 'No migration progress for that id', code: MIGRATION_ERROR_CODE.BAD_UPLOAD });
  if (!authorized(req.user, state.kind)) {
    return res.status(403).json({ error: 'Forbidden', code: MIGRATION_ERROR_CODE.UNAUTHORIZED });
  }
  return res.json(state);
});

router.post('/preview', uploadOne, handle);
router.post('/apply', uploadOne, handle);

export default router;
