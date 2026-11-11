import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, loadSession, saveSession, type User } from './api';

interface AuthState {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => loadSession()?.user ?? null);

  async function login(email: string, password: string) {
    const { data } = await api.post<{ accessToken: string; user: User }>('/auth/login', { email, password });
    saveSession({ token: data.accessToken, user: data.user });
    setUser(data.user);
  }

  function logout() {
    saveSession(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

/**
 * The role here only decides what the UI SHOWS. The real check is in the gateway:
 * a user who edits localStorage to role "admin" still gets 403, because the
 * role inside the signed JWT didn't change.
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
