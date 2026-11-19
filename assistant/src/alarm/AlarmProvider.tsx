/** Alarm system client: one WebSocket per terminal to the assistant server (the "centrala", server/alarms.ts).
 *  Terminal identity: the SAME localStorage entry as the crew video chat (`crew-terminal`: name, crew DB terminal
 *  code, room code), so a terminal has one name everywhere; the alarm-only part (role, zone, generated id for
 *  terminals without a crew DB code) lives in `alarm-terminal`. An unconfigured browser still connects as a crew
 *  terminal with a generated name, so every screen on board shows an alarm.
 *  Reconnects with backoff (1 s .. 15 s); the server sends a full state snapshot on every (re)connect. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CREW_ROOM_PLACES } from '../../shared/crew-map';
import {
  NAME_MAX, TERMINAL_ID_RE, isTerminalZone,
  type Alarm, type AlarmErrorCode, type AlarmKind, type AlarmState, type AlarmZone, type BlockedStair, type ClientMsg,
  type ServerMsg, type TerminalRole, type TerminalZone,
} from '../../shared/alarms';

const LS_CREW = 'crew-terminal'; // shared with src/crew/CrewVideoChat.tsx: { name, terminal?, place? }
const LS_ALARM = 'alarm-terminal'; // { id, role, zone }

export interface TerminalIdentity {
  terminalId: string;
  name: string;
  role: TerminalRole;
  zone: TerminalZone | null;
  /** crew DB terminal code (T-D4-01-A) and room code (D4-01), when the terminal is one from the database */
  terminal?: string;
  place?: string;
}
export type Conn = 'connecting' | 'online' | 'offline';
export interface RaiseInput { kind: AlarmKind; zone: AlarmZone | null; blocked: BlockedStair | null; message: string; drill: boolean; confirm?: boolean }

interface Ctx {
  conn: Conn;
  identity: TerminalIdentity;
  /** true when the name was generated (terminal never configured) */
  defaultName: boolean;
  state: AlarmState | null;
  active: Alarm | null;
  /** this terminal acknowledged the active alarm */
  acked: boolean;
  log: Alarm[];
  lastError: { code: AlarmErrorCode; message: string; at: number } | null;
  /** server clock minus local clock (ms), for elapsed times */
  skew: number;
  setIdentity(next: Pick<TerminalIdentity, 'name' | 'role' | 'zone'>): void;
  raise(a: RaiseInput): boolean;
  ack(extra?: { user?: string; headcount?: number }): boolean;
  end(): boolean;
  refreshLog(): void;
}
const AlarmContext = createContext<Ctx | null>(null);

export function useAlarms(): Ctx {
  const c = useContext(AlarmContext);
  if (!c) throw new Error('useAlarms() outside <AlarmProvider>');
  return c;
}

function randomId() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return 'W-' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function read<T>(key: string): Partial<T> | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as Partial<T>) : null; } catch { return null; }
}
function write(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

function loadIdentity(): { id: TerminalIdentity; generated: boolean } {
  const crew = read<{ name: string; terminal: string; place: string }>(LS_CREW);
  const own = read<{ id: string; role: TerminalRole; zone: TerminalZone | null }>(LS_ALARM) ?? {};
  let ownId = typeof own.id === 'string' && TERMINAL_ID_RE.test(own.id) ? own.id : '';
  if (!ownId) { ownId = randomId(); write(LS_ALARM, { ...own, id: ownId }); }
  const terminal = typeof crew?.terminal === 'string' && TERMINAL_ID_RE.test(crew.terminal) ? crew.terminal : undefined;
  const place = typeof crew?.place === 'string' ? crew.place : undefined;
  const crewName = typeof crew?.name === 'string' ? crew.name.trim().slice(0, NAME_MAX) : '';
  const placeZone = place && CREW_ROOM_PLACES[place] ? CREW_ROOM_PLACES[place].zone : null;
  return {
    id: {
      terminalId: terminal ?? ownId,
      name: crewName.length >= 2 ? crewName : `Terminal ${ownId.slice(2, 6)}`,
      role: own.role === 'bridge' ? 'bridge' : 'crew',
      zone: isTerminalZone(own.zone) ? own.zone : placeZone,
      terminal, place,
    },
    generated: crewName.length < 2,
  };
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/alarms/ws`;

export function AlarmProvider({ children, url }: { children: ReactNode; url?: string }) {
  const [{ id: identity, generated }, setIdent] = useState(loadIdentity);
  const [conn, setConn] = useState<Conn>('connecting');
  const [state, setState] = useState<AlarmState | null>(null);
  const [log, setLog] = useState<Alarm[]>([]);
  const [lastError, setLastError] = useState<Ctx['lastError']>(null);
  const [skew, setSkew] = useState(0);
  const sock = useRef<WebSocket | null>(null);
  const lastActiveId = useRef<string | null>(null);

  const refreshLog = useCallback(() => {
    fetch('/api/alarms/log?limit=200', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { alarms?: Alarm[] } | null) => { if (d && Array.isArray(d.alarms)) setLog(d.alarms); })
      .catch(() => { /* offline: keep the old log */ });
  }, []);

  // one connection per identity; reconnect with backoff
  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer = 0;
    let ping = 0;
    const open = () => {
      if (stopped) return;
      setConn('connecting');
      let ws: WebSocket;
      try { ws = new WebSocket(url ?? wsUrl()); } catch { schedule(); return; }
      sock.current = ws;
      ws.onopen = () => {
        retry = 0;
        const hello: ClientMsg = { type: 'hello', terminalId: identity.terminalId, name: identity.name, role: identity.role,
          zone: identity.zone, place: identity.place ?? null };
        ws.send(JSON.stringify(hello));
        clearInterval(ping);
        // app-level keepalive: proxies drop idle sockets; the server also pings
        ping = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20_000);
      };
      ws.onmessage = (e) => {
        let m: ServerMsg;
        try { m = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
        if (m.type === 'welcome' || m.type === 'state') {
          setState(m.state);
          setSkew(Date.parse(m.state.now) - Date.now());
          if (m.type === 'welcome') setConn('online');
          const id = m.state.active?.id ?? null;
          if (m.type === 'welcome' || id !== lastActiveId.current || (m.type === 'state' && m.reason === 'ended')) refreshLog();
          lastActiveId.current = id;
        } else if (m.type === 'pong') setSkew(Date.parse(m.now) - Date.now());
        else if (m.type === 'error') setLastError({ code: m.code, message: m.message, at: Date.now() });
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (sock.current === ws) sock.current = null;
        if (!stopped) { setConn('offline'); schedule(); }
      };
      ws.onerror = () => { /* onclose follows */ };
    };
    const schedule = () => {
      clearTimeout(timer);
      const wait = Math.min(15_000, 1000 * 2 ** retry++) * (0.8 + Math.random() * 0.4);
      timer = window.setTimeout(open, wait);
    };
    // reconnect at once when the device wakes up / gets the network back
    const wake = () => { if (!sock.current && !stopped) { clearTimeout(timer); retry = 0; open(); } };
    addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      const ws = sock.current;
      sock.current = null;
      ws?.close();
    };
  }, [identity, url, refreshLog]);

  const sendMsg = useCallback((m: ClientMsg) => {
    const ws = sock.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLastError({ code: 'unknown', message: 'offline', at: Date.now() });
      return false;
    }
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  const active = state?.active ?? null;
  const acked = !!active && !!active.acks[identity.terminalId];

  const value = useMemo<Ctx>(() => ({
    conn, identity, defaultName: generated, state, active, acked, log, lastError, skew,
    setIdentity(next) {
      const name = next.name.trim().slice(0, NAME_MAX);
      const crew = read<{ name: string; terminal: string; place: string }>(LS_CREW) ?? {};
      // the shared entry keeps its terminal / place; only the name changes
      write(LS_CREW, { ...crew, name });
      const own = read<{ id: string }>(LS_ALARM) ?? {};
      write(LS_ALARM, { ...own, role: next.role, zone: next.zone });
      setIdent(loadIdentity());
    },
    raise: (a) => sendMsg({ type: 'raise', ...a }),
    ack: (extra) => (active ? sendMsg({ type: 'ack', alarmId: active.id, ...extra }) : false),
    end: () => (active ? sendMsg({ type: 'end', alarmId: active.id }) : false),
    refreshLog,
  }), [conn, identity, generated, state, active, acked, log, lastError, skew, sendMsg, refreshLog]);

  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

/** Seconds since an ISO time, ticking once a second (server-clock corrected). */
export function useElapsed(since: string | null | undefined, skew: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.max(0, (now + skew - Date.parse(since)) / 1000) : 0;
}
