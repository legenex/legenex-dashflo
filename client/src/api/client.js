// Standalone API client. Drop-in replacement for the previous hosted-platform
// SDK: exposes the same surface (api.entities.<Name>.*, api.auth.*,
// api.functions.invoke, api.integrations.Core.*) but talks to our own backend.

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const TOKEN_KEY = 'dashos_access_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch {}
}

// Core request helper. Throws an Error carrying { status, data } on non-2xx
// responses (matching the previous client's behavior so existing try/catch and
// `err.status` checks keep working).
async function request(path, { method = 'GET', body, headers = {}, raw = false, timeoutMs = 0 } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'include' };
  const token = getToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }

  // Opt-in deadline. fetch has none of its own, so a request that never answers
  // leaves the caller waiting forever with its spinner up and no way to tell the
  // operator anything. Callers that want a bounded wait pass timeoutMs and get
  // an error they can name instead of silence.
  let timer = null;
  if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    opts.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } catch (cause) {
    // Distinguish "we gave up waiting" from "the network refused". Both arrive
    // here as a rejected fetch, and they need different words in front of an
    // operator.
    const timedOut = cause?.name === 'AbortError';
    const err = new Error(timedOut
      ? `The request timed out after ${Math.round(timeoutMs / 1000)} seconds`
      : 'Could not reach the server');
    err.status = 0;
    err.code = timedOut ? 'timeout' : 'network';
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code || null;
    err.data = data;
    throw err;
  }
  return raw ? { data, status: res.status } : data;
}

/* Multipart upload with real upload progress.
 *
 * fetch cannot report how much of a request body has gone out, and for a 100 MB
 * migration package that is most of the wait. XMLHttpRequest still can, so the
 * one call that needs it uses it rather than the whole client changing shape.
 * Errors are raised in exactly the form request() raises them, so callers
 * already written against { status, code, data } keep working.
 */
function upload(path, { body, timeoutMs = 0, onUploadProgress } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (message, status, code) => {
      const err = new Error(message);
      err.status = status;
      err.code = code;
      reject(err);
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`, true);
    xhr.withCredentials = true;
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (timeoutMs > 0) xhr.timeout = timeoutMs;

    if (typeof onUploadProgress === 'function' && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onUploadProgress({ loaded: event.loaded, total: event.total });
      };
      // The bytes are gone; everything after this is the server working.
      xhr.upload.onload = () => onUploadProgress({ loaded: 1, total: 1, uploaded: true });
    }

    xhr.ontimeout = () => fail(`The request timed out after ${Math.round(timeoutMs / 1000)} seconds`, 0, 'timeout');
    xhr.onerror = () => fail('Could not reach the server', 0, 'network');
    xhr.onload = () => {
      let data;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new Error(data?.error || data?.message || `Request failed (${xhr.status})`);
      err.status = xhr.status;
      err.code = data?.code || null;
      err.data = data;
      return reject(err);
    };

    xhr.send(body);
  });
}

const qs = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

// ── Entities ────────────────────────────────────────────────────────────────
function makeEntity(name) {
  const base = `/entities/${name}`;
  return {
    list: (sort = '-created_date', limit = 100, offset = 0) =>
      request(`${base}${qs({ sort, limit, offset })}`),
    filter: (filter = {}, sort = '-created_date', limit = null, offset = 0) =>
      request(`${base}/query`, { method: 'POST', body: { filter, sort, limit, offset } }),
    get: (id) => request(`${base}/${id}`),
    create: (obj) => request(base, { method: 'POST', body: obj }),
    bulkCreate: (arr) => request(base, { method: 'POST', body: arr }),
    update: (id, patch) => request(`${base}/${id}`, { method: 'PATCH', body: patch }),
    bulkUpdate: (arr) => request(`${base}/bulk-update`, { method: 'POST', body: arr }),
    updateMany: (filter, update) => request(`${base}/update-many`, { method: 'POST', body: { filter, update } }),
    delete: (id) => request(`${base}/${id}`, { method: 'DELETE' }),
    deleteMany: (filter) => request(`${base}/delete-many`, { method: 'POST', body: { filter } }),
    // Realtime was provided by the platform; emulate with polling so callers
    // that expect an unsubscribe function keep working. Returns () => void.
    subscribe: (callback, { interval = 15000, sort = '-created_date', limit = 100 } = {}) => {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try { const rows = await request(`${base}${qs({ sort, limit })}`); if (!stopped) callback(rows); } catch {}
      };
      const timer = setInterval(tick, interval);
      tick();
      return () => { stopped = true; clearInterval(timer); };
    },
  };
}

// Entities are created lazily by name; any entity the backend knows about works.
export const entities = new Proxy({}, {
  get: (cache, name) => {
    if (typeof name !== 'string') return undefined;
    if (!cache[name]) cache[name] = makeEntity(name);
    return cache[name];
  },
});

// Service-role accessor. On the hosted platform this bypassed row-level
// security; here the backend already scopes entity access by the authenticated
// user's role (admin/owner have full access), so distribution/operator helpers
// that expect a service-role `db` can use the same entity client.
export const asServiceRole = { entities };

// ── Auth ────────────────────────────────────────────────────────────────────
export const auth = {
  me: () => request('/auth/me'),
  isAuthenticated: () => !!getToken(),
  loginViaEmailPassword: async (email, password) => {
    const res = await request('/auth/login', { method: 'POST', body: { email, password } });
    if (res?.access_token) setToken(res.access_token);
    return res;
  },
  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  verifyOtp: async ({ email, otpCode }) => {
    const res = await request('/auth/verify-otp', { method: 'POST', body: { email, otpCode } });
    if (res?.access_token) setToken(res.access_token);
    return res;
  },
  resendOtp: (email) => request('/auth/resend-otp', { method: 'POST', body: { email } }),
  setToken: (token) => setToken(token),
  updateMe: (patch) => request('/auth/update-me', { method: 'POST', body: patch }),
  resetPasswordRequest: (email) => request('/auth/reset-password-request', { method: 'POST', body: { email } }),
  resetPassword: ({ resetToken, newPassword }) =>
    request('/auth/reset-password', { method: 'POST', body: { resetToken, newPassword } }),
  logout: async (redirectUrl) => {
    try { await request('/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    if (redirectUrl !== undefined) window.location.href = '/login';
  },
  redirectToLogin: () => { window.location.href = '/login'; },

  // Whether Google sign-in is switched on, and the Client ID needed to render
  // Google's button. The Client ID is public by design; no Google secret is
  // ever sent to the browser.
  googleConfig: () => request('/auth/google/config'),

  // Exchange a Google ID token for a DashFlo session. The token is verified
  // server-side against Google's signing keys; the browser is never trusted
  // for identity.
  loginWithGoogle: async ({ credential, nonce } = {}) => {
    const res = await request('/auth/google', { method: 'POST', body: { credential, nonce } });
    if (res?.access_token) setToken(res.access_token);
    return res;
  },

  // Kept for callers that ask for a provider by name.
  loginWithProvider: (provider) => {
    if (String(provider || '').toLowerCase() === 'google') {
      window.location.href = '/login';
      return;
    }
    window.location.href = `/login?oauth=${encodeURIComponent(provider || '')}&unavailable=1`;
  },
};

// ── Users (admin) ────────────────────────────────────────────────────────────
export const users = {
  // Invite a user by email; the backend emails a set-password link.
  inviteUser: (email, role = 'user') =>
    request('/auth/invite', { method: 'POST', body: { email, role } }),
};

// ── Functions ────────────────────────────────────────────────────────────────
// Returns { data, status } to match how callers consume function results.
async function invokeFunction(name, body = {}) {
  return request(`/functions/${name}`, { method: 'POST', body, raw: true });
}

export const functions = { invoke: invokeFunction };

// ── Integrations (Core) ──────────────────────────────────────────────────────
export const integrations = {
  Core: {
    InvokeLLM: (args) => request('/integrations/invoke-llm', { method: 'POST', body: args }),
    ExtractDataFromUploadedFile: (args) => request('/integrations/extract-file', { method: 'POST', body: args }),
    UploadFile: async ({ file }) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('/integrations/upload', { method: 'POST', body: fd });
    },
  },
};

export const api = { entities, asServiceRole, auth, users, functions, integrations, request, upload, getToken, setToken };
export default api;
