// Shared helpers for the adversarial suite (assistant/tests/adversarial/*.test.ts).
// Starts the real server (server/index.ts) as a child process with ASSISTANT_FAKE=1 on a free port, plus raw TCP / raw
// WebSocket clients so we can send things fetch() refuses to send (bare CR/LF, unmasked frames, slow bodies...).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Srv { base: string; port: number; child: ChildProcess; log: string[]; exited: boolean }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(extraEnv: Record<string, string> = {}): Promise<Srv> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'ASSISTANT_TOKEN' || k === 'ALLOWED_ORIGINS') delete env[k];
  Object.assign(env, {
    PORT: String(port), ASSISTANT_FAKE: '1', NODE_ENV: 'test',
    RATE_IP_10MIN: '100000', RATE_IP_DAY: '100000', RATE_GLOBAL_DAY: '1000000',
    CREW_API: 'http://127.0.0.1:9', // closed port unless a test overrides it
  }, extraEnv);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'server/index.ts'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srv: Srv = { base: `http://127.0.0.1:${port}`, port, child, log: [], exited: false };
  child.stdout!.on('data', (d) => srv.log.push(String(d)));
  child.stderr!.on('data', (d) => srv.log.push(String(d)));
  child.on('exit', () => { srv.exited = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (srv.exited) throw new Error('server exited on start:\n' + srv.log.join(''));
    try { if ((await fetch(srv.base + '/api/health')).ok) return srv; } catch { /* not up */ }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('server did not start:\n' + srv.log.join(''));
}

export function stop(srv?: Srv): Promise<void> {
  if (!srv || srv.exited) return Promise.resolve();
  return new Promise((resolve) => {
    srv.child.once('exit', () => resolve());
    srv.child.kill('SIGTERM');
    setTimeout(() => srv.child.kill('SIGKILL'), 2000).unref();
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ipN = 1;
export const freshIp = () => `10.66.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;

export function post(srv: Srv, p: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    signal,
  });
}

export const ask = (content: string, lang = 'pl') => ({ lang, messages: [{ role: 'user', content }] });

/** Server is still alive and answering. */
export async function alive(srv: Srv): Promise<boolean> {
  if (srv.exited) return false;
  try {
    const r = await fetch(srv.base + '/api/health', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

export const noStack = (s: string) => !/\n\s+at\s|node:internal|\.ts:\d+|Error:/.test(s);

/** Raw TCP request: writes `data` (string or chunks with delays) and returns everything read until close / timeout. */
export function raw(port: number, data: string | Buffer | (string | Buffer | number)[], waitMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let out = '';
    const done = () => { clearTimeout(t); sock.destroy(); resolve(out); };
    const t = setTimeout(done, waitMs);
    sock.on('data', (d) => { out += d.toString('latin1'); });
    sock.on('close', done);
    sock.on('error', done);
    sock.on('connect', async () => {
      const parts = Array.isArray(data) ? data : [data];
      for (const p of parts) {
        if (typeof p === 'number') await sleep(p);
        else if (!sock.destroyed) sock.write(p);
      }
    });
  });
}

// ---------- raw WebSocket client ----------
export interface WsFrame { opcode: number; payload: Buffer; json?: any }
export interface RawWs {
  sock: Socket;
  status: number;
  head: string;
  frames: WsFrame[];
  closed: boolean;
  closeCode: number | null;
  sendFrame(opcode: number, payload: Buffer | string, opts?: { fin?: boolean; mask?: boolean; lenOverride?: bigint }): void;
  send(obj: unknown): void;
  waitFor(pred: (f: WsFrame) => boolean, ms?: number): Promise<WsFrame>;
  waitClose(ms?: number): Promise<number | null>;
  end(): void;
}

export function wsFrame(opcode: number, payload: Buffer, { fin = true, mask = true, lenOverride }: { fin?: boolean; mask?: boolean; lenOverride?: bigint } = {}): Buffer {
  const len = lenOverride ?? BigInt(payload.length);
  let head: number[];
  if (len < 126n) head = [(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | Number(len)];
  else if (len <= 65535n) head = [(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | 126, Number(len >> 8n) & 255, Number(len) & 255];
  else {
    const b = Buffer.alloc(10);
    b[0] = (fin ? 0x80 : 0) | opcode; b[1] = (mask ? 0x80 : 0) | 127; b.writeBigUInt64BE(len, 2);
    head = [...b];
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(head), key, body]);
}

export function wsConnect(port: number, opts: { origin?: string; host?: string; path?: string; extra?: string } = {}): Promise<RawWs> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let handshaken = false;
    const waiters: (() => void)[] = [];
    const ws: RawWs = {
      sock, status: 0, head: '', frames: [], closed: false, closeCode: null,
      sendFrame(opcode, payload, o) { if (!sock.destroyed) sock.write(wsFrame(opcode, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), o)); },
      send(obj) { ws.sendFrame(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); },
      waitFor(pred, ms = 2000) {
        return new Promise((res, rej) => {
          const check = () => { const f = ws.frames.find(pred); if (f) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); res(f); return true; } return false; };
          const t = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); rej(new Error('ws wait timeout; frames=' + JSON.stringify(ws.frames.map((f) => f.json ?? f.opcode)))); }, ms);
          waiters.push(check);
          check();
        });
      },
      waitClose(ms = 3000) {
        return new Promise((res) => {
          if (ws.closed) return res(ws.closeCode);
          const t = setTimeout(() => res(ws.closeCode), ms);
          sock.once('close', () => { clearTimeout(t); res(ws.closeCode); });
        });
      },
      end() { sock.destroy(); },
    };
    const notify = () => { for (const w of [...waiters]) w(); };
    sock.on('close', () => { ws.closed = true; if (!handshaken) resolve(ws); notify(); });
    sock.on('error', () => { /* close follows */ });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        ws.head = buf.subarray(0, i).toString('latin1');
        ws.status = Number(/^HTTP\/1\.1 (\d+)/.exec(ws.head)?.[1] ?? 0);
        buf = buf.subarray(i + 4);
        handshaken = true;
        resolve(ws);
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        const f: WsFrame = { opcode, payload };
        if (opcode === 1) { try { f.json = JSON.parse(payload.toString('utf8')); } catch { /* text */ } }
        if (opcode === 8 && payload.length >= 2) ws.closeCode = payload.readUInt16BE(0);
        if (opcode === 9) ws.sendFrame(10, payload); // answer pings like a browser
        ws.frames.push(f);
      }
      notify();
    });
    sock.on('connect', () => {
      const lines = [
        `GET ${opts.path ?? '/crew-video-ws'} HTTP/1.1`,
        `Host: ${opts.host ?? '127.0.0.1:' + port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
      ];
      if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
      if (opts.extra) lines.push(opts.extra);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
  });
}

// ---------- fake crew upstream (records every request it gets) ----------
export interface Upstream { url: string; server: Server; hits: { method: string; url: string; headers: IncomingMessage['headers'] }[]; close(): Promise<void> }

export const FAKE_CREW = [
  { id: 1, badge: 'B-1001', first_name: 'Anna', last_name: 'Nowak', rank: 'Kapitan', department: 'Pokład', nationality: 'Polska',
    birth_date: '1975-01-02', phone_ext: '201', cabin: 'Kabiny oficerskie', room_code: 'D4-01', room_name: 'Mostek', since: '2026-11-19T05:00:00Z' },
  { id: 2, badge: 'B-1002', first_name: 'Jan', last_name: 'Kowal', rank: 'Motorzysta', department: 'Maszyna', nationality: 'Polska',
    birth_date: '1990-03-04', phone_ext: '302', cabin: 'Kabiny załogi', room_code: 'D1-01', room_name: 'Maszynownia', since: '2026-11-19T05:00:00Z' },
];

export async function startUpstream(): Promise<Upstream> {
  const hits: Upstream['hits'] = [];
  const server = createHttpServer((req, res) => {
    hits.push({ method: req.method || '', url: req.url || '', headers: req.headers });
    const u = new URL(req.url || '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') { res.statusCode = 418; return res.end(JSON.stringify({ upstreamSaw: req.method + ' ' + req.url })); }
    const p = u.pathname;
    if (p === '/api/summary') return res.end(JSON.stringify({ crew: 2, onboard: 2 }));
    if (p === '/api/crew') return res.end(JSON.stringify(FAKE_CREW.map((c) => ({ ...c, echo_q: u.searchParams.get('q') }))));
    if (p === '/api/rooms') return res.end(JSON.stringify([{ id: 1, code: 'D1-01', name: 'Maszynownia', people: [FAKE_CREW[1]] }]));
    if (p.startsWith('/api/rooms/')) return res.end(JSON.stringify({ id: 1, code: decodeURIComponent(p.slice(11)), people: [FAKE_CREW[1]] }));
    if (p === '/api/terminals') return res.end(JSON.stringify([{ code: 'T-D1-01-A', room_code: 'D1-01' }]));
    if (p === '/api/activity' || p === '/api/alerts') return res.end('[]');
    res.statusCode = 404; res.end(JSON.stringify({ error: 'upstream 404', path: p }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`, server, hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
