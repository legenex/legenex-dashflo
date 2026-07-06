// App-level parameters for the standalone client. The hosted platform used to
// inject an app id / access token via the URL; here we only need the access
// token (kept in localStorage by the API client) and an optional base URL.

const TOKEN_KEY = 'dashos_access_token';

const readToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};

export const appParams = {
  token: readToken(),
  appBaseUrl: import.meta.env.VITE_API_BASE || '/api',
  fromUrl: typeof window !== 'undefined' ? window.location.href : '',
};

export default appParams;
