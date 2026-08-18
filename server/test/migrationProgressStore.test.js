import { beforeEach, describe, expect, it } from 'vitest';
import {
  finishProgress, isValidProgressId, progressSink, readProgress, resetProgressForTests, startProgress,
} from '../src/lib/migrationProgress.js';

/* Import progress state.
 *
 * This is the one surface added for the progress indicator that is polled, so
 * it is the easiest place in the feature to leak something. The tests below are
 * as much about what a record cannot carry, and who cannot read one, as about
 * the counting.
 */

const ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);
const OWNER = 'user-owner';

beforeEach(() => resetProgressForTests());

describe('progress id shape', () => {
  it('accepts only a 32 character hex id', () => {
    expect(isValidProgressId(ID)).toBe(true);
    expect(isValidProgressId('A'.repeat(32))).toBe(false);
    expect(isValidProgressId('a'.repeat(31))).toBe(false);
    expect(isValidProgressId('a'.repeat(33))).toBe(false);
    expect(isValidProgressId('../../etc/passwd')).toBe(false);
    expect(isValidProgressId('')).toBe(false);
    expect(isValidProgressId(null)).toBe(false);
    expect(isValidProgressId(123)).toBe(false);
  });

  it('refuses to start a record for a malformed id', () => {
    expect(startProgress({ id: 'nope', userId: OWNER, mode: 'preview', kind: 'owner' })).toBeNull();
    expect(readProgress('nope', OWNER)).toBeNull();
  });
});

describe('progress isolation', () => {
  it('answers only the user that created the record', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner', bytes: 10 });
    expect(readProgress(ID, OWNER)).not.toBeNull();
    expect(readProgress(ID, 'someone-else')).toBeNull();
    expect(readProgress(ID, null)).toBeNull();
    expect(readProgress(ID, undefined)).toBeNull();
  });

  it('does not reveal that an unknown id exists', () => {
    expect(readProgress(OTHER_ID, OWNER)).toBeNull();
  });
});

describe('progress content', () => {
  it('carries only stage names and counts, never package content', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner', bytes: 4096 });
    const sink = progressSink(ID);
    sink.stage('decrypting', { total_chunks: 80, processed_chunks: 0 });
    sink.chunk(40);

    const state = readProgress(ID, OWNER);
    expect(Object.keys(state).sort()).toEqual([
      'code', 'done', 'failed', 'id', 'kind', 'mode', 'percent',
      'processed_chunks', 'stage', 'total_bytes', 'total_chunks',
    ]);
    // Nothing in the record is free text supplied by the package or the user.
    for (const [key, value] of Object.entries(state)) {
      if (['id', 'mode', 'kind', 'stage', 'code'].includes(key)) continue;
      expect(typeof value === 'number' || typeof value === 'boolean').toBe(true);
    }
  });

  it('refuses a stage name it does not define', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    const sink = progressSink(ID);
    sink.stage('decrypting', { total_chunks: 10 });
    sink.stage('exfiltrating the passphrase');
    expect(readProgress(ID, OWNER).stage).toBe('decrypting');
  });

  it('ignores non integer counts', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    const sink = progressSink(ID);
    sink.stage('decrypting', { total_chunks: 10 });
    sink.chunk('40');
    sink.chunk(1.5);
    expect(readProgress(ID, OWNER).processed_chunks).toBe(0);
  });
});

describe('progress percentage', () => {
  it('advances with real chunk counts while decrypting', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    const sink = progressSink(ID);
    sink.stage('decrypting', { total_chunks: 80, processed_chunks: 0 });
    const atStart = readProgress(ID, OWNER).percent;

    sink.chunk(40);
    const atHalf = readProgress(ID, OWNER).percent;
    sink.chunk(80);
    const atEnd = readProgress(ID, OWNER).percent;

    expect(atHalf).toBeGreaterThan(atStart);
    expect(atEnd).toBeGreaterThan(atHalf);
    expect(atEnd).toBeLessThanOrEqual(100);
  });

  it('never runs backwards across the ordinary stage sequence', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    const sink = progressSink(ID);
    const seen = [];
    for (const stage of ['received', 'parsing', 'validating_envelope', 'deriving_key', 'decrypting', 'validating', 'building_preview', 'complete']) {
      sink.stage(stage);
      seen.push(readProgress(ID, OWNER).percent);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(100);
  });

  it('does not divide by a chunk total it was never given', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    progressSink(ID).stage('decrypting');
    expect(Number.isFinite(readProgress(ID, OWNER).percent)).toBe(true);
  });
});

describe('progress completion', () => {
  it('records a success as complete with no error code', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    finishProgress(ID, { failed: false });
    const state = readProgress(ID, OWNER);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(false);
    expect(state.stage).toBe('complete');
    expect(state.code).toBeNull();
  });

  it('records a failure with the stable code and keeps the stage it stopped at', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    progressSink(ID).stage('deriving_key');
    finishProgress(ID, { failed: true, code: 'decrypt_failed' });
    const state = readProgress(ID, OWNER);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(true);
    expect(state.stage).toBe('deriving_key');
    expect(state.code).toBe('decrypt_failed');
  });

  it('bounds the error code so a message cannot be smuggled through it', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    finishProgress(ID, { failed: true, code: 'x'.repeat(500) });
    expect(readProgress(ID, OWNER).code).toHaveLength(40);
  });

  it('stops accepting updates once finished', () => {
    startProgress({ id: ID, userId: OWNER, mode: 'preview', kind: 'owner' });
    const sink = progressSink(ID);
    finishProgress(ID, { failed: false });
    sink.stage('decrypting', { total_chunks: 10 });
    sink.chunk(5);
    expect(readProgress(ID, OWNER).stage).toBe('complete');
  });
});

describe('progress store bounds', () => {
  it('keeps the map bounded when many imports are started', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = i.toString(16).padStart(32, '0');
      startProgress({ id, userId: OWNER, mode: 'preview', kind: 'owner' });
    }
    let live = 0;
    for (let i = 0; i < 200; i += 1) {
      const id = i.toString(16).padStart(32, '0');
      if (readProgress(id, OWNER)) live += 1;
    }
    expect(live).toBeLessThanOrEqual(64);
    expect(live).toBeGreaterThan(0);
  });

  it('gives no sink for an unknown id', () => {
    expect(progressSink(OTHER_ID)).toBeNull();
    expect(progressSink('')).toBeNull();
  });
});
