// Physical RFID terminals (rfid-terminal/, Raspberry Pi + RC522) on the public server.
//   POST /api/checkin   { rfid, terminal, direction? }  - same path and body as the crew server, so a terminal only
//                       changes its server address. Header x-terminal-key must equal TERMINAL_KEY (or BAND_KEY when
//                       TERMINAL_KEY is not set). With neither key set, only loopback callers are accepted.
// The crew server listens on localhost only, so the assistant forwards the check-in to <CREW_API>/api/checkin and
// answers with the person reduced to what the terminal shows: { first_name, last_name, rank, room_code, room_name }.
// Errors keep the crew server's { error } and status (404 unknown card / terminal); 503 when the database is down,
// so the terminal queues the check-in and retries.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CREW_API, crewEnabled } from './crew.ts';
import { clientIp } from './guard.ts';

const KEY = (process.env.TERMINAL_KEY || process.env.BAND_KEY || '').trim();
const TIMEOUT_MS = 3000;

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function terminalAllowed(req: IncomingMessage): boolean {
  if (KEY) return req.headers['x-terminal-key'] === KEY;
  return isLoopback(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
}

const buckets = new Map<string, { n: number; t: number }>();
function allow(key: string, perMin: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60_000) { if (buckets.size > 10_000) buckets.clear(); buckets.set(key, b = { n: 0, t: now }); }
  return ++b.n <= perMin;
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max = 2048): Promise<string | null> {
  return new Promise((resolve) => {
    let n = 0; const parts: Buffer[] = []; let done = false;
    req.on('data', (c: Buffer) => { if (done) return; n += c.length; if (n > max) { done = true; resolve(null); req.resume(); return; } parts.push(c); });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

export interface Checkin { rfid: string; terminal: string; direction: 'in' | 'out' }

/** { rfid: "59:BA:E9:5A" (4-10 bytes, any separators), terminal: "T-D4-01-A", direction?: "in" | "out" } or null. */
export function validCheckin(b: any): Checkin | null {
  if (!b || typeof b !== 'object' || typeof b.rfid !== 'string' || typeof b.terminal !== 'string') return null;
  if (b.rfid.length > 40 || !/^[0-9A-Fa-f:\- ]+$/.test(b.rfid)) return null;
  const hex = b.rfid.replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length < 8 || hex.length > 20 || hex.length % 2) return null;
  if (!/^[A-Za-z0-9-]{1,32}$/.test(b.terminal)) return null;
  if (b.direction !== undefined && b.direction !== 'in' && b.direction !== 'out') return null;
  return { rfid: b.rfid, terminal: b.terminal, direction: b.direction === 'out' ? 'out' : 'in' };
}

export async function handleTerminalsHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((req.url || '/').split('?')[0] !== '/api/checkin') return false;
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }, { allow: 'POST' }); return true; }
  if (!terminalAllowed(req)) { send(res, 403, { error: 'forbidden' }); return true; }
  if (!allow('ip:' + clientIp(req), 300)) { send(res, 429, { error: 'rate limited' }, { 'retry-after': '10' }); return true; }
  const raw = await readBody(req);
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* below */ }
  const c = validCheckin(body);
  if (!c) { send(res, 400, { error: 'bad checkin' }); return true; }
  if (!crewEnabled) { send(res, 503, { error: 'crew database unavailable' }); return true; }

  let r: Response;
  try {
    r = await fetch(CREW_API + '/api/checkin', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(c),
    });
  } catch (e) {
    console.log('[assistant] checkin: crew database down:', e instanceof Error ? e.message : e);
    send(res, 503, { error: 'crew database unavailable' });
    return true;
  }
  let data: any = null;
  try { data = await r.json(); } catch { /* below */ }
  if (r.ok && data && typeof data === 'object') {
    const { first_name, last_name, rank, room_code, room_name } = data;
    console.log(`[assistant] checkin ${c.terminal} ${c.direction}: ${first_name} ${last_name}`);
    send(res, 200, { first_name, last_name, rank, room_code, room_name });
  } else if (r.status >= 400 && r.status < 500) {
    send(res, r.status, { error: typeof data?.error === 'string' ? data.error : 'rejected' });
  } else {
    send(res, 503, { error: 'crew database unavailable' });
  }
  return true;
}
