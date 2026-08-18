import { describe, expect, it } from 'vitest';
import {
  formatBytes, migrationCounts, migrationPercent, stageCopy, UPLOAD_SHARE,
} from '@/lib/migrationProgressModel';

/* What the operator is told, and what is never invented.
 *
 * The requirement this protects is that no percentage is fabricated. A number
 * appears only when it was measured: bytes the browser actually sent, or chunks
 * the server actually decrypted. Anywhere else the model returns null so the
 * panel can draw an honest indeterminate bar instead of a confident wrong one.
 */

describe('migration percent', () => {
  it('reports real upload bytes while uploading', () => {
    expect(migrationPercent({ phase: 'uploading', uploadLoaded: 0, uploadTotal: 100 })).toBe(0);
    expect(migrationPercent({ phase: 'uploading', uploadLoaded: 50, uploadTotal: 100 }))
      .toBe(Math.round(0.5 * UPLOAD_SHARE * 100));
    expect(migrationPercent({ phase: 'uploading', uploadLoaded: 100, uploadTotal: 100 }))
      .toBe(Math.round(UPLOAD_SHARE * 100));
  });

  it('never lets the upload alone fill the bar', () => {
    const full = migrationPercent({ phase: 'uploading', uploadLoaded: 999, uploadTotal: 100 });
    expect(full).toBeLessThanOrEqual(Math.round(UPLOAD_SHARE * 100));
    expect(full).toBeLessThan(100);
  });

  it('is honestly unknown rather than zero when nothing has been measured', () => {
    expect(migrationPercent({ phase: 'uploading', uploadLoaded: 0, uploadTotal: 0 })).toBeNull();
    expect(migrationPercent({ phase: 'server', serverPercent: null })).toBeNull();
    expect(migrationPercent({ phase: 'server' })).toBeNull();
    expect(migrationPercent({ phase: 'preparing' })).toBeNull();
  });

  it('folds real server progress into the part of the bar after the upload', () => {
    const zero = migrationPercent({ phase: 'server', serverPercent: 0 });
    const half = migrationPercent({ phase: 'server', serverPercent: 50 });
    const done = migrationPercent({ phase: 'server', serverPercent: 100 });
    expect(zero).toBe(Math.round(UPLOAD_SHARE * 100));
    expect(half).toBeGreaterThan(zero);
    expect(done).toBe(100);
  });

  it('advances monotonically from upload through server work', () => {
    const seen = [
      migrationPercent({ phase: 'uploading', uploadLoaded: 10, uploadTotal: 100 }),
      migrationPercent({ phase: 'uploading', uploadLoaded: 100, uploadTotal: 100 }),
      migrationPercent({ phase: 'server', serverPercent: 20 }),
      migrationPercent({ phase: 'server', serverPercent: 80 }),
      migrationPercent({ phase: 'complete' }),
    ];
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(100);
  });

  it('clamps a server percentage that is out of range', () => {
    expect(migrationPercent({ phase: 'server', serverPercent: -10 })).toBe(Math.round(UPLOAD_SHARE * 100));
    expect(migrationPercent({ phase: 'server', serverPercent: 5000 })).toBe(100);
  });
});

describe('stage copy', () => {
  it('names every stage the server can report', () => {
    for (const stage of [
      'received', 'parsing', 'validating_envelope', 'deriving_key',
      'decrypting', 'validating', 'building_preview', 'applying', 'complete',
    ]) {
      expect(stageCopy(stage).label).toBeTruthy();
    }
  });

  it('names the stages the browser owns', () => {
    expect(stageCopy('preparing').label).toBe('Preparing upload');
    expect(stageCopy('uploading').label).toBe('Uploading encrypted package');
    expect(stageCopy('uploaded').label).toBe('Upload complete');
  });

  it('falls back to a neutral label rather than throwing on an unknown stage', () => {
    expect(stageCopy('nonsense').label).toBe('Working');
    expect(stageCopy(undefined).label).toBe('Working');
  });
});

describe('counts line', () => {
  it('shows sent bytes while uploading', () => {
    expect(migrationCounts({ phase: 'uploading', uploadLoaded: 1048576, uploadTotal: 2097152 }))
      .toBe('1.0 MB / 2.0 MB');
  });

  it('shows real chunk counts while decrypting', () => {
    expect(migrationCounts({ phase: 'server', stage: 'decrypting', processedChunks: 42, totalChunks: 80 }))
      .toBe('42 / 80 chunks');
  });

  it('shows nothing when there is nothing measured to show', () => {
    expect(migrationCounts({ phase: 'server', stage: 'deriving_key' })).toBe('');
    expect(migrationCounts({ phase: 'server', stage: 'decrypting', totalChunks: 0 })).toBe('');
    expect(migrationCounts({ phase: 'uploading', uploadTotal: 0 })).toBe('');
  });

  it('never puts a record, a filename or a passphrase in the counts line', () => {
    const line = migrationCounts({
      phase: 'server', stage: 'decrypting', processedChunks: 1, totalChunks: 2,
      passphrase: 'super secret passphrase', fileName: 'migration.json.enc',
    });
    expect(line).toBe('1 / 2 chunks');
  });
});

describe('byte formatting', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(130739398)).toBe('124.7 MB');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});
