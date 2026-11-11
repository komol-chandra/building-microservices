import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, loadSession, saveSession, type User } from './api';

interface AuthState {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => loadSession()?.user ?? null);

  function start(data: { accessToken: string; user: User }) {
    saveSession({ token: data.accessToken, user: data.user });
    setUser(data.user);
  }

  async function login(email: string, password: string) {
    start((await api.post('/auth/login', { email, password })).data);
  }

  // auth-service creates the account AND returns a token, so the user is logged in right away.
  async function register(name: string, email: string, password: string) {
    start((await api.post('/auth/register', { name, email, password })).data);
  }

  function logout() {
    saveSession(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, register, logout }}>{children}</AuthContext.Provider>;
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
