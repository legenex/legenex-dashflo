import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskEnabled, setMaskEnabled } from '@/lib/progress/captureMask';

/* "Capture for review" is gone from the application, not hidden in it.
 *
 * A floating pill sat at the bottom of every operator page offering to capture
 * the current screen for review, with a masked indicator beside it. It belonged
 * to the Progress review workflow, which is now owner tooling on its own host.
 * The ordinary application must not carry a review affordance at all.
 *
 * Removing the mount is not enough on its own: the component, its sessionStorage
 * capture queue and its progress_capture navigation protocol all had to go with
 * it, or the next person to look would find a global control that is one line
 * away from being mounted again.
 *
 * These are file-level assertions on purpose. "Absent from every operator
 * surface" is a claim about the whole tree, and a rendering test can only speak
 * for the routes it happens to render.
 *
 * This lives in lib/ rather than beside the components, because
 * components/progress/OffscreenCapture.jsx globs the component and page
 * directories into the production build.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');

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

const FILES = sourceFiles();
const read = (file) => fs.readFileSync(file, 'utf8');

// Comments are prose about the code, not the code. captureMask.js explains what
// it was extracted from, and this file names the provider that was swapped out;
// neither is a live reference, and a scan that cannot tell them apart forces the
// history to be deleted to keep the test green.
function code(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (file) => path.relative(SRC, file);

describe('the floating capture control is gone from the application', () => {
  it('ships no CaptureController component', () => {
    expect(fs.existsSync(path.join(SRC, 'components/progress/CaptureController.jsx'))).toBe(false);
  });

  it('has no module importing it, so nothing is left dangling', () => {
    const importers = FILES.filter((f) => /CaptureController/.test(code(read(f)))).map(rel);
    expect(importers).toEqual([]);
  });

  it('puts the label on no user-visible surface', () => {
    const showing = FILES.filter((f) => code(read(f)).includes('Capture for review')).map(rel);
    expect(showing).toEqual([]);
  });

  it('is not mounted by the operator shell', () => {
    // AppLayout is the shell every operator page renders inside, which is what
    // made this control global in the first place.
    const layout = read(path.join(SRC, 'components/layout/AppLayout.jsx'));
    expect(layout).not.toMatch(/CaptureController/);
    expect(layout).not.toMatch(/Capture for review/);
  });

  it('leaves no global mount of any capture control behind', () => {
    // The three places a control becomes global: the app root, the operator
    // shell, and the mobile chrome.
    for (const file of ['App.jsx', 'components/layout/AppLayout.jsx', 'components/layout/MobileBottomTabs.jsx']) {
      const full = path.join(SRC, file);
      if (!fs.existsSync(full)) continue;
      expect(read(full), file).not.toMatch(/Capture(Controller|ForReview)/);
    }
  });

  it('retires the capture queue and its navigation protocol with it', () => {
    // The control drove a queue through sessionStorage and walked the operator
    // around their own app with a progress_capture query parameter. Neither has
    // a remaining owner.
    const offenders = FILES.filter((f) => {
      const text = read(f);
      const body = code(text);
      return /startCaptureQueue|setCaptureReturn|progress_capture_queue|progress_capture_return/.test(body)
        || /[?&]progress_capture=/.test(body);
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  it('removes the in-page capturePage helper the control was the only caller of', () => {
    const capture = read(path.join(SRC, 'lib/progress/capture.js'));
    expect(capture).not.toMatch(/export async function capturePage\b/);
    // The offscreen capturer the Control Center actually uses stays.
    expect(capture).toMatch(/export async function capturePageElement\b/);
  });
});

describe('what the Control Center still depends on is preserved', () => {
  it('keeps the offscreen capturer and the region crop the review workspace uses', () => {
    const capture = read(path.join(SRC, 'lib/progress/capture.js'));
    expect(capture).toMatch(/export async function capturePageElement/);
    expect(capture).toMatch(/export async function cropAndUpload/);

    const offscreen = read(path.join(SRC, 'components/progress/OffscreenCapture.jsx'));
    expect(offscreen).toMatch(/capturePageElement/);

    const review = read(path.join(SRC, 'components/progress/VisualReview.jsx'));
    expect(review).toMatch(/cropAndUpload/);
  });

  it('keeps the masking preference, now owned by a module of its own', () => {
    const review = read(path.join(SRC, 'components/progress/VisualReview.jsx'));
    expect(review).toMatch(/from '@\/lib\/progress\/captureMask'/);
    expect(typeof maskEnabled).toBe('function');
    expect(typeof setMaskEnabled).toBe('function');
  });

  it('defaults the masking preference to on when storage is unavailable', () => {
    // A capture of a live operator page holds real lead names, emails and phone
    // numbers, so the setting you get without choosing is the safe one.
    const original = globalThis.sessionStorage;
    try {
      delete globalThis.sessionStorage;
      expect(maskEnabled()).toBe(true);
      expect(() => setMaskEnabled(false)).not.toThrow();
    } finally {
      if (original === undefined) delete globalThis.sessionStorage;
      else globalThis.sessionStorage = original;
    }
  });

  it('reads and writes the preference when storage is available', () => {
    const store = new Map();
    const original = globalThis.sessionStorage;
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
    try {
      expect(maskEnabled()).toBe(true);
      setMaskEnabled(false);
      expect(maskEnabled()).toBe(false);
      setMaskEnabled(true);
      expect(maskEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete globalThis.sessionStorage;
      else globalThis.sessionStorage = original;
    }
  });
});
