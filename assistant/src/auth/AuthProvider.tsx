/** Crew login, client side (server: server/auth.ts, docs: docs/ACCOUNTS.md).
 *  - useAuth(): the logged-in crew member (or null), login by PIN / RFID, logout, and the login sheet (openLogin).
 *  - The session lives in the HttpOnly cookie `ju_session`; this code never sees the token, it asks GET /api/auth/me.
 *  - Shared terminals: logout after 30 min without touch / key / pointer activity (IDLE_MS), and when the server says
 *    the session is gone (checked on focus and every 5 min).
 *  - Protected data: when a request to /api/crew/* answers 401 while the "Statek" tab is open (crew layer), the login
 *    sheet opens by itself, once per visit of that tab. The evacuation tab never nags (it must work for everybody). */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type Role = 'captain' | 'bridge' | 'engine' | 'crew';
export interface User { id: number; name: string; rank: string; department: string; role: Role; method: 'pin' | 'rfid'; expiresAt: string }
export interface RosterMember { id: number; name: string; rank: string; department: string; role: Role }
/** why the sheet was opened (shown as a short line on top of it) */
export type LoginReason = 'manual' | 'crew' | 'alarm' | 'comms';
export type LoginError =
  | { code: 'bad-credentials'; left: number }
  | { code: 'locked' | 'rate'; retryAfter: number }
  | { code: 'unknown-card' | 'bad-request' | 'offline' | 'server' };
export type LoginResult = { ok: true; user: User } | { ok: false; error: LoginError };

export const IDLE_MS = 30 * 60_000;
const CHECK_MS = 5 * 60_000;
const TOKEN = (import.meta.env?.VITE_ASSISTANT_TOKEN as string | undefined) || '';
const headers = (json = false): Record<string, string> => ({
  accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...(TOKEN ? { 'x-assistant-token': TOKEN } : {}),
});

/** Captain has every bridge right. */
export const canCommandAlarms = (u: User | null | undefined) => !!u && (u.role === 'captain' || u.role === 'bridge');

interface Ctx {
  user: User | null;
  /** false until the first /api/auth/me answer */
  ready: boolean;
  loginPin(id: number, pin: string): Promise<LoginResult>;
  loginRfid(uid: string): Promise<LoginResult>;
  logout(): Promise<void>;
  fetchRoster(): Promise<{ members: RosterMember[]; live: boolean; rfid: boolean } | null>;
  sheet: { open: boolean; reason: LoginReason };
  openLogin(reason?: LoginReason): void;
  closeLogin(): void;
  /** set by logout(): 'idle' when it was the 30 min auto-logout (shown once in the header) */
  loggedOut: 'idle' | 'manual' | 'expired' | null;
}
const AuthContext = createContext<Ctx | null>(null);

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth() outside <AuthProvider>');
  return c;
}
/** Same as useAuth() but null outside the provider (components that also live outside the app shell). */
export function useAuthOptional(): Ctx | null { return useContext(AuthContext); }

async function postLogin(body: unknown): Promise<LoginResult> {
  let r: Response;
  try {
    r = await fetch('/api/auth/login', { method: 'POST', headers: headers(true), credentials: 'same-origin', body: JSON.stringify(body) });
  } catch { return { ok: false, error: { code: 'offline' } }; }
  let j: any = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (r.ok && j?.user) return { ok: true, user: j.user as User };
  const retryAfter = Number(j?.retryAfter ?? r.headers.get('retry-after')) || 60;
  if (r.status === 401 && j?.error === 'bad-credentials') return { ok: false, error: { code: 'bad-credentials', left: Number(j.left) || 0 } };
  if (r.status === 401 && j?.error === 'unknown-card') return { ok: false, error: { code: 'unknown-card' } };
  if (r.status === 429) return { ok: false, error: { code: j?.error === 'locked' ? 'locked' : 'rate', retryAfter } };
  if (r.status === 400) return { ok: false, error: { code: 'bad-request' } };
  return { ok: false, error: { code: 'server' } };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; reason: LoginReason }>({ open: false, reason: 'manual' });
  const [loggedOut, setLoggedOut] = useState<Ctx['loggedOut']>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const lastActive = useRef(Date.now());

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { headers: headers(), credentials: 'same-origin' });
      if (!r.ok) return;
      const j = (await r.json()) as { user: User | null };
      if (userRef.current && !j.user) setLoggedOut('expired');
      setUser(j.user ?? null);
    } catch { /* offline: keep what we have */ } finally { setReady(true); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const accept = useCallback((r: LoginResult) => {
    if (r.ok) {
      setUser(r.user);
      setLoggedOut(null);
      lastActive.current = Date.now();
      setSheet((s) => ({ ...s, open: false }));
    }
    return r;
  }, []);

  const logout = useCallback(async (why: 'manual' | 'idle' = 'manual') => {
    setUser(null);
    setLoggedOut(why);
    try { await fetch('/api/auth/logout', { method: 'POST', headers: headers(true), credentials: 'same-origin', body: '{}' }); } catch { /* cookie expires anyway */ }
  }, []);

  // idle auto-logout on shared terminals + session check on focus / every 5 min
  useEffect(() => {
    if (!user) return;
    const touch = () => { lastActive.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const e of evs) addEventListener(e, touch, { passive: true, capture: true });
    const tick = window.setInterval(() => {
      if (Date.now() - lastActive.current >= IDLE_MS) void logout('idle');
      else if (Date.parse(user.expiresAt) <= Date.now()) void refresh();
    }, 15_000);
    const check = window.setInterval(() => { void refresh(); }, CHECK_MS);
    const vis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', vis);
    return () => {
      for (const e of evs) removeEventListener(e, touch, { capture: true });
      clearInterval(tick); clearInterval(check);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [user, logout, refresh]);

  // crew layer of the ship view asked for data without a session: offer the login (once per visit of #statek)
  const nagged = useRef(false);
  useEffect(() => {
    const onHash = () => { if (location.hash !== '#statek') nagged.current = false; };
    addEventListener('hashchange', onHash);
    const orig = window.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const res = await orig(input, init);
      try {
        if (res.status === 401 && !userRef.current && !nagged.current && location.hash === '#statek') {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url, location.href).pathname.startsWith('/api/crew')) {
            nagged.current = true;
            setSheet({ open: true, reason: 'crew' });
          }
        }
      } catch { /* never break the request */ }
      return res;
    };
    window.fetch = wrapped;
    return () => { if (window.fetch === wrapped) window.fetch = orig; removeEventListener('hashchange', onHash); };
  }, []);

  const value = useMemo<Ctx>(() => ({
    user, ready, sheet, loggedOut,
    loginPin: async (id, pin) => accept(await postLogin({ method: 'pin', id, pin })),
    loginRfid: async (uid) => accept(await postLogin({ method: 'rfid', uid })),
    logout: () => logout('manual'),
    async fetchRoster() {
      try {
        const r = await fetch('/api/auth/roster', { headers: headers(), credentials: 'same-origin' });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    },
    openLogin: (reason = 'manual') => { if (!userRef.current) setSheet({ open: true, reason }); },
    closeLogin: () => setSheet((s) => ({ ...s, open: false })),
  }), [user, ready, sheet, loggedOut, accept, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
