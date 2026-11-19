// Assistant server (Node http, run with `node --experimental-strip-types server/index.ts`).
//   GET  /api/health       -> { ok, model, engine: "claude" | "local", configured, knowledge: { files, chars }, uptime }
//   POST /api/chat         { lang, messages: Turn[] } -> { text: string[], sources, fallback, actions }
//   POST /api/chat/stream  same body -> Server-Sent Events: `delta` { text } (markers removed), then `done` (same shape as
//                          /api/chat, authoritative) or `error` { error: "assistant unavailable" | "rate limited" | "bad request" }
//   GET  /api/crew/{summary|rooms|rooms/:id|crew?q=|terminals|activity|alerts}
//                          read-only proxy to the crew database (CREW_API), rooms/terminals + `place`; 503 when it is down (crew.ts)
//   POST /api/checkin      { rfid, terminal, direction? } from a physical RFID terminal, header x-terminal-key (terminals.ts)
// Errors: 400 bad input, 403 bad origin / missing x-assistant-token, 429 rate limited (retry-after), 502 upstream failure,
//         503 { error: "assistant not configured" } without Anthropic credentials and no local engine (stream: SSE `error`).
// Listens on HOST (default 127.0.0.1: nginx is the only way in) and PORT. requestTimeout 15 s / headersTimeout 10 s
// only bound how long receiving a request may take; SSE responses are not cut by them.
// Guard rules (rate limits, origin, ASSISTANT_TOKEN) live in guard.ts; the Claude call and ship documents in claude.ts.
// The API key stays here (ANTHROPIC_API_KEY or an `ant auth login` profile); the browser never sees it.
// ASSISTANT_FAKE=1 runs with a deterministic fake Claude (no key, no network) for tests and demos.
// ASSISTANT_ENGINE=claude (default) | local | auto picks who answers /api/chat*: `claude` = Claude only (503 "assistant
// not configured" without credentials; the browser then answers with its own local engine, src/local/); `local` = the
// free deterministic engine on the server (local.ts = src/local/engine.ts with the crew tools, no LLM); `auto` = Claude
// when credentials (or ASSISTANT_FAKE=1) are set, otherwise the local engine.
// In production it also serves the built front end from ../dist.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, corsOrigin, originAllowed, takeToken, tokenOk, validateChat, type ChatInput } from './guard.ts';
import { CONFIGURED, FAKE, MODEL, ask, askStream, describeError, knowledgeStats } from './claude.ts';
import { localAsk, localAskStream } from './local.ts';
import { CREW_API, crewEnabled, handleCrewProxy } from './crew.ts';
import { attachCrewVideoWebSocket } from './crew-video.ts';
import { attachAlarms, handleAlarmHttp } from './alarms.ts';
import { handleStatsHttp } from './stats.ts';
import { handleBandsHttp } from './positions.ts';
import { handleTerminalsHttp } from './terminals.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DIST = path.join(here, '..', 'dist');
const STARTED = Date.now();
const HEARTBEAT_MS = 15_000;

const NOT_CONFIGURED = 'assistant not configured';
const ENGINE_ENV = (process.env.ASSISTANT_ENGINE || 'claude').trim().toLowerCase();
if (!['auto', 'local', 'claude'].includes(ENGINE_ENV)) console.warn(`[assistant] unknown ASSISTANT_ENGINE=${ENGINE_ENV}, using claude`);
/** the local engine answers the chat (no LLM): forced, or auto without Claude credentials */
const LOCAL = ENGINE_ENV === 'local' || (ENGINE_ENV === 'auto' && !CONFIGURED);
const ENGINE = LOCAL ? 'local' : 'claude';

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
  if (!LOCAL && !CONFIGURED) { // Claude only (ASSISTANT_ENGINE=claude) and no API key: answer at once, no SDK call, no token
    if (route === 'stream') {
      res.writeHead(503, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      res.end(`event: error\ndata: ${JSON.stringify({ error: NOT_CONFIGURED })}\n\n`);
    } else send(res, 503, { error: NOT_CONFIGURED }, { connection: 'close' });
    log(route, 503, t0, 'not configured');
    return null;
  }
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
    const r = LOCAL ? await localAsk(input.lang, input.messages) : await ask(input.lang, input.messages, ac.signal);
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
    const onDelta = (text: string) => event('delta', { text });
    const r = LOCAL
      ? await localAskStream(input.lang, input.messages, onDelta, ac.signal)
      : await askStream(input.lang, input.messages, onDelta, ac.signal);
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
  if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

// Time allowed to RECEIVE a request (headers / whole request incl. body); env overrides are for tests only.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15_000;
const HEADERS_TIMEOUT_MS = Math.min(Number(process.env.HEADERS_TIMEOUT_MS) || 10_000, REQUEST_TIMEOUT_MS);

// connectionsCheckingInterval: how often Node enforces the two timeouts (default 30 s would make 15 s up to 45 s)
const server = createServer({ connectionsCheckingInterval: 2_000 }, async (req, res) => {
  const t0 = Date.now();
  try {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
      return send(res, 200, {
        ok: true, model: LOCAL ? 'local' : MODEL, engine: ENGINE, configured: CONFIGURED, knowledge: knowledgeStats, uptime: Math.round((Date.now() - STARTED) / 1000),
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
    if (await handleAlarmHttp(req, res)) return;
    if (await handleStatsHttp(req, res)) return;
    if (await handleBandsHttp(req, res)) return;
    if (await handleTerminalsHttp(req, res)) return;
    if (url.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    console.error('[assistant] unhandled:', e instanceof Error ? e.message : e);
    send(res, 500, { error: 'internal error' });
  }
});
// crew video chat between terminals (signalling WebSocket at /crew-video-ws, from branch videochat)
attachCrewVideoWebSocket(server);
// ship alarm system (centrala): WebSocket /api/alarms/ws, GET /api/alarms/state|log
attachAlarms(server);
// Only bound the time to RECEIVE a request (slow / unfinished bodies); a long SSE response is not affected.
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.listen(PORT, HOST, () => console.log(`[assistant] http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}  engine=${ENGINE}${LOCAL ? '' : `  model=${MODEL}`}${FAKE && !LOCAL ? '  FAKE client' : ''}${CONFIGURED || LOCAL ? '' : '  NOT CONFIGURED (no API key)'}  crew=${crewEnabled ? CREW_API : 'off'}`));
