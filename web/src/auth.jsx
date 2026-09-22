import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => logout();
    window.addEventListener('eng1300:unauthorized', onUnauthorized);
    return () => window.removeEventListener('eng1300:unauthorized', onUnauthorized);
  }, [logout]);

  // 刷新页面后用已存的 token 换回身份
  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    let cancelled = false;
    get('/me')
      .then((r) => { if (!cancelled) setUser(r.user); })
      .catch(() => { if (!cancelled) setToken(null); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await post('/auth/login', { username, password });
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }, []);

  return (
    <AuthContext.Provider value={{ user, ready, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
