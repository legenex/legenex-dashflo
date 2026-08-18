import { describe, it, expect } from 'vitest';
import {
  describeMigrationFailure,
  describeMigrationSuccess,
  safeDetail,
  MIGRATION_ERROR_CODE,
} from './migrationImportStatus';

/* The owner migration panel must always end in an explicit visible state.
 *
 * It did not. Every outcome was reported through `toast` from sonner, and
 * sonner's <Toaster /> was never mounted anywhere in the application, so the
 * calls went to an observer nobody had subscribed to. A failed preview stopped
 * its spinner and said nothing: no preview, no success, no error, no reason.
 *
 * Two things stop that recurring. The toaster is mounted (App.jsx), and the
 * panel keeps a state of its own that does not depend on toasts at all. These
 * tests hold the second: for every way the request can end, there is a state,
 * it names the failure, and it carries nothing an operator must not see.
 */

// Everything the panel can be handed. Whatever arrives, a state comes back.
const ENDINGS = [
  ['wrong passphrase', { status: 400, code: 'decrypt_failed', message: 'Could not decrypt migration package. Check the passphrase and file integrity.' }],
  ['malformed package', { status: 400, code: 'bad_upload', message: 'Migration file is not valid JSON' }],
  ['schema validation', { status: 400, code: 'validation_failed', message: 'Migration package source or target is not DashFlo-compatible' }],
  ['not owner', { status: 403, code: 'unauthorized', message: 'Owner migration import is owner only' }],
  ['too large', { status: 413, code: 'too_large', message: 'Migration file exceeds 250 MB' }],
  ['server error', { status: 500, code: 'internal', message: 'Migration import failed' }],
  ['timeout', { status: 0, code: 'timeout', message: 'The request timed out after 360 seconds' }],
  ['network', { status: 0, code: 'network', message: 'Could not reach the server' }],
  ['bare 400 with no code', { status: 400, message: 'Something was refused' }],
  ['bare 502 with no code', { status: 502, message: 'Bad Gateway' }],
  ['thrown string', 'boom'],
  ['thrown null', null],
  ['thrown empty error', new Error('')],
];

describe('every migration ending produces a visible state', () => {
  it.each(ENDINGS)('describes %s', (_label, thrown) => {
    const status = describeMigrationFailure(thrown);
    expect(status.tone).toBe('error');
    expect(status.title, 'a state with no title draws an empty band').toBeTruthy();
    expect(String(status.title).length).toBeGreaterThan(3);
    expect(status.code).toBeTruthy();
  });

  it('never returns null or undefined, whatever it is given', () => {
    for (const value of [undefined, null, 0, '', false, {}, [], new Error('x')]) {
      expect(describeMigrationFailure(value)).toBeTruthy();
    }
  });
});

describe('failure states say the right thing', () => {
  it('gives the decryption failure the copy the operator can act on', () => {
    const status = describeMigrationFailure({ status: 400, code: 'decrypt_failed', message: 'Could not decrypt migration package. Check the passphrase and file integrity.' });
    expect(status.code).toBe(MIGRATION_ERROR_CODE.DECRYPT_FAILED);
    expect(status.detail).toBe('Unable to decrypt this migration package. Verify the passphrase and file.');
    // The two things the operator controls, and no hint about which was wrong.
    expect(status.detail).toMatch(/passphrase/i);
    expect(status.detail).toMatch(/file/i);
  });

  it('surfaces the safe server message for a validation refusal', () => {
    const status = describeMigrationFailure({ status: 400, code: 'validation_failed', message: 'Unsupported migration crypto parameter: iterations' });
    expect(status.detail).toContain('Unsupported migration crypto parameter: iterations');
  });

  it('names a timeout as a timeout rather than letting it read as a refusal', () => {
    const status = describeMigrationFailure({ status: 0, code: 'timeout', message: 'The request timed out after 360 seconds' });
    expect(status.code).toBe(MIGRATION_ERROR_CODE.TIMEOUT);
    expect(status.title).toMatch(/timed out/i);
    expect(status.detail).toMatch(/timed out/i);
  });

  it('separates an unreachable server from a server that refused', () => {
    const offline = describeMigrationFailure({ status: 0, code: 'network', message: 'Could not reach the server' });
    const refused = describeMigrationFailure({ status: 400, code: 'validation_failed', message: 'Refused' });
    expect(offline.code).toBe(MIGRATION_ERROR_CODE.NETWORK);
    expect(refused.code).toBe(MIGRATION_ERROR_CODE.VALIDATION_FAILED);
    expect(offline.title).not.toBe(refused.title);
  });

  it('classifies by status when the server sent no code', () => {
    expect(describeMigrationFailure({ status: 401 }).code).toBe(MIGRATION_ERROR_CODE.UNAUTHORIZED);
    expect(describeMigrationFailure({ status: 413 }).code).toBe(MIGRATION_ERROR_CODE.TOO_LARGE);
    expect(describeMigrationFailure({ status: 500 }).code).toBe(MIGRATION_ERROR_CODE.INTERNAL);
    expect(describeMigrationFailure({ status: 422 }).code).toBe(MIGRATION_ERROR_CODE.VALIDATION_FAILED);
  });

  it('quotes the run id for a server failure so the log line can be found', () => {
    const status = describeMigrationFailure({ status: 500, code: 'internal', message: 'Migration import failed', data: { run_id: 'abc123' } });
    expect(status.detail).toContain('abc123');
    expect(status.detail).toMatch(/Nothing was imported/i);
  });

  it('says an apply that failed imported nothing', () => {
    const status = describeMigrationFailure({ status: 500, code: 'internal', message: 'Migration import failed' }, { mode: 'apply' });
    expect(status.title).toMatch(/apply/i);
    expect(status.detail).toMatch(/Nothing was imported/i);
  });
});

describe('nothing sensitive can reach the screen through this path', () => {
  it('keeps only the first line, so a stack trace cannot be rendered', () => {
    const stack = 'Error: boom\n    at decryptChunk (/app/server/src/lib/migrationImport.js:88:11)\n    at normalizeOwner';
    expect(safeDetail(stack)).toBe('Error: boom');
    const status = describeMigrationFailure({ status: 500, code: 'internal', message: stack });
    expect(status.detail).not.toContain('migrationImport.js');
    expect(status.detail).not.toContain('    at ');
  });

  it('bounds the detail, so a raw payload echoed back cannot be dumped', () => {
    const huge = `lgnx_sup_${'a'.repeat(5000)}`;
    const status = describeMigrationFailure({ status: 400, code: 'validation_failed', message: huge });
    expect(status.detail.length).toBeLessThanOrEqual(304);
    expect(status.detail.endsWith('...')).toBe(true);
  });

  it('never reads the passphrase, because it is never given one', () => {
    // The panel passes the thrown error and the mode. There is no parameter
    // here through which a passphrase could travel.
    expect(describeMigrationFailure.length).toBeLessThanOrEqual(2);
    const status = describeMigrationFailure({ status: 400, code: 'decrypt_failed', message: 'Could not decrypt migration package.' });
    expect(JSON.stringify(status)).not.toMatch(/passphrase.*[:=]\s*\S/i);
  });
});

describe('success states', () => {
  it('reports a validated preview as read only', () => {
    const status = describeMigrationSuccess({ can_apply: true, records_present: 12 });
    expect(status.tone).toBe('success');
    expect(status.detail).toMatch(/read only/i);
    expect(status.detail).toMatch(/Nothing has been imported/i);
  });

  it('reports a blocked preview as a completed check, not a failed request', () => {
    const status = describeMigrationSuccess({ can_apply: false });
    expect(status.tone).toBe('warn');
    expect(status.title).toMatch(/decrypted and validated/i);
    expect(status.detail).toMatch(/Nothing was imported/i);
  });

  it('reports what an apply changed', () => {
    const status = describeMigrationSuccess({ applied: { created: 4, updated: 2, preserved: 1 } }, { mode: 'apply' });
    expect(status.tone).toBe('success');
    expect(status.detail).toContain('4 created');
    expect(status.detail).toContain('2 updated');
  });

  it('treats an unreadable 200 as an error rather than drawing an empty preview', () => {
    for (const body of [null, undefined, 'not json', 42]) {
      const status = describeMigrationSuccess(body);
      expect(status.tone).toBe('error');
      expect(status.title).toBeTruthy();
    }
  });
});
