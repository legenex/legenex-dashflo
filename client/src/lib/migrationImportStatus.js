// What the owner migration panel says, for every way the request can end.
//
// The migration import used to report itself entirely through toasts, and the
// toaster those toasts went to was never mounted, so a failed preview stopped
// its spinner and said nothing at all. The panel now keeps an explicit state
// instead, and this module decides what that state says.
//
// It is a pure function of the error or result so every path can be tested
// without a browser: success, wrong passphrase, malformed package, schema
// refusal, a 4xx or 5xx from the server, a timeout, and an unreachable server.
//
// Nothing here reads anything the migration package supplied. The only strings
// it can put on screen are the ones the server chose to send as a safe message,
// and those are trimmed to a single line and bounded, so a stack trace, a
// decrypted value or a raw payload cannot arrive through this path even if a
// future server change tried to send one.

export const MIGRATION_ERROR_CODE = Object.freeze({
  DECRYPT_FAILED: 'decrypt_failed',
  VALIDATION_FAILED: 'validation_failed',
  BAD_UPLOAD: 'bad_upload',
  UNAUTHORIZED: 'unauthorized',
  NOT_CONFIRMED: 'not_confirmed',
  TOO_LARGE: 'too_large',
  INTERNAL: 'internal',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
});

const MAX_DETAIL = 300;

// One line, bounded, and never a stack. An Error message that carries newlines
// is either a stack that leaked or a payload that was echoed back, and neither
// belongs in front of an operator.
export function safeDetail(value) {
  const text = String(value == null ? '' : value).split('\n')[0].trim();
  if (!text) return '';
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

const DECRYPT_COPY = 'Unable to decrypt this migration package. Verify the passphrase and file.';

// Errors the browser produced rather than the server. The client sets these
// codes itself in api/client.js, so they are trustworthy and need their own
// wording: neither is something the operator can fix by changing the passphrase.
const CLIENT_COPY = {
  [MIGRATION_ERROR_CODE.TIMEOUT]: {
    title: 'The migration request timed out',
    fallback: 'The server did not answer in time. Nothing was imported. Try again, and if it keeps timing out the package may be too large for a single request.',
  },
  [MIGRATION_ERROR_CODE.NETWORK]: {
    title: 'Could not reach the server',
    fallback: 'The migration request did not complete. Nothing was imported. Check the connection and try again.',
  },
};

function codeOf(error) {
  if (error?.code && Object.values(MIGRATION_ERROR_CODE).includes(error.code)) return error.code;
  if (error?.status === 401 || error?.status === 403) return MIGRATION_ERROR_CODE.UNAUTHORIZED;
  if (error?.status === 413) return MIGRATION_ERROR_CODE.TOO_LARGE;
  if (Number(error?.status) >= 500) return MIGRATION_ERROR_CODE.INTERNAL;
  if (Number(error?.status) >= 400) return MIGRATION_ERROR_CODE.VALIDATION_FAILED;
  return MIGRATION_ERROR_CODE.UNKNOWN;
}

/**
 * Turn any thrown value from the migration request into an explicit, safe,
 * displayable state. Always returns a state: there is no input for which the
 * panel is allowed to go quiet.
 */
export function describeMigrationFailure(error, { mode = 'preview' } = {}) {
  const code = codeOf(error);
  const serverDetail = safeDetail(error?.message);
  const noun = mode === 'apply' ? 'apply' : 'preview';

  if (code === MIGRATION_ERROR_CODE.TIMEOUT || code === MIGRATION_ERROR_CODE.NETWORK) {
    const copy = CLIENT_COPY[code];
    return { tone: 'error', code, title: copy.title, detail: serverDetail || copy.fallback };
  }

  if (code === MIGRATION_ERROR_CODE.DECRYPT_FAILED) {
    // The passphrase and the package are the two things the operator controls,
    // and the server deliberately does not say which one was wrong.
    return { tone: 'error', code, title: 'Decryption failed', detail: DECRYPT_COPY };
  }

  if (code === MIGRATION_ERROR_CODE.UNAUTHORIZED) {
    return {
      tone: 'error',
      code,
      title: 'Not permitted',
      detail: serverDetail || 'This account cannot run a migration import.',
    };
  }

  if (code === MIGRATION_ERROR_CODE.TOO_LARGE) {
    return {
      tone: 'error',
      code,
      title: 'Migration package is too large',
      detail: serverDetail || 'The package exceeds the size this server accepts in one request.',
    };
  }

  if (code === MIGRATION_ERROR_CODE.BAD_UPLOAD) {
    return {
      tone: 'error',
      code,
      title: 'The file could not be read',
      detail: serverDetail || 'Choose the encrypted migration package that was exported for DashFlo.',
    };
  }

  if (code === MIGRATION_ERROR_CODE.INTERNAL) {
    return {
      tone: 'error',
      code,
      title: `The server could not complete the ${noun}`,
      detail: [
        serverDetail || 'The server reported an error.',
        error?.data?.run_id ? `Run ID ${safeDetail(error.data.run_id)}.` : '',
        'Nothing was imported.',
      ].filter(Boolean).join(' '),
    };
  }

  if (code === MIGRATION_ERROR_CODE.VALIDATION_FAILED || code === MIGRATION_ERROR_CODE.NOT_CONFIRMED) {
    return {
      tone: 'error',
      code,
      title: 'Migration package was refused',
      detail: serverDetail || 'The package did not pass validation.',
    };
  }

  return {
    tone: 'error',
    code: MIGRATION_ERROR_CODE.UNKNOWN,
    title: `The migration ${noun} did not complete`,
    detail: serverDetail || 'No reason was reported. Nothing was imported.',
  };
}

/**
 * The success state. A preview that comes back blocked is still a success as far
 * as the request went, and it must read as a completed check with a refusal
 * rather than as a failure of the request.
 */
export function describeMigrationSuccess(result, { mode = 'preview' } = {}) {
  if (!result || typeof result !== 'object') {
    // A 200 with nothing usable in it. The panel still has to say something.
    return {
      tone: 'error',
      code: MIGRATION_ERROR_CODE.UNKNOWN,
      title: 'The server returned an unreadable response',
      detail: 'Nothing was imported. Try again.',
    };
  }
  if (mode === 'apply') {
    const applied = result.applied || {};
    return {
      tone: 'success',
      code: null,
      title: 'Migration applied',
      detail: `${Number(applied.created || 0)} created, ${Number(applied.updated || 0)} updated, ${Number(applied.preserved || 0)} preserved.`,
    };
  }
  if (result.can_apply === false) {
    return {
      tone: 'warn',
      code: null,
      title: 'Package decrypted and validated, apply is blocked',
      detail: 'The preview below lists what has to be resolved first. Nothing was imported.',
    };
  }
  return {
    tone: 'success',
    code: null,
    title: 'Package decrypted and validated',
    detail: 'The preview below is read only. Nothing has been imported yet.',
  };
}

export default { MIGRATION_ERROR_CODE, describeMigrationFailure, describeMigrationSuccess, safeDetail };
