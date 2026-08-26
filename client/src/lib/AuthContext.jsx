import React, { createContext, useState, useContext, useEffect } from 'react';
import { api } from '@/api/client';
import { ROLE_PRESETS, sanitizePermissions } from '@/lib/permissions';

// Exported so tests can render an auth dependent component against a fixed
// user rather than standing a provider up and waiting for a network round trip.
// Application code uses useAuth or usePermissions, never this directly.
export const AuthContext = createContext();

// Resolve the effective permission map for a user record.
// Falls back to their base_role preset when no explicit permissions object is stored.
//
// A user with no base_role and role !== 'admin' resolves to 'unknown', the
// exact same fallback server/src/lib/entityPolicy.js's resolveRoleClass
// already uses for the identical shape (ROLE.UNKNOWN, fail-closed on every
// entity read/write). ROLE_PRESETS has no 'unknown' entry, so this
// deliberately yields an empty permission map rather than the 'manager'
// preset this used to fall back to: previously such an account could see
// and open every operator page (a real 'manager'-equivalent UI, including
// the full-page Delivery editor's Save/Rename/Duplicate/Archive controls)
// while every actual write already 403'd server-side - a page that looks
// editable and only fails after Save. Aligning the client to the server's
// existing fail-closed default, rather than loosening the server to match
// the client's old permissive one, matches this app's own stated invariant
// that entity access is deny-by-default (entityPolicy.js's own header).
// role='admin' via the legacy `role` field (pre-base_role accounts) is
// unaffected and still resolves to the real 'admin' preset, exactly as
// before - only the no-signal-at-all case changed.
//
// A linked_buyer_id/linked_supplier_id is checked BEFORE base_role, exactly
// matching entityPolicy.js's resolveRoleClass precedence server-side
// ("checked first so that a portal account which also carries an operator
// role cannot escape its scope"). Without this, a record carrying both an
// operator base_role and a linked party id (a misconfiguration, but one the
// server explicitly defends against) would render the full operator UI
// client-side while the server denies it as ROLE.PORTAL - the identical
// failure shape this whole fix exists to close, just a different trigger.
export function resolvePermissions(user) {
  if (!user) return { role: null, perms: {} };
  if (user.linked_buyer_id) return { role: 'buyer', perms: sanitizePermissions('buyer', { ...(ROLE_PRESETS.buyer?.permissions || {}) }) };
  if (user.linked_supplier_id) return { role: 'supplier', perms: sanitizePermissions('supplier', { ...(ROLE_PRESETS.supplier?.permissions || {}) }) };
  const legacyAdmin = !user.base_role && String(user.role || '').toLowerCase() === 'admin';
  const role = user.base_role || (legacyAdmin ? 'admin' : 'unknown');
  let perms = {};
  if (user.permissions) {
    try { perms = JSON.parse(user.permissions) || {}; } catch { perms = {}; }
  }
  if (!perms || Object.keys(perms).length === 0) {
    perms = { ...(ROLE_PRESETS[role]?.permissions || {}) };
  }
  return { role, perms: sanitizePermissions(role, perms) };
}

const PREVIEW_ROLE_KEY = 'legenex_preview_role';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [previewRole, setPreviewRoleState] = useState(() => {
    try { return localStorage.getItem(PREVIEW_ROLE_KEY) || null; } catch { return null; }
  });
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // { id, public_settings }

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);

      // Load public app settings (branding / registration status). No auth needed.
      try {
        const publicSettings = await api.request('/auth/public-settings');
        setAppPublicSettings(publicSettings);
        window.__DASHFLO_PUBLIC_SETTINGS__ = publicSettings?.public_settings || {};
      } catch {
        // Non-fatal: the app can still render the login screen.
        setAppPublicSettings({ id: 'dashos', public_settings: {} });
        window.__DASHFLO_PUBLIC_SETTINGS__ = {};
      }
      setIsLoadingPublicSettings(false);

      if (api.auth.isAuthenticated()) {
        await checkUserAuth();
      } else {
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        setAuthChecked(true);
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({ type: 'unknown', message: error.message || 'An unexpected error occurred' });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);
      const currentUser = await api.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    } catch (error) {
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      if (error.status === 401 || error.status === 403) {
        setAuthError({ type: 'auth_required', message: 'Authentication required' });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    if (shouldRedirect) api.auth.logout(window.location.href);
    else api.auth.logout();
  };

  const navigateToLogin = () => {
    api.auth.redirectToLogin(window.location.href);
  };

  // View-As: temporarily preview the app as another role (Owner/Admin only).
  const setPreviewRole = (role) => {
    setPreviewRoleState(role);
    try {
      if (role) localStorage.setItem(PREVIEW_ROLE_KEY, role);
      else localStorage.removeItem(PREVIEW_ROLE_KEY);
    } catch {}
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      previewRole,
      setPreviewRole,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    // Should never happen at runtime since App wraps everything in AuthProvider.
    // It can transiently occur during a Vite hot reload when the context module
    // is swapped out from under a stale render. Rather than crash the whole app,
    // return a safe loading-state shape so the tree re-renders cleanly once the
    // provider is re-established.
    return {
      user: null,
      isAuthenticated: false,
      isLoadingAuth: true,
      isLoadingPublicSettings: true,
      authError: null,
      appPublicSettings: null,
      authChecked: false,
      previewRole: null,
      setPreviewRole: () => {},
      logout: () => {},
      navigateToLogin: () => {},
      checkUserAuth: () => {},
      checkAppState: () => {},
    };
  }
  return context;
};

// Access control hook: returns the current user's role and a can(key) checker.
// Owner always passes. No user yet -> deny everything.
// When an Owner/Admin has a preview role active, can() is evaluated as that role.
export const usePermissions = () => {
  const { user, previewRole } = useAuth();
  const real = resolvePermissions(user);
  const canPreview = real.role === 'owner' || real.role === 'admin';
  const previewing = canPreview && previewRole && previewRole !== real.role;

  const preview = previewing
    ? { role: previewRole, perms: sanitizePermissions(previewRole, { ...(ROLE_PRESETS[previewRole]?.permissions || {}) }) }
    : null;

  const role = preview ? preview.role : real.role;
  const perms = preview ? preview.perms : real.perms;

  const can = (key) => {
    if (!user) return false;
    if (role === 'owner') return true;
    return !!perms[key];
  };
  return { role, perms, can, realRole: real.role, previewing: !!previewing, canPreview };
};
