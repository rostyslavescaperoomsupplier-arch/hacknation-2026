// Request guard for the chat endpoints (memory only, per process).
//  - client IP: socket peer; when the peer is loopback (nginx on the same host) the first hop of X-Forwarded-For.
//  - token buckets: per IP 20 / 10 min and 300 / day, global 2000 / day. All three must have a token or nothing is taken.
//  - origin: a browser Origin must be this host, localhost / 127.0.0.1 (any port) or listed in ALLOWED_ORIGINS
//    (comma list, e.g. "https://jantar.byst.re,https://example.org"). Requests without Origin (curl, server-to-server) pass.
//  - optional shared secret: when ASSISTANT_TOKEN is set every chat request needs header `x-assistant-token: <same value>`
//    (the terminals' front end sends it from VITE_ASSISTANT_TOKEN).
//  - body validation shared by /api/chat and /api/chat/stream.
// Limits can be tuned with env (mainly for tests): RATE_IP_10MIN, RATE_IP_DAY, RATE_GLOBAL_DAY.
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
};

// ---------- client IP ----------
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress || 'unknown';
  if (LOOPBACK.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return peer;
}

// ---------- token buckets ----------
interface Bucket { tokens: number; last: number }
interface Limit { cap: number; per: number }

const buckets = new Map<string, Bucket>(); // keys: "s:<ip>", "d:<ip>", "global"

function level(key: string, l: Limit, now: number): Bucket {
  let b = buckets.get(key);
  if (!b) { b = { tokens: l.cap, last: now }; buckets.set(key, b); }
  b.tokens = Math.min(l.cap, b.tokens + ((now - b.last) * l.cap) / l.per);
  b.last = now;
  return b;
}

/** Seconds until one token is available again. */
const waitFor = (b: Bucket, l: Limit) => Math.max(1, Math.ceil(((1 - b.tokens) * l.per) / l.cap / 1000));

export type RateResult = { ok: true } | { ok: false; retryAfter: number };

/** Takes one token from each bucket of this IP and from the global one, or none if any is empty. */
export function takeToken(ip: string, now = Date.now()): RateResult {
  const checks: [Bucket, Limit][] = [
    [level('s:' + ip, LIMITS.ipShort, now), LIMITS.ipShort],
    [level('d:' + ip, LIMITS.ipDay, now), LIMITS.ipDay],
    [level('global', LIMITS.globalDay, now), LIMITS.globalDay],
  ];
  const empty = checks.filter(([b]) => b.tokens < 1);
  if (empty.length) return { ok: false, retryAfter: Math.max(...empty.map(([b, l]) => waitFor(b, l))) };
  for (const [b] of checks) b.tokens -= 1;
  return { ok: true };
}

/** Drop buckets that refilled completely (idle clients). */
export function cleanup(now = Date.now()) {
  for (const [key, b] of buckets) {
    const l = key === 'global' ? LIMITS.globalDay : key.startsWith('s:') ? LIMITS.ipShort : LIMITS.ipDay;
    if (b.tokens + ((now - b.last) * l.cap) / l.per >= l.cap) buckets.delete(key);
  }
}
setInterval(cleanup, 10 * MIN).unref();

/** For tests. */
export function resetGuard() { buckets.clear(); }

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
    const content = m.content.slice(0, MAX_CHARS).trim();
    if (!content) continue;
    if (!out.length && m.role !== 'user') continue; // the API needs alternating turns that start with the user
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return { lang: LANGS.includes(lang as Lang) ? (lang as Lang) : 'pl', messages: out };
}
