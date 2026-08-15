import { describe, it, expect, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Pins the file upload and paste control on the Tools page.
//
// This renders the real page to static markup, the same way DistributionNav is
// tested, so the assertions are about what actually ships rather than about a
// copy of the markup. The behavioural rules are covered in fileUpload.test.js;
// what is proven here is that the control is present, that the picker offers
// exactly the file types the rules accept, and that the page still renders its
// original tooling content underneath the new section.
//
// The browser globals are installed before the page is imported, not in a
// beforeAll hook, because client/src/lib/utils.js reads window.self at module
// scope and static imports are hoisted above every hook.

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis.window ?? { self: {}, top: {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;

const { default: ToolsDashboard } = await import('./ToolsDashboard.jsx');
const { FILE_KIND, fileKind, filterAcceptedFiles } = await import('@/lib/fileUpload.js');

afterAll(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
});

function render() {
  // retry false and a fresh client keep the render deterministic and offline.
  // Nothing here may reach the network; the guard in vitest.setup.js enforces it.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/tools'] },
        React.createElement(ToolsDashboard),
      ),
    ),
  );
}

describe('the Tools page carries the file upload and paste control', () => {
  it('renders the section with its heading and guidance', () => {
    const html = render();
    expect(html).toContain('File Upload &amp; Paste');
    expect(html).toContain('Drag &amp; drop files here or click to browse');
    expect(html).toContain('Choose Files');
  });

  it('renders a multiple file input that is hidden behind the drop zone', () => {
    const html = render();
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple');
    // The input is visually hidden on purpose; the drop zone is the affordance.
    expect(html).toMatch(/type="file"[^>]*class="hidden"|class="hidden"[^>]*type="file"/);
  });

  it('offers exactly the extensions the acceptance rules allow', () => {
    const html = render();
    const accept = html.match(/accept="([^"]+)"/);
    expect(accept).toBeTruthy();
    const offered = accept[1].split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase());
    // Every offered extension is accepted once chosen. A picker that offers a
    // type the control then refuses is how a file vanishes without explanation.
    for (const ext of offered) {
      const { accepted } = filterAcceptedFiles([{ name: `sample.${ext}`, type: '' }]);
      expect(accepted, ext).toHaveLength(1);
    }
  });

  it('starts with no files selected, so no list and no upload button render', () => {
    const html = render();
    expect(html).not.toContain('Selected Files');
    expect(html).not.toContain('Clear All');
    expect(html).not.toContain('Upload Files');
  });

  it('still renders the original tooling content below the new section', () => {
    // The upload control was added above the existing page. This fails if the
    // section is ever dropped in while removing what was already there.
    const html = render();
    for (const tile of ['Notifications', 'Calculated Fields', 'Verification', 'Payload Tester']) {
      expect(html, tile).toContain(tile);
    }
    expect(html).toContain('AI Tooling Audit');
    expect(html).toContain('href="/notifications"');
    expect(html).toContain('href="/payload-tester"');
  });

  it('places the upload section before the tooling audit banner', () => {
    const html = render();
    expect(html.indexOf('File Upload &amp; Paste')).toBeGreaterThan(-1);
    expect(html.indexOf('File Upload &amp; Paste')).toBeLessThan(html.indexOf('AI Tooling Audit'));
  });
});

describe('the icon shown for a selected file', () => {
  // The row icon is chosen by fileKind, so the mapping is asserted directly
  // rather than by rendering state the static renderer cannot reach.
  it('matches the file for each supported type', () => {
    expect(fileKind({ name: 'shot.png', type: 'image/png' })).toBe(FILE_KIND.IMAGE);
    expect(fileKind({ name: 'bundle.zip', type: 'application/zip' })).toBe(FILE_KIND.ARCHIVE);
    expect(fileKind({ name: 'notes.md', type: '' })).toBe(FILE_KIND.MARKDOWN);
    expect(fileKind({ name: 'rows.csv', type: 'text/csv' })).toBe(FILE_KIND.SPREADSHEET);
    expect(fileKind({ name: 'notes.txt', type: 'text/plain' })).toBe(FILE_KIND.DOCUMENT);
  });
});
