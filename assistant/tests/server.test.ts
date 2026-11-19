// Integration tests for the assistant server (server/index.ts) against assistant/CONTRACT-SERVER.md.
// Run from assistant/:  npm test   (= node --experimental-strip-types --test tests/)
// Each test starts the real server as a child process with ASSISTANT_FAKE=1 (deterministic fake Claude, no API key).
// Requests carry a unique x-forwarded-for so every test gets its own rate-limit bucket (the server trusts the
// first hop when the request comes from 127.0.0.1, as behind nginx).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSSE, type SSEEvent } from './sse.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZONES = ['bridge', 'cabins-fwd', 'cabins-mid', 'cabins-aft', 'restaurant', 'lounge', 'reclining-lounge',
  'vehicle-d1', 'vehicle-d2', 'engine-room', 'engine-control'];
const STAIRS = ['stair-aft', 'stair-fwd'];
const DRILLS = ['fire', 'abandon', 'mob', 'flooding', 'pollution', 'blackout', 'medical'];
const QUESTION = 'Pożar w kabinach na rufie, co robić?';

interface Srv { base: string; child: ChildProcess; log: string[]; exited: boolean }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<Srv> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'ASSISTANT_TOKEN' || k === 'ALLOWED_ORIGINS') delete env[k];
  Object.assign(env, { PORT: String(port), ASSISTANT_FAKE: '1', NODE_ENV: 'test' }, extraEnv);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'server/index.ts'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srv: Srv = { base: `http://127.0.0.1:${port}`, child, log: [], exited: false };
  child.stdout!.on('data', (d) => srv.log.push(String(d)));
  child.stderr!.on('data', (d) => srv.log.push(String(d)));
  child.on('exit', () => { srv.exited = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (srv.exited) throw new Error('server exited on start:\n' + srv.log.join(''));
    try {
      const r = await fetch(srv.base + '/api/health');
      if (r.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not answer /api/health in 15 s:\n' + srv.log.join(''));
}

function stop(srv?: Srv): Promise<void> {
  if (!srv || srv.exited) return Promise.resolve();
  return new Promise((resolve) => {
    srv.child.once('exit', () => resolve());
    srv.child.kill('SIGTERM');
    setTimeout(() => srv.child.kill('SIGKILL'), 2000).unref();
  });
}

let ipN = 1;
const freshIp = () => `10.20.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

function post(srv: Srv, p: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

const ask = (content = QUESTION, lang = 'pl') => ({ lang, messages: [{ role: 'user', content }] });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const noStack = (s: string) => assert.doesNotMatch(s, /\n\s+at\s|node:internal|\.ts:\d+/, 'error body leaks a stack trace');

function checkActions(actions: unknown) {
  assert.ok(Array.isArray(actions), 'actions is an array');
  assert.ok(actions.length <= 4, 'at most 4 actions');
  for (const a of actions as any[]) {
    assert.equal(typeof a.label, 'string');
    assert.ok(a.label.length > 0);
    if (a.type === 'route') {
      assert.ok(ZONES.includes(a.zone), `unknown zone ${a.zone}`);
      if (a.blocked !== undefined) assert.ok(STAIRS.includes(a.blocked), `unknown stair ${a.blocked}`);
    } else if (a.type === 'drill') {
      assert.ok(DRILLS.includes(a.id), `unknown drill ${a.id}`);
    } else assert.fail('unknown action type ' + JSON.stringify(a));
  }
}

function checkAnswer(j: any) {
  assert.ok(Array.isArray(j.text), 'text is string[]');
  for (const p of j.text) {
    assert.equal(typeof p, 'string');
    assert.ok(p.trim().length > 0, 'no empty paragraphs');
    assert.ok(!p.includes('[['), `marker left in text: ${p}`);
  }
  assert.ok(Array.isArray(j.sources), 'sources is an array');
  for (const s of j.sources) { assert.equal(typeof s.label, 'string'); assert.equal(typeof s.href, 'string'); }
  assert.ok(j.sources.length <= 4, 'max 4 sources');
  if (j.fallback !== undefined) assert.equal(typeof j.fallback, 'boolean');
  checkActions(j.actions ?? []);
}

describe('assistant server (ASSISTANT_FAKE=1)', () => {
  let srv: Srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await stop(srv); });

  test('GET /api/health shape', async () => {
    const r = await fetch(srv.base + '/api/health');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.model, 'string');
    assert.ok(j.model.length > 0);
    assert.equal(typeof j.knowledge, 'object');
    assert.equal(typeof j.knowledge.files, 'number');
    assert.equal(typeof j.knowledge.chars, 'number');
    assert.ok(j.knowledge.files >= 0 && j.knowledge.chars >= 0);
    assert.equal(typeof j.uptime, 'number');
    assert.ok(j.uptime >= 0);
  });

  test('GET / serves the front end (or a plain 404 hint when dist is missing)', async () => {
    const r = await fetch(srv.base + '/');
    const body = await r.text();
    assert.ok(r.status === 200 || r.status === 404, `status ${r.status}`);
    if (r.status === 200) {
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      assert.match(body, /<html|<!doctype/i);
    } else assert.match(body, /build|dev/i);
  });

  test('static: path traversal does not escape dist', async () => {
    const r = await fetch(srv.base + '/..%2f..%2fserver%2fknowledge.md');
    const body = await r.text();
    assert.ok(!body.includes('<knowledge>') && !/^#\s/m.test(body.slice(0, 50)) || r.status === 403 || r.status === 404,
      'knowledge.md must not be served');
  });

  test('POST /api/chat happy path', async () => {
    const r = await post(srv, '/api/chat', ask());
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const j = await r.json();
    checkAnswer(j);
    assert.ok(j.text.length > 0, 'fake answer has text');
  });

  test('POST /api/chat keeps conversation history (multi-turn)', async () => {
    const r = await post(srv, '/api/chat', { lang: 'en', messages: [
      { role: 'user', content: 'Where is muster station A?' },
      { role: 'assistant', content: 'On the boat deck, aft.' },
      { role: 'user', content: 'And from the engine room?' },
    ] });
    assert.equal(r.status, 200);
    checkAnswer(await r.json());
  });

  test('400: invalid JSON', async () => {
    const r = await post(srv, '/api/chat', '{not json');
    assert.equal(r.status, 400);
    noStack(await r.text());
  });

  test('400: no user turn', async () => {
    for (const body of [{ lang: 'pl', messages: [] }, { lang: 'pl' },
      { lang: 'pl', messages: [{ role: 'assistant', content: 'hej' }] },
      { lang: 'pl', messages: [{ role: 'user', content: '   ' }] }]) {
      const r = await post(srv, '/api/chat', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      noStack(await r.text());
    }
  });

  test('400/413: body too large', async () => {
    const r = await post(srv, '/api/chat', ask('x'.repeat(300_000)));
    assert.ok(r.status === 400 || r.status === 413, `status ${r.status}`);
    noStack(await r.text());
  });

  test('over-long message is rejected (400) or truncated (200), never 5xx', async () => {
    const r = await post(srv, '/api/chat', ask('Pożar. '.repeat(500))); // 3500 chars > 2000 limit
    assert.ok(r.status === 400 || r.status === 200, `status ${r.status}`);
    if (r.status === 200) checkAnswer(await r.json());
  });

  test('405: GET on /api/chat', async () => {
    const r = await fetch(srv.base + '/api/chat');
    assert.ok(r.status === 405 || r.status === 404, `status ${r.status}`);
  });

  test('403: foreign Origin', async () => {
    const r = await post(srv, '/api/chat', ask(), { origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    noStack(await r.text());
    const rs = await post(srv, '/api/chat/stream', ask(), { origin: 'https://evil.example.com' });
    assert.equal(rs.status, 403);
  });

  test('allowed Origins: localhost:* and same host', async () => {
    const a = await post(srv, '/api/chat', ask(), { origin: 'http://localhost:5173' });
    assert.equal(a.status, 200);
    const b = await post(srv, '/api/chat', ask(), { origin: srv.base });
    assert.equal(b.status, 200);
  });

  test('POST /api/chat/stream: SSE deltas then done', async () => {
    const r = await post(srv, '/api/chat/stream', ask());
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = await readSSE(r);
    const names = events.map((e) => e.event);
    assert.ok(!names.includes('error'), 'no error event: ' + JSON.stringify(events.find((e) => e.event === 'error')));
    const deltas = events.filter((e) => e.event === 'delta');
    assert.ok(deltas.length >= 2, `expected several deltas, got ${deltas.length}`);
    assert.equal(names.filter((n) => n === 'done').length, 1, 'exactly one done');
    assert.equal(names[names.length - 1], 'done', 'done is last');
    const firstDone = names.indexOf('done');
    assert.ok(names.slice(0, firstDone).every((n) => n === 'delta'), 'only deltas before done');

    for (const d of deltas) {
      assert.equal(typeof d.json?.text, 'string', 'delta data is JSON { text }');
      assert.ok(!d.json.text.includes('[['), `marker start leaked in delta: ${JSON.stringify(d.json.text)}`);
      assert.ok(!d.json.text.includes(']]'), `marker end leaked in delta: ${JSON.stringify(d.json.text)}`);
    }
    const streamed = deltas.map((d) => d.json.text).join('');
    assert.doesNotMatch(streamed, /\[\[|ROUTE:|DRILL:|KONTAKT|SRC:/, 'no marker text in joined deltas');

    const done = events[events.length - 1].json;
    checkAnswer(done);
    assert.equal(typeof done.fallback, 'boolean');
    assert.ok(Array.isArray(done.actions));
    assert.equal(norm(streamed), norm(done.text.join('\n\n')), 'done.text equals the concatenated deltas');
  });

  test('stream and /api/chat agree; actions parsed from fake markers', async () => {
    const [rc, rs] = await Promise.all([post(srv, '/api/chat', ask()), post(srv, '/api/chat/stream', ask())]);
    const j = await rc.json();
    const done = (await readSSE(rs)).find((e) => e.event === 'done')!.json;
    assert.deepEqual(done.text, j.text);
    assert.deepEqual(done.actions ?? [], j.actions ?? []);
    assert.ok(done.actions.length >= 1, 'fake answer should carry at least one [[ROUTE]] / [[DRILL]] marker');
    checkActions(done.actions);
    // labels follow the reply language
    const en = await post(srv, '/api/chat/stream', ask('Fire in the aft cabins, what now?', 'en'));
    const doneEn = (await readSSE(en)).find((e) => e.event === 'done')!.json;
    checkAnswer(doneEn);
  });

  test('stream: bad request -> 400 or SSE error event', async () => {
    const r = await post(srv, '/api/chat/stream', { lang: 'pl', messages: [] });
    if (r.status === 200) {
      const ev = await readSSE(r);
      const err = ev.find((e: SSEEvent) => e.event === 'error');
      assert.ok(err, 'error event');
      assert.equal(err.json?.error, 'bad request');
    } else {
      assert.equal(r.status, 400);
      noStack(await r.text());
    }
  });

  test('upstream failure: /api/chat 502, stream sends SSE error', async () => {
    const r = await post(srv, '/api/chat', ask('FAKE_ERROR'));
    assert.equal(r.status, 502);
    const body = await r.text();
    noStack(body);
    assert.equal(JSON.parse(body).error, 'assistant unavailable');
    const s = await post(srv, '/api/chat/stream', ask('FAKE_ERROR'));
    assert.equal(s.status, 200);
    const ev = await readSSE(s);
    const last = ev[ev.length - 1];
    assert.equal(last.event, 'error');
    assert.equal(last.json.error, 'assistant unavailable');
    assert.ok(!ev.some((e) => e.event === 'done'), 'no done after error');
    for (const d of ev.filter((e) => e.event === 'delta')) assert.ok(!d.json.text.includes('[['));
  });

  test('[[KONTAKT]] -> fallback true, marker stripped (chat + stream)', async () => {
    const j = await (await post(srv, '/api/chat', ask('FAKE_KONTAKT'))).json();
    assert.equal(j.fallback, true);
    checkAnswer(j);
    const ev = await readSSE(await post(srv, '/api/chat/stream', ask('FAKE_KONTAKT')));
    const done = ev.find((e) => e.event === 'done')!.json;
    assert.equal(done.fallback, true);
    assert.doesNotMatch(ev.filter((e) => e.event === 'delta').map((e) => e.json.text).join(''), /\[\[|\]\]/); // the fake echoes the word FAKE_KONTAKT, only the marker must go
  });

  test('refusal -> fallback true, no text (chat + stream)', async () => {
    const r = await post(srv, '/api/chat', ask('FAKE_REFUSAL'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.fallback, true);
    assert.deepEqual(j.text, []);
    const ev = await readSSE(await post(srv, '/api/chat/stream', ask('FAKE_REFUSAL')));
    const done = ev.find((e) => e.event === 'done');
    assert.ok(done, 'done event: ' + JSON.stringify(ev));
    assert.equal(done.json.fallback, true);
  });

  test('normal answer: fallback false, sources match knowledge docs', async () => {
    const h = await (await fetch(srv.base + '/api/health')).json();
    const j = await (await post(srv, '/api/chat', ask())).json();
    assert.equal(j.fallback, false);
    if (h.knowledge.files > 0) {
      assert.ok(j.sources.length >= 1, 'fake cites the first knowledge document');
      for (const s of j.sources) assert.match(s.href, /^#doc:/);
    } else assert.deepEqual(j.sources, []);
  });

  test('CORS preflight: localhost dev origin allowed, foreign refused', async () => {
    const ok = await fetch(srv.base + '/api/chat/stream', { method: 'OPTIONS', headers: {
      origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-assistant-token' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /x-assistant-token/);
    const bad = await fetch(srv.base + '/api/chat', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  test('client abort mid-stream does not crash the server', async () => {
    const ac = new AbortController();
    const r = await post(srv, '/api/chat/stream', ask('FAKE_SLOW pożar'), {}, ac.signal);
    assert.equal(r.status, 200);
    let got = 0;
    try {
      await readSSE(r, (e) => { if (e.event === 'delta' && ++got === 1) ac.abort(); });
    } catch { /* AbortError expected */ }
    // a second abort right after the request is sent, before any byte
    const ac2 = new AbortController();
    const p = post(srv, '/api/chat/stream', ask(), {}, ac2.signal).catch(() => null);
    ac2.abort();
    await p;
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(srv.exited, false, 'server process still alive:\n' + srv.log.join(''));
    const h = await fetch(srv.base + '/api/health');
    assert.equal(h.status, 200);
    const again = await post(srv, '/api/chat', ask());
    assert.equal(again.status, 200);
  });
});

describe('guard: rate limit and shared token', () => {
  let srv: Srv;
  before(async () => { srv = await startServer({ ASSISTANT_TOKEN: 'test-secret', ALLOWED_ORIGINS: 'https://crew.example.org' }); });
  after(async () => { await stop(srv); });

  test('x-assistant-token required when ASSISTANT_TOKEN is set', async () => {
    const no = await post(srv, '/api/chat', ask());
    assert.ok(no.status === 401 || no.status === 403, `missing token -> ${no.status}`);
    const bad = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'nope' });
    assert.ok(bad.status === 401 || bad.status === 403, `wrong token -> ${bad.status}`);
    const ok = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'test-secret' });
    assert.equal(ok.status, 200);
    const h = await fetch(srv.base + '/api/health');
    assert.equal(h.status, 200, 'health stays public');
  });

  test('ALLOWED_ORIGINS env is honoured', async () => {
    const r = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'test-secret', origin: 'https://crew.example.org' });
    assert.equal(r.status, 200);
    const bad = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'test-secret', origin: 'https://crew.example.org.evil.com' });
    assert.equal(bad.status, 403);
  });

  test('429 with retry-after after 20 requests / 10 min from one IP', async () => {
    const ip = '10.99.0.1';
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 25; i++) {
      const r = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'test-secret', 'x-forwarded-for': `${ip}, 172.16.0.1` });
      statuses.push(r.status);
      if (r.status === 429 && !limited) limited = r; else await r.arrayBuffer();
    }
    assert.ok(limited, 'got a 429: ' + statuses.join(','));
    assert.ok(statuses.slice(0, 20).every((s) => s === 200), 'first 20 pass: ' + statuses.join(','));
    const ra = Number(limited.headers.get('retry-after'));
    assert.ok(Number.isFinite(ra) && ra > 0, `retry-after header: ${limited.headers.get('retry-after')}`);
    const j = await limited.json();
    assert.equal(j.error, 'rate limited');
    // another client IP is not affected
    const other = await post(srv, '/api/chat', ask(), { 'x-assistant-token': 'test-secret', 'x-forwarded-for': '10.99.0.2' });
    assert.equal(other.status, 200);
    // the stream endpoint shares the bucket
    const s = await post(srv, '/api/chat/stream', ask(), { 'x-assistant-token': 'test-secret', 'x-forwarded-for': ip });
    assert.equal(s.status, 429);
  });
});
