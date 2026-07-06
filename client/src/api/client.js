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
async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'include' };
  const token = getToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }

  const res = await fetch(`${API_BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return raw ? { data, status: res.status } : data;
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
  // OAuth is an optional add-on; without a configured provider, route to login.
  loginWithProvider: (provider) => {
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

export const api = { entities, auth, users, functions, integrations, request, getToken, setToken };
export default api;
