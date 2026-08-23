import React, { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CHUNK_ERROR = /dynamically imported module|importing a module script failed|chunkloaderror|failed to fetch.*module|mime type.*text\/html/i;
const RELOAD_WINDOW_MS = 60_000;

export function isChunkLoadError(error) {
  const text = `${error?.name || ''}: ${error?.message || error || ''}`;
  return CHUNK_ERROR.test(text);
}

function safeErrorMeta(error, title) {
  const message = String(error?.message || error || 'Unknown client error')
    .replace(/https?:\/\/\S+/gi, '[asset-url]')
    .slice(0, 240);
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message,
    component: String(title || 'Application').slice(0, 80),
    route: typeof window !== 'undefined' ? window.location.pathname : '',
  };
}

// Catches page and lazy-route failures. Chunk failures get one guarded reload
// so a long-lived tab can replace an old asset manifest after a deployment.
// If the reload does not recover, the route stays usable and offers Retry and
// Reload controls instead of leaving the app-wide Suspense fallback on screen.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, chunkError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, chunkError: isChunkLoadError(error) };
  }

  componentDidCatch(error) {
    const meta = safeErrorMeta(error, this.props.title);
    console.error('Client route error', meta);

    if (!isChunkLoadError(error) || typeof window === 'undefined') return;
    const key = `dashflo_chunk_reload:${window.location.pathname}`;
    let lastReload = 0;
    try { lastReload = Number(window.sessionStorage.getItem(key) || 0); } catch {}
    if (Date.now() - lastReload < RELOAD_WINDOW_MS) return;
    try { window.sessionStorage.setItem(key, String(Date.now())); } catch {}
    window.location.reload();
  }

  handleRetry = () => {
    this.setState({ hasError: false, chunkError: false });
  };

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const title = this.props.title || 'Unable to load this page';
    return (
      <div className="min-h-[320px] rounded-[10px] border border-border bg-card p-8 flex flex-col items-center justify-center text-center gap-3">
        <div className="w-11 h-11 rounded-full bg-status-error flex items-center justify-center">
          <AlertTriangle className="w-5 h-5 status-error" />
        </div>
        <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
        <p className="text-[12px] text-muted-foreground max-w-md">
          {this.state.chunkError
            ? 'DashFlo was updated while this tab was open. Reload to use the current application files.'
            : 'This page stopped while loading. Retry the page or reload DashFlo.'}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={this.handleRetry}>
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </Button>
          <Button size="sm" className="gap-1.5" onClick={this.handleReload}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
