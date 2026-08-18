import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MigrationProgress } from '@/components/settings/MigrationProgress';

/* The progress surface itself.
 *
 * The rule these hold is that the operator always has a visible state. The panel
 * appears while the import runs, it survives the end of the run, and a failure
 * leaves the stage it stopped at on screen rather than clearing back to nothing.
 * The previous regression this guards against is an outcome that existed only as
 * a toast, which is invisible when no toaster is mounted.
 */

const render = (state) => renderToStaticMarkup(<MigrationProgress state={state} />);

const running = (overrides = {}) => ({
  phase: 'server',
  stage: 'decrypting',
  uploadLoaded: 100,
  uploadTotal: 100,
  serverPercent: 40,
  processedChunks: 42,
  totalChunks: 80,
  mode: 'preview',
  done: false,
  failed: false,
  ...overrides,
});

describe('migration progress panel', () => {
  it('renders while the server is working', () => {
    const html = render(running());
    expect(html).toContain('data-testid="migration-progress"');
    expect(html).toContain('Decrypting migration package');
  });

  it('shows real chunk counts rather than a vague message', () => {
    expect(render(running())).toContain('42 / 80 chunks');
  });

  it('shows upload bytes while the package is still going up', () => {
    const html = render(running({
      phase: 'uploading', stage: 'uploading', uploadLoaded: 1048576, uploadTotal: 2097152, serverPercent: null,
    }));
    expect(html).toContain('Uploading encrypted package');
    expect(html).toContain('1.0 MB / 2.0 MB');
  });

  it('announces itself to assistive technology', () => {
    const html = render(running());
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('reaches 100 percent on success', () => {
    const html = render(running({ phase: 'complete', stage: 'complete', done: true }));
    expect(html).toContain('100%');
  });

  it('stays visible after a failure and names the stage it stopped at', () => {
    const html = render(running({ stage: 'deriving_key', done: true, failed: true }));
    expect(html).toContain('data-testid="migration-progress"');
    expect(html).toContain('Stopped during');
    expect(html).toContain('Deriving decryption key');
  });

  it('does not claim a percentage on a failed run', () => {
    const html = render(running({ stage: 'deriving_key', done: true, failed: true }));
    expect(html).not.toContain('%');
  });

  it('draws an indeterminate bar rather than a fabricated percentage', () => {
    const html = render(running({ phase: 'server', stage: 'deriving_key', serverPercent: null }));
    expect(html).not.toContain('%');
    expect(html).toContain('animate-pulse');
  });

  it('never renders package content, a passphrase or a filename', () => {
    const html = render(running({
      passphrase: 'a real migration passphrase',
      fileName: 'legenex-dashflo-migration.json.enc',
      records: [{ email: 'lead@example.test' }],
    }));
    expect(html).not.toContain('passphrase');
    expect(html).not.toContain('legenex-dashflo-migration');
    expect(html).not.toContain('lead@example.test');
  });

  it('stops the spinner once the run has ended', () => {
    expect(render(running())).toContain('animate-spin');
    expect(render(running({ phase: 'complete', stage: 'complete', done: true }))).not.toContain('animate-spin');
  });
});
