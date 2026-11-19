// Request guard for the chat endpoints (memory only, per process).
//  - client IP: socket peer; when the peer is loopback (nginx on the same host) the first hop of X-Forwarded-For.
//    The rate-limit key is the address for IPv4 (IPv4-mapped IPv6 is folded to IPv4) and the /64 prefix for IPv6
//    (one IPv6 client usually owns a whole /64, so per-address keys would give it 2^64 free identities).
//  - token buckets: per IP 20 / 10 min and 300 / day, global 2000 / day. All three must have a token or nothing is taken.
//    The global bucket is checked first, so a refused request never allocates per-IP buckets; the per-IP map is capped
//    (MAX_IP_BUCKETS, default 50 000 entries) and evicts the least recently used entry when full.
//  - origin: a browser Origin must be this host, localhost / 127.0.0.1 (any port) or listed in ALLOWED_ORIGINS
//    (comma list, e.g. "https://jantar.byst.re,https://example.org"). Requests without Origin (curl, server-to-server) pass.
//  - optional shared secret: when ASSISTANT_TOKEN is set every chat request needs header `x-assistant-token: <same value>`
//    (the terminals' front end sends it from VITE_ASSISTANT_TOKEN).
//    NOTE: VITE_ASSISTANT_TOKEN is built into the public JS bundle, so it is a bot filter, not a secret.
//  - body validation shared by /api/chat and /api/chat/stream (control characters except \n and \t are removed first).
//  - crew proxy (/api/crew/*, crew.ts) has its own per-IP bucket, 120 / min, so map polling never eats the chat limit.
// Limits can be tuned with env (mainly for tests): RATE_IP_10MIN, RATE_IP_DAY, RATE_GLOBAL_DAY, RATE_CREW_MIN.
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export type Lang = 'pl' | 'en' | 'de' | 'uk';
export interface Turn { role: 'user' | 'assistant'; content: string }

const MAX_TURNS = 20;
const MAX_CHARS = 2000;
const LANGS: Lang[] = ['pl', 'en', 'de', 'uk'];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
export const LIMITS = {
  ipShort: { cap: num(process.env.RATE_IP_10MIN, 20), per: 10 * MIN },
  ipDay: { cap: num(process.env.RATE_IP_DAY, 300), per: DAY },
  globalDay: { cap: num(process.env.RATE_GLOBAL_DAY, 2000), per: DAY },
  crewMin: { cap: num(process.env.RATE_CREW_MIN, 120), per: MIN },
};
const MAX_IP_BUCKETS = num(process.env.MAX_IP_BUCKETS, 50_000);

// ---------- client IP ----------
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Rate-limit key for an address: IPv4 as is (also when written as ::ffff:a.b.c.d), IPv6 as its /64 prefix
 *  ("2001:db8:1:2::/64"). Anything that does not parse is returned unchanged (length-capped). */
export function ipKey(addr: string): string {
  let a = addr.trim().slice(0, 64);
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') > 0 ? a.indexOf(']') : undefined); // "[v6]" or "[v6]:port"
  const mapped = /^(?:(?:0{1,4}:){5}|::(?:0{1,4}:)?)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) return a.replace(/:\d+$/, '');
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct); // zone id (fe80::1%eth0)
  let head: string[], tail: string[];
  const dbl = a.split('::');
  if (dbl.length > 2) return a;
  head = dbl[0] ? dbl[0].split(':') : [];
  tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  // an embedded IPv4 tail ("::1.2.3.4") counts as two groups; only the first four groups matter here
  const groupsOf = (xs: string[]) => xs.flatMap((x) => (x.includes('.') ? ['0', '0'] : [x]));
  head = groupsOf(head); tail = groupsOf(tail);
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return a;
  const fill = dbl.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (dbl.length === 1 && head.length !== 8)) return a;
  const full = [...head, ...Array(fill).fill('0'), ...tail];
  return full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress || 'unknown';
  if (LOOPBACK.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return ipKey(first);
  }
  return ipKey(peer);
}

// ---------- token buckets ----------
interface Bucket { tokens: number; last: number }
interface Limit { cap: number; per: number }

// per-IP keys: "s:<ip>", "d:<ip>", "c:<ip>" (crew proxy); Map order = least recently used first
const buckets = new Map<string, Bucket>();
let globalBucket: Bucket | null = null;

const refill = (b: Bucket, l: Limit, now: number) => {
  b.tokens = Math.min(l.cap, b.tokens + ((now - b.last) * l.cap) / l.per);
  b.last = now;
  return b;
};

function levelGlobal(now: number): Bucket {
  globalBucket ??= { tokens: LIMITS.globalDay.cap, last: now };
  return refill(globalBucket, LIMITS.globalDay, now);
}

/** Existing per-IP bucket (refilled), or a full virtual one that is NOT stored yet (see store()). */
function peek(key: string, l: Limit, now: number): Bucket {
  const b = buckets.get(key);
  return b ? refill(b, l, now) : { tokens: l.cap, last: now };
}

/** Store / touch a per-IP bucket (LRU order); evicts the least recently used entries above MAX_IP_BUCKETS. */
function store(key: string, b: Bucket) {
  buckets.delete(key);
  buckets.set(key, b);
  while (buckets.size > MAX_IP_BUCKETS) buckets.delete(buckets.keys().next().value as string);
}

/** Seconds until one token is available again. */
const waitFor = (b: Bucket, l: Limit) => Math.max(1, Math.ceil(((1 - b.tokens) * l.per) / l.cap / 1000));

export type RateResult = { ok: true } | { ok: false; retryAfter: number };

/** Takes one token from each bucket of this IP and from the global one, or none if any is empty. */
export function takeToken(ip: string, now = Date.now()): RateResult {
  const g = levelGlobal(now);
  if (g.tokens < 1) return { ok: false, retryAfter: waitFor(g, LIMITS.globalDay) }; // nothing per-IP is allocated
  const s = peek('s:' + ip, LIMITS.ipShort, now);
  const d = peek('d:' + ip, LIMITS.ipDay, now);
  const empty = ([[s, LIMITS.ipShort], [d, LIMITS.ipDay]] as [Bucket, Limit][]).filter(([b]) => b.tokens < 1);
  if (empty.length) return { ok: false, retryAfter: Math.max(...empty.map(([b, l]) => waitFor(b, l))) };
  g.tokens -= 1; s.tokens -= 1; d.tokens -= 1;
  store('s:' + ip, s);
  store('d:' + ip, d);
  return { ok: true };
}

/** Crew proxy: one token from this IP's own crew bucket (separate from the chat buckets). */
export function takeCrewToken(ip: string, now = Date.now()): RateResult {
  const b = peek('c:' + ip, LIMITS.crewMin, now);
  if (b.tokens < 1) return { ok: false, retryAfter: waitFor(b, LIMITS.crewMin) };
  b.tokens -= 1;
  store('c:' + ip, b);
  return { ok: true };
}

/** Drop buckets that refilled completely (idle clients). */
export function cleanup(now = Date.now()) {
  for (const [key, b] of buckets) {
    const l = key.startsWith('s:') ? LIMITS.ipShort : key.startsWith('c:') ? LIMITS.crewMin : LIMITS.ipDay;
    if (b.tokens + ((now - b.last) * l.cap) / l.per >= l.cap) buckets.delete(key);
  }
}
setInterval(cleanup, 10 * MIN).unref();

/** For tests. */
export function resetGuard() { buckets.clear(); globalBucket = null; }
/** For tests: number of stored per-IP buckets. */
export const bucketCount = () => buckets.size;

// ---------- origin + token ----------
const allowedOrigins = () =>
  new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));

/** True when the request has no Origin (non-browser) or a trusted one. */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins().has(origin.replace(/\/+$/, ''))) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true;
  const host = req.headers['x-forwarded-host'] && LOOPBACK.has(req.socket.remoteAddress || '')
    ? String(req.headers['x-forwarded-host']).split(',')[0].trim()
    : req.headers.host;
  return !!host && u.host === host;
}

/** Cross-origin but allowed (ALLOWED_ORIGINS or localhost on another port): the caller should add CORS headers. */
export function corsOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return null;
  try { if (new URL(origin).host === req.headers.host) return null; } catch { return null; }
  return origin;
}

export function tokenOk(req: IncomingMessage): boolean {
  const want = process.env.ASSISTANT_TOKEN;
  if (!want) return true;
  const got = req.headers['x-assistant-token'];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- body validation ----------
export interface ChatInput { lang: Lang; messages: Turn[] }
/** C0 controls except \t and \n, DEL and C1 controls: removed before trimming (a NUL-only question is an empty one). */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Parse + normalise a chat body. Keeps the last 20 turns, trims each to 2000 chars, merges same-role neighbours,
 *  starts with a user turn and must end with one. Returns null when nothing usable is left (-> 400). */
export function validateChat(raw: string): ChatInput | null {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const { lang, messages } = body as { lang?: unknown; messages?: unknown };
  if (!Array.isArray(messages)) return null;
  const out: Turn[] = [];
  for (const m of messages.slice(-MAX_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.replace(CONTROL_RE, '').slice(0, MAX_CHARS).trim();
    if (!content) continue;
    if (!out.length && m.role !== 'user') continue; // the API needs alternating turns that start with the user
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return { lang: LANGS.includes(lang as Lang) ? (lang as Lang) : 'pl', messages: out };
}
