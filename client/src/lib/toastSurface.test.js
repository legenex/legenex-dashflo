import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The application has to actually render the toaster its code talks to.
 *
 * sonner's toast() posts to an observer. With no <Toaster /> subscribed, the
 * message is dropped and the call returns normally, so a component that reports
 * every outcome through toast reports nothing and looks like it did nothing.
 * That is exactly what happened to the owner migration import: the button ran
 * its spinner, the request failed, toast.error was called, and the operator saw
 * no preview, no success and no error.
 *
 * Only the Radix toaster was mounted, and almost nothing uses it. These tests
 * hold the mount in place and hold the imbalance visible, so removing it again
 * fails here rather than in production six weeks later.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// Comments are prose about the code, not the code. captureMask.js explains what
// it was extracted from, and this file names the provider that was swapped out;
// neither is a live reference, and a scan that cannot tell them apart forces the
// history to be deleted to keep the test green.
function code(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}


function sourceFiles(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.(js|jsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(js|jsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe('the toast surface is mounted', () => {
  const app = read('App.jsx');

  it('mounts the sonner toaster at the application root', () => {
    expect(app).toMatch(/from ["']@\/components\/ui\/sonner["']/);
    expect(app).toMatch(/<SonnerToaster\b/);
  });

  it('still mounts the Radix toaster the remaining few components use', () => {
    expect(app).toMatch(/from ["']@\/components\/ui\/toaster["']/);
    expect(app).toMatch(/<Toaster\s*\/>/);
  });

  it('is the toaster the application actually talks to', () => {
    // If this ever inverts, the mount above is the wrong one.
    const files = sourceFiles();
    const sonnerUsers = files.filter((f) => /from ['"]sonner['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(sonnerUsers.length).toBeGreaterThan(50);
  });

  it('reads the theme from the application manager rather than an unmounted provider', () => {
    // next-themes was never mounted either, so its useTheme returned "system"
    // whatever the operator had chosen and a dark app drew a light toast.
    const sonner = code(read('components/ui/sonner.jsx'));
    expect(sonner).not.toMatch(/next-themes/);
    expect(sonner).toMatch(/from ["']@\/lib\/theme["']/);
  });
});

describe('the migration panel does not depend on the toaster to be visible', () => {
  const panel = read('components/settings/SettingsExportImport.jsx');

  it('keeps an explicit status of its own', () => {
    expect(panel).toMatch(/importStatus/);
    expect(panel).toMatch(/describeMigrationFailure/);
    expect(panel).toMatch(/describeMigrationSuccess/);
  });

  it('sets a status on every ending, including the ones that never reach the server', () => {
    // The catch sets one, the success path sets one, and the preconditions that
    // used to return a bare toast now set one too.
    const body = code(panel);
    expect(body).toMatch(/describeMigrationFailure\(err/);
    expect(body).toMatch(/describeMigrationSuccess\(result/);
    expect(body).toMatch(/setImportStatus\(status\)/);
    expect(body).toMatch(/refuseImport\(/);
    // The preconditions used to return a bare toast and leave the panel blank.
    expect(body).not.toMatch(/return toast\.error\(/);
  });

  it('announces the status to assistive technology', () => {
    expect(panel).toMatch(/role=\{importStatus\.tone === 'error' \? 'alert' : 'status'\}/);
    expect(panel).toMatch(/aria-live="polite"/);
  });

  it('bounds the wait, so the spinner cannot run forever', () => {
    const fn = read('functions/systemImport.js');
    expect(fn).toMatch(/timeoutMs/);
    const client = read('api/client.js');
    expect(client).toMatch(/AbortController/);
    expect(client).toMatch(/code = timedOut \? 'timeout' : 'network'/);
  });
});
