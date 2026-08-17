import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import { loadGoogleIdentityServices, createLoginNonce } from '@/lib/googleSignIn';
import GoogleIcon from '@/components/GoogleIcon';
import { Loader2 } from 'lucide-react';

// Google sign-in control for the login page.
//
// It renders nothing at all until the server confirms Google sign-in is
// configured, so an installation without a Client ID shows no dead button and
// makes no request to Google.
//
// Google's own rendered button is used rather than a look-alike, because
// Google's branding terms require it and because the rendered button is what
// carries the account chooser. It is themed to match DashFlo: the widget reads
// the resolved light or dark theme from the document and re-renders when the
// theme changes, so it does not sit as a white rectangle in dark mode.

function resolvedTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export default function GoogleSignInButton({ onError, onSuccess, dividerLabel = 'or continue with email' }) {
  const holder = useRef(null);
  const nonce = useRef(null);
  const [state, setState] = useState('checking');
  const [clientId, setClientId] = useState('');
  const [theme, setTheme] = useState(resolvedTheme);

  const handleCredential = useCallback(async (response) => {
    setState('signing-in');
    try {
      await api.auth.loginWithGoogle({ credential: response?.credential, nonce: nonce.current });
      if (onSuccess) onSuccess();
      else window.location.href = '/';
    } catch (error) {
      setState('ready');
      if (onError) onError(error?.message || 'Google sign-in was refused');
    }
  }, [onError, onSuccess]);

  // Track the app theme so the Google widget matches it.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => setTheme(resolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.auth.googleConfig();
        if (cancelled) return;
        if (!config?.enabled || !config?.client_id) { setState('unavailable'); return; }
        setClientId(config.client_id);
        setState('loading');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!clientId || state === 'unavailable' || state === 'checking') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const gis = await loadGoogleIdentityServices();
        if (cancelled || !holder.current) return;
        nonce.current = createLoginNonce();
        gis.initialize({
          client_id: clientId,
          callback: handleCredential,
          nonce: nonce.current,
          // Neither of these is a login shortcut we want: the operator should
          // choose an account deliberately on a shared machine.
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
        });
        holder.current.innerHTML = '';
        gis.renderButton(holder.current, {
          type: 'standard',
          theme: theme === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: holder.current.offsetWidth || 360,
        });
        setState('ready');
      } catch (error) {
        if (!cancelled) {
          setState('unavailable');
          if (onError) onError('Google sign-in is unavailable right now');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, state === 'unavailable', theme, handleCredential, onError]);

  if (state === 'checking' || state === 'unavailable') return null;

  return (
    <div className="mb-7">
      {/* Google's control leads. It is the way most people sign in here, so it
          sits above the email form rather than being tucked under it as an
          afterthought, and it spans the full column width so it reads as a
          primary action. The widget itself is still Google's own rendering,
          which their branding terms require and which is what carries the
          account chooser. */}
      <div className="relative min-h-[44px]">
        <div ref={holder} className="flex justify-center [color-scheme:light] dark:[color-scheme:dark]" />
        {(state === 'loading' || state === 'signing-in') && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg bg-background text-sm text-muted-foreground">
            {state === 'signing-in'
              ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Signing in with Google...</>
              : <><GoogleIcon className="h-4 w-4" /> Preparing Google sign-in...</>}
          </div>
        )}
      </div>
      <div className="relative mt-7">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {dividerLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
