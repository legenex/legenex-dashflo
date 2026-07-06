import React, { createContext, useState, useContext, useEffect } from 'react';
import { api } from '@/api/client';
import { ROLE_PRESETS, sanitizePermissions } from '@/lib/permissions';

const AuthContext = createContext();

// Resolve the effective permission map for a user record.
// Falls back to their base_role preset when no explicit permissions object is stored.
export function resolvePermissions(user) {
  if (!user) return { role: null, perms: {} };
  const role = user.base_role || (user.role === 'admin' ? 'admin' : 'manager');
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
      } catch {
        // Non-fatal: the app can still render the login screen.
        setAppPublicSettings({ id: 'dashos', public_settings: {} });
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
    throw new Error('useAuth must be used within an AuthProvider');
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
