import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { AuthProvider } from '@/lib/AuthContext';
import { capturePageElement } from '@/lib/progress/capture';

// Offscreen capture.
//
// The previous approach navigated the browser to each page, captured it, then
// navigated back. It worked, but being dragged around your own app to take a
// screenshot is intolerable, and it made capturing a whole section a tour.
//
// This mounts the page component into a hidden, fixed-width container in the
// current document instead. Nothing navigates. Because the container width is
// set here rather than inherited from the window, desktop, tablet and mobile
// captures are all possible from one browser at any size, which the navigating
// version could never do.
//
// It cannot be done on the server: the backend functions run Deno with no browser, so
// there is no renderer. A headless browser on a runner is the only server-side
// option and that is the infrastructure item in docs/screenshot-automation.md.
//
// Page components are resolved from the real files by glob, so this cannot drift
// from the router the way a hand-maintained component map would.

const PAGE_MODULES = import.meta.glob('/src/pages/**/*.jsx');

export const CAPTURE_WIDTHS = {
  desktop: 1440,
  tablet: 768,
  mobile: 390,
};

// Parse the inline props the router passes, e.g. view="sold".
function parseProps(raw) {
  const out = {};
  if (!raw) return out;
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  let m;
  while ((m = re.exec(raw))) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined) continue;
    out[m[1]] = value.trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function loadComponent(componentPath) {
  if (!componentPath) throw new Error('No component path recorded for this surface');
  const key = componentPath.startsWith('/') ? componentPath : `/${componentPath}`;
  const loader = PAGE_MODULES[key];
  if (!loader) throw new Error(`Component ${componentPath} is not a page module, so it cannot be rendered offscreen`);
  const mod = await loader();
  if (!mod?.default) throw new Error(`${componentPath} has no default export`);
  return mod.default;
}

// A boundary so one page that cannot render outside its usual shell is reported
// as a failed capture rather than taking the whole run down.
class CaptureBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { this.props.onError?.(error); }
  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

function makeHost(width) {
  const host = document.createElement('div');
  host.setAttribute('data-progress-capture-ui', 'true');
  host.setAttribute('data-offscreen-capture', 'true');
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    // Far off to the left rather than display:none, because a hidden element has
    // no layout and html2canvas would rasterise nothing.
    left: '-100000px',
    width: `${width}px`,
    minHeight: '900px',
    background: getComputedStyle(document.body).backgroundColor || '#0A0E15',
    zIndex: '-1',
    pointerEvents: 'none',
    overflow: 'visible',
  });
  document.body.appendChild(host);
  return host;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Settle heuristic: react-query exposes how many fetches are in flight, so wait
// for zero with a floor and a ceiling. A page that never settles is captured
// anyway, because a screenshot of a stuck page is itself worth seeing.
async function waitForSettle({ minMs = 1200, maxMs = 15000 } = {}) {
  const started = Date.now();
  await wait(minMs);
  while (Date.now() - started < maxMs) {
    if (queryClientInstance.isFetching() === 0) {
      await wait(350);
      if (queryClientInstance.isFetching() === 0) return true;
    }
    await wait(250);
  }
  return false;
}

/**
 * Render one page offscreen and capture it. Resolves to the PageSnapshot record.
 * Always resolves: a failure produces a snapshot with capture_status failed.
 */
export async function captureOffscreen(page, {
  viewport = 'desktop',
  mask = true,
  role,
  capturedBy,
} = {}) {
  const width = CAPTURE_WIDTHS[viewport] || CAPTURE_WIDTHS.desktop;
  let host = null;
  let root = null;
  let renderError = null;

  try {
    const Component = await loadComponent(page.component_path);
    const props = parseProps(page.component_props);
    host = makeHost(width);
    root = createRoot(host);

    // The page gets its own router seeded with the real route so useSearchParams
    // and useNavigate behave, and shares the live query client and auth so it
    // renders the same data you would see.
    await new Promise((resolve) => {
      root.render(
        <AuthProvider>
          <QueryClientProvider client={queryClientInstance}>
            <MemoryRouter initialEntries={[page.route || '/']}>
              <CaptureBoundary onError={(e) => { renderError = e; }}>
                <Component {...props} />
              </CaptureBoundary>
            </MemoryRouter>
          </QueryClientProvider>
        </AuthProvider>,
      );
      setTimeout(resolve, 60);
    });

    if (renderError) throw renderError;
    const settled = await waitForSettle();
    if (renderError) throw renderError;

    if (!host.firstChild || host.scrollHeight < 40) {
      throw new Error('The page rendered empty outside its normal layout');
    }

    return await capturePageElement({
      pageKey: page.page_key,
      route: page.route,
      element: host,
      viewport,
      width,
      mask,
      role,
      capturedBy,
      notes: settled ? null : 'Captured before all queries settled',
    });
  } catch (err) {
    return capturePageElement({
      pageKey: page.page_key,
      route: page.route,
      element: null,
      viewport,
      width,
      mask,
      role,
      capturedBy,
      forcedError: String(err?.message || err),
    });
  } finally {
    if (root) { try { root.unmount(); } catch { /* already gone */ } }
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }
}

/**
 * Run a batch offscreen, one at a time so the query client is not swamped.
 * Reports progress as it goes and can be stopped.
 */
export function useOffscreenCapture({ role, capturedBy, mask = true, onDone } = {}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);

  const run = useCallback(async (pages, { viewports = ['desktop'], label = 'pages' } = {}) => {
    const targets = (pages || []).filter((p) => p.component_path);
    if (targets.length === 0) return;

    cancelRef.current = false;
    setRunning(true);
    const total = targets.length * viewports.length;
    let done = 0;
    let failed = 0;

    for (const page of targets) {
      for (const viewport of viewports) {
        if (cancelRef.current) break;
        setProgress({ done, total, failed, current: page.title, viewport, label });
        // eslint-disable-next-line no-await-in-loop
        const snap = await captureOffscreen(page, { viewport, mask, role, capturedBy });
        if (snap?.capture_status === 'failed') failed += 1;
        done += 1;
      }
      if (cancelRef.current) break;
    }

    setProgress({ done, total, failed, current: null, label, finished: true, cancelled: cancelRef.current });
    setRunning(false);
    onDone?.({ done, total, failed, cancelled: cancelRef.current });
  }, [mask, role, capturedBy, onDone]);

  return { run, cancel, running, progress, clear: () => setProgress(null) };
}
