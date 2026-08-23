import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.window = { self: {}, top: {}, location: { pathname: '/distribution' } };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
const { default: ErrorBoundary, isChunkLoadError } = await import('./ErrorBoundary.jsx');

afterAll(() => { delete globalThis.window; });

describe('route error recovery', () => {
  it('recognizes the lazy import failures produced by retired build assets', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://app.test/assets/old.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('ordinary render failure'))).toBe(false);
  });

  it('shows a visible Distribution recovery surface without exposing an asset URL or stack', () => {
    const boundary = new ErrorBoundary({ title: 'Unable to load Distribution', children: null });
    boundary.state = { hasError: true, chunkError: true };
    const html = renderToStaticMarkup(boundary.render());

    expect(html).toContain('Unable to load Distribution');
    expect(html).toContain('DashFlo was updated while this tab was open');
    expect(html).toContain('Retry');
    expect(html).toContain('Reload');
    expect(html).not.toContain('old.js');
    expect(html).not.toContain('componentStack');
  });
});
