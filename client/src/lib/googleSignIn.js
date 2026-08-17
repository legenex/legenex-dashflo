// Google Identity Services loader.
//
// The GIS library must come from Google's own origin: the script is what talks
// to Google's session, and a self-hosted copy cannot do that. It is loaded once
// and only when Google sign-in is actually configured, so an installation that
// has not set a Client ID makes no third-party request at all and shows no
// Google control.
//
// Nothing here holds a secret. The Client ID is public by design; the ID token
// the button produces is proved server-side.

const GIS_SRC = 'https://accounts.google.com/gsi/client';

let loader = null;

export function loadGoogleIdentityServices() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No browser environment'));
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    const script = existing || document.createElement('script');
    const settle = () => {
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
      else reject(new Error('Google Identity Services did not initialise'));
    };
    script.addEventListener('load', settle, { once: true });
    script.addEventListener('error', () => reject(new Error('Google Identity Services could not be loaded')), { once: true });
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.google?.accounts?.id) {
      settle();
    }
  }).catch((error) => {
    // Let a later attempt retry rather than caching the failure forever.
    loader = null;
    throw error;
  });

  return loader;
}

// A per-attempt nonce. Google embeds it in the ID token and the server
// compares it against the value the same page sends alongside, so a token
// captured from one login attempt cannot be replayed into another.
export function createLoginNonce() {
  const bytes = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default { loadGoogleIdentityServices, createLoginNonce };
