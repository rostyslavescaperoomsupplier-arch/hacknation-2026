// Assistant server (Node http, run with `node --experimental-strip-types server/index.ts`).
//   GET  /api/health       -> { ok, model, knowledge: { files, chars }, uptime }
//   POST /api/chat         { lang, messages: Turn[] } -> { text: string[], sources, fallback, actions }
//   POST /api/chat/stream  same body -> Server-Sent Events: `delta` { text } (markers removed), then `done` (same shape as
//                          /api/chat, authoritative) or `error` { error: "assistant unavailable" | "rate limited" | "bad request" }
//   GET  /api/crew/{summary|rooms|rooms/:id|crew?q=|terminals|activity|alerts}
//                          read-only proxy to the crew database (CREW_API), rooms/terminals + `place`; 503 when it is down (crew.ts)
// Errors: 400 bad input, 403 bad origin / missing x-assistant-token, 429 rate limited (retry-after), 502 upstream failure.
// Guard rules (rate limits, origin, ASSISTANT_TOKEN) live in guard.ts; the Claude call and ship documents in claude.ts.
// The API key stays here (ANTHROPIC_API_KEY or an `ant auth login` profile); the browser never sees it.
// ASSISTANT_FAKE=1 runs with a deterministic fake Claude (no key, no network) for tests and demos.
// In production it also serves the built front end from ../dist.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, corsOrigin, originAllowed, takeToken, tokenOk, validateChat, type ChatInput } from './guard.ts';
import { FAKE, MODEL, ask, askStream, describeError, knowledgeStats } from './claude.ts';
import { CREW_API, crewEnabled, handleCrewProxy } from './crew.ts';
import { attachCrewVideoWebSocket } from './crew-video.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DIST = path.join(here, '..', 'dist');
const STARTED = Date.now();
const HEARTBEAT_MS = 15_000;

class BodyError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      if (tooLarge) return; // keep draining so the 400 can still be written; the socket closes after it
      data += c;
      if (data.length > 100_000) { tooLarge = true; data = ''; reject(new BodyError('too large')); }
    });
    req.on('end', () => { if (!tooLarge) resolve(data); });
    req.on('error', () => reject(new BodyError('read error')));
  });
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

const log = (route: string, status: number, t0: number, note = '') =>
  console.log(`[assistant] ${route} ${status} ${Date.now() - t0}ms${note ? ' ' + note : ''}`);

/** Origin, token, rate limit, body. Sends the error response itself and returns null when the request is refused. */
async function admit(req: IncomingMessage, res: ServerResponse, route: string, t0: number): Promise<ChatInput | null> {
  if (!originAllowed(req) || !tokenOk(req)) { send(res, 403, { error: 'forbidden' }); log(route, 403, t0); return null; }
  const rate = takeToken(clientIp(req));
  if (!rate.ok) {
    send(res, 429, { error: 'rate limited' }, { 'retry-after': String(rate.retryAfter) });
    log(route, 429, t0);
    return null;
  }
  let input: ChatInput | null = null;
  try { input = validateChat(await readBody(req)); } catch { /* too large / broken body */ }
  if (!input) { send(res, 400, { error: 'bad request' }, { connection: 'close' }); log(route, 400, t0); return null; }
  return input;
}

async function chat(req: IncomingMessage, res: ServerResponse, t0: number) {
  const input = await admit(req, res, 'chat', t0);
  if (!input) return;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const r = await ask(input.lang, input.messages, ac.signal);
    send(res, 200, r);
    log('chat', 200, t0);
  } catch (e) {
    if (ac.signal.aborted) { log('chat', 499, t0, 'client gone'); return; }
    console.error('[assistant] chat:', describeError(e));
    send(res, 502, { error: 'assistant unavailable' });
    log('chat', 502, t0);
  }
}

async function chatStream(req: IncomingMessage, res: ServerResponse, t0: number) {
  const input = await admit(req, res, 'stream', t0);
  if (!input) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  const event = (name: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
  const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  const ac = new AbortController();
  res.on('close', () => { clearInterval(beat); if (!res.writableEnded) ac.abort(); });
  try {
    const r = await askStream(input.lang, input.messages, (text) => event('delta', { text }), ac.signal);
    event('done', r);
    log('stream', 200, t0);
  } catch (e) {
    if (ac.signal.aborted) { log('stream', 499, t0, 'client gone'); return; }
    console.error('[assistant] stream:', describeError(e));
    event('error', { error: 'assistant unavailable' });
    log('stream', 502, t0, 'sse error');
  } finally {
    clearInterval(beat);
    if (!res.writableEnded) res.end();
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.normalize(path.join(DIST, pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
      return send(res, 200, {
        ok: true, model: MODEL, knowledge: knowledgeStats, uptime: Math.round((Date.now() - STARTED) / 1000),
        ...(FAKE ? { fake: true } : {}),
      });
    }
    if (url === '/api/chat' || url === '/api/chat/stream') {
      const cors = corsOrigin(req); // allowed cross-origin caller (ALLOWED_ORIGINS / localhost dev port)
      if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('vary', 'origin'); }
      if (req.method === 'OPTIONS') {
        if (!cors) return send(res, 403, { error: 'forbidden' });
        res.writeHead(204, {
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type, x-assistant-token',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return url === '/api/chat' ? await chat(req, res, t0) : await chatStream(req, res, t0);
    }
    if (await handleCrewProxy(req, res)) return;
    if (url.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    console.error('[assistant] unhandled:', e instanceof Error ? e.message : e);
    send(res, 500, { error: 'internal error' });
  }
});
// crew video chat between terminals (signalling WebSocket at /crew-video-ws, from branch videochat)
attachCrewVideoWebSocket(server);
server.listen(PORT, () => console.log(`[assistant] http://localhost:${PORT}  model=${MODEL}${FAKE ? '  FAKE client' : ''}  crew=${crewEnabled ? CREW_API : 'off'}`));
