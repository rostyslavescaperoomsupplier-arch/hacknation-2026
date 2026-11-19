/**
 * Crew accounts + login (closes adversarial finding #2 and the "role chosen on the terminal" alarm issue).
 * Node built-ins only. Polish description for the crew: docs/ACCOUNTS.md.
 *
 * Accounts = every crew member of the crew database (GET <CREW_API>/api/crew: id, name, rank, department, rfid_uid).
 * The roster is cached in AUTH_DIR/accounts.json, so login keeps working while the crew DB is down. Role by rank:
 *   'captain' (Kapitan) ⊃ 'bridge' (Starszy oficer, II/III oficer, Oficer radiowy / GMDSS, any "oficer")
 *   'engine' (mechanicy, elektryk), 'crew' (everybody else).
 * Login: (a) RFID UID from a USB reader (keyboard wedge) or typed, normalised to hex (decimal readers handled too);
 *        (b) person + PIN (4-6 digits). PINs are generated (6 digits) for every member on first sync, stored only as
 *        scrypt hashes in accounts.json; the plaintext goes once to AUTH_DIR/demo-pins.txt (chmod 600) for the demo.
 *        ACCOUNTS_DEMO_PIN=<4-6 digits> makes that one PIN valid for everybody (dev / tests only, logged loudly).
 *        AUTH_TEST_MODE=1: test mode for demos, pick a person and log in WITHOUT a PIN ({ method: 'test', id });
 *        the roster says testMode: true so the login sheet skips the PIN pad. Every such login is logged.
 *        Per-IP bucket (AUTH_RATE_PER_MIN, default 10 / min) on every login; 5 wrong PINs for one person lock that
 *        person for 15 min (AUTH_LOCK_MS).
 * Sessions: 32 random bytes in cookie `ju_session` (HttpOnly, SameSite=Strict, Path=/, Max-Age 12 h, Secure when the
 *        request came over https). Server side only the SHA-256 of the token is kept (memory + AUTH_DIR/sessions.json).
 *   POST /api/auth/login   { method: 'pin', id, pin } | { method: 'rfid', uid }  -> { user }  (+ Set-Cookie)
 *        401 { error: 'bad-credentials', left? } | 401 { error: 'unknown-card' } | 429 { error: 'locked'|'rate limited', retryAfter }
 *   POST /api/auth/logout  -> { ok: true } (cookie cleared, session deleted)
 *   GET  /api/auth/me      -> { user: User | null }
 *   GET  /api/auth/roster  -> { members: { id, name, rank, department, role }[], live, rfid }  (person picker; no locations)
 * Exports for other modules: getSession(req), requireRole(req, res, roles), hasRole(role, roles), currentSession()
 * (the session of the HTTP request being handled, via AsyncLocalStorage), attachAuth(server).
 *
 * attachAuth(server) takes over the server's 'request' event (same trick as attachAlarms for 'upgrade'): it serves
 * /api/auth/* and runs every other request inside an AsyncLocalStorage context holding the request, so the crew chat
 * tools (crew.ts, setCrewAccessCheck) can tell whether the chat user is logged in without touching claude.ts.
 * attachAlarms() calls it, so index.ts needs no extra line; calling it again is a no-op.
 *
 * CLI (on the server, as the service user):  node --experimental-strip-types server/auth.ts list | reset <id|all> [pin]
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CREW_API, crewEnabled, setCrewAccessCheck, setCrewRequestCheck } from './crew.ts';
import { clientIp, corsOrigin, originAllowed, tokenOk } from './guard.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const envNum = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

// tests never write into server/data unless they ask for it
export const AUTH_DIR = process.env.AUTH_DIR
  || (process.env.NODE_ENV === 'test' ? mkdtempSync(path.join(tmpdir(), 'ju-auth-')) : path.join(here, 'data'));
const ACCOUNTS_FILE = path.join(AUTH_DIR, 'accounts.json');
const PINS_FILE = path.join(AUTH_DIR, 'demo-pins.txt');
const SESSIONS_FILE = path.join(AUTH_DIR, 'sessions.json');

export const COOKIE = 'ju_session';
const SESSION_MS = envNum('AUTH_SESSION_MS', 12 * 3600_000);
const LOCK_MS = envNum('AUTH_LOCK_MS', 15 * 60_000);
const MAX_FAILS = envNum('AUTH_MAX_FAILS', 5);
const LOGIN_RATE = { cap: envNum('AUTH_RATE_PER_MIN', 10), perSec: envNum('AUTH_RATE_PER_MIN', 10) / 60 };
const READ_RATE = { cap: 60, perSec: 1 };
const ROSTER_TTL_MS = envNum('AUTH_ROSTER_TTL_MS', 60_000);
const MAX_SESSIONS = 5000;
const PIN_RE = /^\d{4,6}$/;
/** demo / test mode: log in by choosing a person, no PIN */
export const TEST_MODE = /^(1|true|yes|on)$/i.test((process.env.AUTH_TEST_MODE ?? '').trim());
const DEMO_PIN = (() => {
  const v = (process.env.ACCOUNTS_DEMO_PIN ?? '').trim();
  if (!v) return null;
  if (!PIN_RE.test(v)) { console.error('[auth] ACCOUNTS_DEMO_PIN must be 4-6 digits; ignored'); return null; }
  return v;
})();

// ---------- roles ----------
export type Role = 'captain' | 'bridge' | 'engine' | 'crew';
export const ROLES: Role[] = ['captain', 'bridge', 'engine', 'crew'];
const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().trim();

/** Kapitan -> captain; any "oficer" (Starszy oficer, II/III oficer, Oficer radiowy, GMDSS) -> bridge;
 *  "mechanik" / "elektryk" -> engine; everybody else (incl. Kadet, Bosman, Szef kuchni, Lekarz) -> crew. */
export function roleForRank(rank: string): Role {
  const r = fold(rank);
  if (r === 'kapitan' || r === 'kapitan statku' || r === 'master') return 'captain';
  if (/\boficer\b|gmdss|radiooficer/.test(r)) return 'bridge';
  if (/mechanik|elektryk|elektromechanik/.test(r)) return 'engine';
  return 'crew';
}
/** Captain has every bridge permission. */
export function hasRole(role: Role | null | undefined, wanted: readonly Role[]): boolean {
  if (!role) return false;
  return wanted.includes(role) || (role === 'captain' && wanted.includes('bridge'));
}

// ---------- accounts ----------
export interface Member {
  id: number;
  name: string;
  rank: string;
  department: string;
  role: Role;
  /** UID as upper-case hex without separators, or null (no tag issued) */
  rfid: string | null;
  rfidType: 'karta' | 'opaska' | null;
}
interface PinHash { salt: string; hash: string; setAt: string }
interface AccountsFile { version: 1; syncedAt: string | null; members: Member[]; pins: Record<string, PinHash> }

let members: Member[] = [];
let pins: Record<string, PinHash> = {};
let syncedAt: string | null = null;
let accountsMtime = 0;
let lastSync = 0;
let syncing: Promise<void> | null = null;
let liveRoster = false;

/** "04:A3:1F-5b c2" -> "04A31F5BC2"; null when nothing hex-like is left. */
export function normalizeUid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.toUpperCase().replace(/^0X/, '').replace(/[^0-9A-F]/g, '');
  return hex.length >= 8 && hex.length <= 20 ? hex : null;
}

function writeSecret(file: string, data: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not ours */ }
}

function loadAccounts() {
  try {
    const st = statSync(ACCOUNTS_FILE);
    if (st.mtimeMs === accountsMtime) return;
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) as Partial<AccountsFile>;
    members = Array.isArray(data.members) ? data.members.filter((m) => m && Number.isInteger(m.id) && typeof m.name === 'string')
      .map((m) => ({ ...m, role: roleForRank(m.rank), rfid: normalizeUid(m.rfid ?? '') })) : [];
    pins = data.pins && typeof data.pins === 'object' ? data.pins : {};
    syncedAt = data.syncedAt ?? null;
    accountsMtime = st.mtimeMs;
  } catch { /* no file yet */ }
}
function saveAccounts() {
  const data: AccountsFile = { version: 1, syncedAt, members, pins };
  writeSecret(ACCOUNTS_FILE, JSON.stringify(data, null, 1));
  try { accountsMtime = statSync(ACCOUNTS_FILE).mtimeMs; } catch { /* gone */ }
}

const scrypt = (pin: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  scryptCb(pin, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));

async function hashPin(pin: string): Promise<PinHash> {
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await scrypt(pin, salt)).toString('base64'), setAt: new Date().toISOString() };
}
async function pinMatches(id: number, pin: string): Promise<boolean> {
  if (DEMO_PIN) {
    const a = Buffer.from(pin), b = Buffer.from(DEMO_PIN);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const h = pins[String(id)];
  // still burn the scrypt time for an unknown id, so timing does not tell which ids have a PIN
  const salt = h ? Buffer.from(h.salt, 'base64') : randomBytes(16);
  const got = await scrypt(pin, salt);
  if (!h) return false;
  const want = Buffer.from(h.hash, 'base64');
  return want.length === got.length && timingSafeEqual(want, got);
}
const newPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

function appendPins(rows: { m: Member; pin: string }[], note: string) {
  if (!rows.length) return;
  const head = existsSync(PINS_FILE) ? '' : '# Jantar Unity: PIN-y demonstracyjne (jednorazowa lista). Rozdaj i USUN ten plik.\n'
    + '# id\timie i nazwisko\tstopien\tPIN\n';
  mkdirSync(path.dirname(PINS_FILE), { recursive: true, mode: 0o700 });
  appendFileSync(PINS_FILE, head + `# ${note} ${new Date().toISOString()}\n`
    + rows.map(({ m, pin }) => `${m.id}\t${m.name}\t${m.rank}\t${pin}`).join('\n') + '\n', { mode: 0o600 });
  try { chmodSync(PINS_FILE, 0o600); } catch { /* not ours */ }
}

/** Fetch the crew list (own request, not crewGet's cache: the roster needs rfid_uid, which the proxy never shows). */
async function fetchCrew(): Promise<Member[] | null> {
  if (!crewEnabled) return null;
  try {
    const r = await fetch(CREW_API + '/api/crew', { signal: AbortSignal.timeout(2000), headers: { accept: 'application/json' } });
    if (!r.ok) { await r.arrayBuffer().catch(() => {}); return null; }
    const rows = await r.json() as any[];
    if (!Array.isArray(rows)) return null;
    const out: Member[] = [];
    for (const c of rows) {
      const id = Number(c?.id);
      const name = String(c?.name ?? [c?.first_name, c?.last_name].filter(Boolean).join(' ')).trim();
      if (!Number.isInteger(id) || id <= 0 || !name) continue;
      const rank = String(c.rank ?? '').trim();
      out.push({
        id, name, rank, department: String(c.department ?? '').trim(), role: roleForRank(rank),
        rfid: normalizeUid(c.rfid_uid ?? ''), rfidType: c.rfid_type === 'karta' || c.rfid_type === 'opaska' ? c.rfid_type : null,
      });
    }
    return out;
  } catch { return null; }
}

/** Refresh the roster from the crew DB (at most once per ROSTER_TTL_MS unless forced); new members get a PIN. */
export async function syncRoster(force = false): Promise<void> {
  loadAccounts();
  if (!force && Date.now() - lastSync < ROSTER_TTL_MS) return;
  if (syncing) return syncing;
  syncing = (async () => {
    const live = await fetchCrew();
    lastSync = Date.now();
    liveRoster = !!live;
    if (!live) return;
    const before = JSON.stringify(members);
    members = live;
    const ids = new Set(live.map((m) => String(m.id)));
    // people who left the crew DB lose their sessions (their PIN hash is kept in case they come back)
    for (const [k, s] of sessions) if (!ids.has(String(s.accountId))) sessions.delete(k);
    const fresh: { m: Member; pin: string }[] = [];
    if (!DEMO_PIN) {
      const todo = live.filter((m) => !pins[String(m.id)]).map((m) => ({ m, pin: newPin() }));
      const hashes = await Promise.all(todo.map((x) => hashPin(x.pin)));
      todo.forEach((x, i) => { pins[String(x.m.id)] = hashes[i]; fresh.push(x); });
    }
    if (fresh.length || JSON.stringify(members) !== before || !syncedAt) {
      syncedAt = new Date().toISOString();
      saveAccounts();
    }
    if (fresh.length) {
      appendPins(fresh, `wygenerowane dla ${fresh.length} os.`);
      console.log(`[auth] generated PINs for ${fresh.length} crew member(s); plaintext once in ${PINS_FILE}`);
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

const memberById = (id: number) => members.find((m) => m.id === id) ?? null;

/** decimal output of some readers: the same number as hex, both byte orders (4/7-byte UIDs) */
function uidCandidates(raw: string): string[] {
  const out = new Set<string>();
  const hex = normalizeUid(raw);
  if (hex) out.add(hex);
  const digits = raw.trim();
  if (/^\d{6,20}$/.test(digits)) {
    let h = BigInt(digits).toString(16).toUpperCase();
    if (h.length % 2) h = '0' + h;
    for (const len of [8, 14, 20]) if (h.length <= len) {
      const p = h.padStart(len, '0');
      out.add(p);
      out.add(p.match(/../g)!.reverse().join(''));
    }
  }
  return [...out];
}
function memberByUid(raw: string): Member | null {
  const c = uidCandidates(raw);
  return members.find((m) => m.rfid && c.includes(m.rfid)) ?? null;
}

// ---------- sessions ----------
export interface Session {
  accountId: number;
  name: string;
  rank: string;
  department: string;
  role: Role;
  method: 'pin' | 'rfid' | 'test';
  createdAt: string;
  expiresAt: string;
}
export interface User { id: number; name: string; rank: string; department: string; role: Role; method: 'pin' | 'rfid' | 'test'; expiresAt: string }
export const publicUser = (s: Session): User =>
  ({ id: s.accountId, name: s.name, rank: s.rank, department: s.department, role: s.role, method: s.method, expiresAt: s.expiresAt });

/** key = SHA-256(token) in hex; the token itself is never stored */
const sessions = new Map<string, Session>();
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as { sessions?: [string, Session][] };
    const now = Date.now();
    for (const [k, s] of data.sessions ?? []) if (typeof k === 'string' && s && Date.parse(s.expiresAt) > now) sessions.set(k, s);
  } catch { /* none */ }
}
let saveTimer: NodeJS.Timeout | null = null;
function saveSessionsNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { writeSecret(SESSIONS_FILE, JSON.stringify({ version: 1, sessions: [...sessions] })); }
  catch (e) { console.error('[auth] session save failed:', e instanceof Error ? e.message : e); }
}
function saveSessions() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveSessionsNow, 300);
  saveTimer.unref();
}
export function flushAuth() { if (saveTimer) saveSessionsNow(); }

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of sessions) if (Date.parse(s.expiresAt) <= now) { sessions.delete(k); changed = true; }
  while (sessions.size > MAX_SESSIONS) { sessions.delete(sessions.keys().next().value as string); changed = true; }
  if (changed) saveSessions();
}

function createSession(m: Member, method: Session['method']): { token: string; session: Session } {
  pruneSessions();
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const session: Session = {
    accountId: m.id, name: m.name, rank: m.rank, department: m.department, role: m.role, method,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(),
  };
  sessions.set(tokenHash(token), session);
  saveSessions();
  return { token, session };
}

function cookieToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** The logged-in crew member of this request (cookie `ju_session`), or null. Works for HTTP and WebSocket upgrades. */
export function getSession(req: Pick<IncomingMessage, 'headers'> | null | undefined): Session | null {
  if (!req) return null;
  const t = cookieToken(req);
  if (!t) return null;
  const k = tokenHash(t);
  const s = sessions.get(k);
  if (!s) return null;
  if (Date.parse(s.expiresAt) <= Date.now()) { sessions.delete(k); saveSessions(); return null; }
  return s;
}

/** Sends 401 (no session) / 403 (role not allowed) itself and returns null; otherwise the session. */
export function requireRole(req: IncomingMessage, res: ServerResponse, roles: readonly Role[]): Session | null {
  const s = getSession(req);
  if (!s) { sendJson(res, 401, { error: 'login required' }); return null; }
  if (!hasRole(s.role, roles)) { sendJson(res, 403, { error: 'forbidden' }); return null; }
  return s;
}

// ---------- request context (crew chat tools) ----------
const als = new AsyncLocalStorage<{ req: IncomingMessage }>();
/** Run fn with req as "the current request" (attachAuth does this for every request). */
export function runWithRequest<T>(req: IncomingMessage, fn: () => T): T { return als.run({ req }, fn); }
/** Session of the HTTP request being handled right now (AsyncLocalStorage), or null. */
export function currentSession(): Session | null { return getSession(als.getStore()?.req ?? null); }

// the crew proxy and the crew chat tools are closed (crew.ts default) until these are registered
setCrewRequestCheck((req) => !!getSession(req));
setCrewAccessCheck(() => !!currentSession());

// ---------- rate limit + lockout ----------
type Bucket = { tokens: number; last: number };
const ipBuckets = new Map<string, Bucket>();
function take(key: string, rate: { cap: number; perSec: number }): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  let b = ipBuckets.get(key);
  if (!b) {
    if (ipBuckets.size > 20_000) ipBuckets.clear();
    ipBuckets.set(key, b = { tokens: rate.cap, last: now });
  }
  b.tokens = Math.min(rate.cap, b.tokens + ((now - b.last) / 1000) * rate.perSec);
  b.last = now;
  if (b.tokens < 1) return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate.perSec)) };
  b.tokens -= 1;
  return { ok: true };
}
const fails = new Map<number, { n: number; lockedUntil: number }>();
const lockLeft = (id: number) => Math.max(0, (fails.get(id)?.lockedUntil ?? 0) - Date.now());

/** For tests. */
export function resetAuthLimits() { ipBuckets.clear(); fails.clear(); }

// ---------- HTTP ----------
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isHttps(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const xf = req.headers['x-forwarded-proto'];
  return LOOPBACK.has(req.socket.remoteAddress || '') && String(Array.isArray(xf) ? xf[0] : xf ?? '').split(',')[0].trim() === 'https';
}
function cookie(req: IncomingMessage, value: string, maxAgeSec: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

function readBody(req: IncomingMessage, max = 2048): Promise<string | null> {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => { if (over) return; data += c; if (data.length > max) { over = true; data = ''; } });
    req.on('end', () => resolve(over ? null : data));
    req.on('error', () => resolve(null));
  });
}

async function login(req: IncomingMessage, res: ServerResponse) {
  const ip = clientIp(req);
  const rate = take('l:' + ip, LOGIN_RATE);
  if (!rate.ok) return sendJson(res, 429, { error: 'rate limited', retryAfter: rate.retryAfter }, { 'retry-after': String(rate.retryAfter) });
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return sendJson(res, 415, { error: 'json only' });
  const raw = await readBody(req);
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* bad */ }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad request' });
  await syncRoster();

  let m: Member | null = null;
  let method: Session['method'];
  if (body.method === 'pin') {
    method = 'pin';
    const id = Number(body.id);
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (!Number.isInteger(id) || id <= 0 || !PIN_RE.test(pin)) return sendJson(res, 400, { error: 'bad request' });
    const locked = lockLeft(id);
    if (locked > 0) {
      const s = Math.ceil(locked / 1000);
      return sendJson(res, 429, { error: 'locked', retryAfter: s }, { 'retry-after': String(s) });
    }
    const cand = memberById(id);
    const ok = await pinMatches(id, pin);
    if (!cand || !ok) {
      const f = fails.get(id) ?? { n: 0, lockedUntil: 0 };
      f.n++;
      if (f.n >= MAX_FAILS) { f.n = 0; f.lockedUntil = Date.now() + LOCK_MS; }
      if (fails.size > 10_000) fails.clear();
      fails.set(id, f);
      console.warn(`[auth] bad PIN for id ${id} from ${ip}${f.lockedUntil > Date.now() ? ' -> LOCKED' : ''}`);
      if (f.lockedUntil > Date.now()) {
        const s = Math.ceil(LOCK_MS / 1000);
        return sendJson(res, 429, { error: 'locked', retryAfter: s }, { 'retry-after': String(s) });
      }
      return sendJson(res, 401, { error: 'bad-credentials', left: MAX_FAILS - f.n });
    }
    fails.delete(id);
    m = cand;
  } else if (body.method === 'rfid') {
    method = 'rfid';
    const uid = typeof body.uid === 'string' ? body.uid.slice(0, 64) : '';
    if (!normalizeUid(uid) && !/^\d{6,20}$/.test(uid.trim())) return sendJson(res, 400, { error: 'bad request' });
    m = memberByUid(uid);
    if (!m) { console.warn(`[auth] unknown card from ${ip}`); return sendJson(res, 401, { error: 'unknown-card' }); }
  } else if (body.method === 'test' && TEST_MODE) {
    method = 'test';
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'bad request' });
    m = memberById(id);
    if (!m) return sendJson(res, 401, { error: 'bad-credentials', left: MAX_FAILS });
    console.warn(`[auth] TEST MODE login without PIN: ${m.name} (${m.role}) from ${ip}`);
  } else return sendJson(res, 400, { error: 'bad request' });

  const { token, session } = createSession(m, method);
  console.log(`[auth] login ${m.name} (${m.role}) by ${method} from ${ip}`);
  sendJson(res, 200, { user: publicUser(session) }, { 'set-cookie': cookie(req, token, Math.floor(SESSION_MS / 1000)) });
}

/** /api/auth/*; false for any other URL. */
export async function handleAuthHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let u: URL;
  try { u = new URL(req.url || '/', 'http://x'); } catch { return false; }
  const p = u.pathname;
  if (p !== '/api/auth' && !p.startsWith('/api/auth/')) return false;
  const cors = corsOrigin(req);
  if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('access-control-allow-credentials', 'true'); res.setHeader('vary', 'origin'); }
  if (req.method === 'OPTIONS') {
    if (!cors) { sendJson(res, 403, { error: 'forbidden' }); return true; }
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-assistant-token', 'access-control-max-age': '600' });
    res.end();
    return true;
  }
  if (!originAllowed(req) || !tokenOk(req)) { sendJson(res, 403, { error: 'forbidden' }); return true; }
  const route = `${req.method} ${p}`;
  if (route === 'POST /api/auth/login') { await login(req, res); return true; }
  if (route === 'POST /api/auth/logout') {
    const t = cookieToken(req);
    if (t && sessions.delete(tokenHash(t))) saveSessions();
    sendJson(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) });
    return true;
  }
  if (route === 'GET /api/auth/me' || route === 'GET /api/auth/roster') {
    const rate = take('r:' + clientIp(req), READ_RATE);
    if (!rate.ok) { sendJson(res, 429, { error: 'rate limited' }, { 'retry-after': String(rate.retryAfter) }); return true; }
  }
  if (route === 'GET /api/auth/me') {
    const s = getSession(req);
    sendJson(res, 200, { user: s ? publicUser(s) : null }, !s && cookieToken(req) ? { 'set-cookie': cookie(req, '', 0) } : {});
    return true;
  }
  if (route === 'GET /api/auth/roster') {
    await syncRoster();
    sendJson(res, 200, {
      members: members.map((m) => ({ id: m.id, name: m.name, rank: m.rank, department: m.department, role: m.role }))
        .sort((a, b) => a.department.localeCompare(b.department, 'pl') || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name, 'pl')),
      live: liveRoster,
      rfid: members.some((m) => m.rfid),
      testMode: TEST_MODE,
    });
    return true;
  }
  if (['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/roster'].includes(p)) {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  sendJson(res, 404, { error: 'not found' });
  return true;
}

// ---------- server hook ----------
type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
const attached = new WeakSet<Server>();
/** Serves /api/auth/* and runs every other request (all existing and later 'request' listeners) inside the
 *  request context used by currentSession(). Idempotent. */
export function attachAuth(server: Server): void {
  if (attached.has(server)) return;
  attached.add(server);
  const others: RequestListener[] = [];
  const router: RequestListener = (req, res) => als.run({ req }, () => {
    const url = req.url || '/';
    if (url === '/api/auth' || url.startsWith('/api/auth/') || url.startsWith('/api/auth?')) {
      handleAuthHttp(req, res).catch((e) => {
        console.error('[auth] unhandled:', e instanceof Error ? e.message : e);
        sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    for (const l of others) l.call(server, req, res);
  });
  for (const l of server.listeners('request') as RequestListener[]) { server.removeListener('request', l); others.push(l); }
  server.on('request', router);
  server.on('newListener', (event: string | symbol, l: RequestListener) => {
    if (event !== 'request' || l === router) return;
    queueMicrotask(() => { server.removeListener('request', l); if (!others.includes(l)) others.push(l); });
  });
  server.on('close', flushAuth);
}

// ---------- start-up ----------
loadAccounts();
loadSessions();
if (TEST_MODE) console.warn('[auth] AUTH_TEST_MODE is on: crew can log in WITHOUT a PIN (demo / tests only).');
if (DEMO_PIN) console.warn('[auth] ACCOUNTS_DEMO_PIN is set: ONE PIN for every account. Development / tests only.');
setInterval(pruneSessions, 10 * 60_000).unref();
process.once('beforeExit', flushAuth);

// ---------- CLI: list / reset ----------
async function cli(args: string[]) {
  const [cmd, who, given] = args;
  await syncRoster(true);
  loadAccounts();
  if (!members.length) { console.error('No accounts: the crew DB is unreachable and accounts.json is empty.'); process.exitCode = 1; return; }
  if (cmd === 'list') {
    for (const m of members) console.log(`${String(m.id).padStart(3)}  ${m.role.padEnd(7)}  ${m.rank.padEnd(18)}  ${m.name}${m.rfid ? '  [RFID]' : ''}${pins[String(m.id)] ? '' : '  (no PIN)'}`);
    return;
  }
  if (cmd === 'reset' && who) {
    if (given && !PIN_RE.test(given)) { console.error('PIN must be 4-6 digits.'); process.exitCode = 1; return; }
    const targets = who === 'all' ? members : members.filter((m) => String(m.id) === who);
    if (!targets.length) { console.error(`No member with id ${who}.`); process.exitCode = 1; return; }
    const rows: { m: Member; pin: string }[] = [];
    for (const m of targets) {
      const pin = given ?? newPin();
      pins[String(m.id)] = await hashPin(pin);
      rows.push({ m, pin });
    }
    saveAccounts();
    appendPins(rows, 'reset');
    // drop their stored sessions too (a running server picks this up after a restart)
    loadSessions();
    for (const [k, s] of sessions) if (targets.some((m) => m.id === s.accountId)) sessions.delete(k);
    saveSessionsNow();
    console.log(`PIN reset for ${rows.length} account(s); new PIN(s) appended to ${PINS_FILE}. Restart the assistant server to end their open sessions.`);
    return;
  }
  console.log('usage: node --experimental-strip-types server/auth.ts list | reset <id|all> [pin]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(() => process.exit());
}
