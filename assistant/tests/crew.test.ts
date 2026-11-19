// Crew database link: /api/crew/* proxy, crew tools and the tool loop through the chat (assistant/CONTRACT-CREW.md).
// A fake crew server (node http, random port, fixed JSON shaped like the real crew/server) stands in for the database;
// the assistant runs with ASSISTANT_FAKE=1, whose fake Claude calls find_crew {query:"bosman"} when the question says FAKE_TOOL.
// One smoke test also hits the REAL crew server on 127.0.0.1:8790 when it is running (skipped otherwise).
// Crew data needs a logged-in crew member (server/auth.ts, finding #2): every server here runs with ACCOUNTS_DEMO_PIN
// and the helpers log in as the Kapitan of its crew DB once, then send that session cookie (srv.cookie).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSSE } from './sse.ts';
import { CREW_ROOM_PLACES, terminalAt } from '../shared/crew-map.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- fake crew server ----------
const T = new Date(Date.now() - 42 * 60_000).toISOString();
const PERSON = (o: Record<string, unknown>) => ({
  shift: 'dzienna', nationality: 'Ukraina', birth_date: '2000-12-24', embarked_at: '2026-10-13', cabin: 'Kabiny załogi – blok A', since: T, ...o,
});
const CREW = [
  PERSON({ id: 6, badge: 'B-1006', first_name: 'Natalia', last_name: 'Melnyk', rank: 'Bosman', department: 'Pokład', phone_ext: '206',
    room_id: 14, room_code: 'D2-08', room_name: 'Magazyn bosmański' }),
  PERSON({ id: 1, badge: 'B-1001', first_name: 'Bartosz', last_name: 'Kozłowski', rank: 'Kapitan', department: 'Pokład', phone_ext: '201',
    nationality: 'Polska', birth_date: '1970-01-02', room_id: 21, room_code: 'D4-01', room_name: 'Mostek nawigacyjny' }),
  PERSON({ id: 30, badge: 'B-1030', first_name: 'Łukasz', last_name: 'Żak', rank: 'II mechanik', department: 'Maszynownia', phone_ext: '230',
    room_id: 1, room_code: 'D1-01', room_name: 'Maszynownia główna' }),
  PERSON({ id: 44, badge: 'B-1044', first_name: 'Ola', last_name: 'Nowak', rank: 'Steward', department: 'Hotel', phone_ext: '244',
    room_id: null, room_code: null, room_name: null, since: null }),
];
const ROOM = (o: Record<string, unknown>) => ({ role: 'x', description: 'x', area_m2: 10, restricted: 0, min_staff: 0, staff_hours: '00-24',
  hazardous: 0, deck: 2, deck_name: 'Pokład główny', terminals: 1, checkins_24h: 3, ...o });
const ROOMS = [
  ROOM({ id: 21, code: 'D4-01', name: 'Mostek nawigacyjny', role: 'Nawigacja', capacity: 8, min_staff: 2, deck: 4, people: 1, occupancy: 12.5 }),
  ROOM({ id: 14, code: 'D2-08', name: 'Magazyn bosmański', role: 'Pokład', capacity: 4, people: 1, occupancy: 25 }),
  ROOM({ id: 1, code: 'D1-01', name: 'Maszynownia główna', role: 'Maszynownia', capacity: 12, hazardous: 1, deck: 1, people: 1, occupancy: 8.3 }),
  ROOM({ id: 99, code: 'X9-99', name: 'Pomieszczenie spoza mapy', capacity: 2, people: 0, occupancy: 0 }),
];
const TERMINALS = [
  { code: 'T-D1-01-A', room_code: 'D1-01', room_name: 'Maszynownia główna' },
  { code: 'T-D1-01-B', room_code: 'D1-01', room_name: 'Maszynownia główna' },
  { code: 'T-X9-99-A', room_code: 'X9-99', room_name: 'Pomieszczenie spoza mapy' },
];
const SUMMARY = { crew: 4, onboard: 3, ashore: 1, rooms: 4, terminals: 3, checkins24h: 17, lastCheckin: T };
const ACTIVITY = [{ start: T, count: 5 }];
const person = (c: any) => ({ id: c.id, badge: c.badge, name: `${c.first_name} ${c.last_name}`, rank: c.rank, department: c.department });
const ALERTS = {
  limits: { loneWarnMin: 30, loneCritMin: 60, staleWarnH: 4, staleCritH: 8, cabinWarnH: 12, cabinCritH: 16 },
  staffing: [{ room_id: 21, code: 'D4-01', name: 'Mostek nawigacyjny', deck: 4, min_staff: 2, staff_hours: '00-24', active: true, people: 1,
    crew: [person(CREW[1])], status: 'warning', understaffed_since: T, understaffed_all_day: false, coverage_24h: 80 }],
  lone: [{ room_id: 1, code: 'D1-01', name: 'Maszynownia główna', deck: 1, crew: person(CREW[2]), since: T, minutes: 42, status: 'warning' }],
  lastCheckin: [{ ...person(CREW[0]), room: 'Magazyn bosmański', in_cabin: false, ashore: false, since: T, hours: 9.1, status: 'critical' }],
  counts: { staffing: { critical: 0, warning: 1 }, lone: { critical: 0, warning: 1 }, lastCheckin: { critical: 1, warning: 0 } },
};

interface FakeCrew { base: string; server: Server; hits: string[] }
function startFakeCrew(): Promise<FakeCrew> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    hits.push(`${req.method} ${u.pathname}${u.search}`);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return json(404, { error: 'Not found' });
    const p = u.pathname;
    if (p === '/api/summary') return json(200, SUMMARY);
    if (p === '/api/rooms') return json(200, ROOMS);
    const m = /^\/api\/rooms\/(\d+)$/.exec(p);
    if (m) {
      const r = ROOMS.find((x) => x.id === Number(m[1]));
      return r ? json(200, { ...r, crew: CREW.filter((c) => c.room_id === r.id) }) : json(404, { error: 'Brak pomieszczenia' });
    }
    if (p === '/api/crew') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      return json(200, CREW.filter((c) => `${c.first_name} ${c.last_name} ${c.rank} ${c.badge}`.toLowerCase().includes(q)));
    }
    if (p === '/api/terminals') return json(200, TERMINALS);
    if (p === '/api/activity') return json(200, ACTIVITY);
    if (p === '/api/alerts') return json(200, ALERTS);
    json(404, { error: 'Not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${port}`, server, hits });
  }));
}

// ---------- assistant server ----------
interface Srv { base: string; child: ChildProcess; log: string[]; exited: boolean; cookie?: string }
const DEMO_PIN = '2468';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

async function startServer(extraEnv: Record<string, string>): Promise<Srv> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS', 'CREW_API'].includes(k)) delete env[k];
  Object.assign(env, { PORT: String(port), ASSISTANT_FAKE: '1', NODE_ENV: 'test', ACCOUNTS_DEMO_PIN: DEMO_PIN }, extraEnv);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv: Srv = { base: `http://127.0.0.1:${port}`, child, log: [], exited: false };
  child.stdout!.on('data', (d) => srv.log.push(String(d)));
  child.stderr!.on('data', (d) => srv.log.push(String(d)));
  child.on('exit', () => { srv.exited = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (srv.exited) throw new Error('server exited on start:\n' + srv.log.join(''));
    try { if ((await fetch(srv.base + '/api/health')).ok) { await loginCaptain(srv); return srv; } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start:\n' + srv.log.join(''));
}

/** Log in as the Kapitan (or the first account) of the server's roster; leaves srv.cookie unset when there is none. */
async function loginCaptain(srv: Srv) {
  const roster = await (await fetch(srv.base + '/api/auth/roster')).json();
  const m = roster.members.find((x: any) => x.role === 'captain') ?? roster.members[0];
  if (!m) return;
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'pin', id: m.id, pin: DEMO_PIN }) });
  if (r.ok) srv.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
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
const freshIp = () => `10.40.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
// both send the server's session cookie unless `cookie` is given in headers ('' = no session)
const withCookie = (srv: Srv, h: Record<string, string>) => {
  const out = { ...h };
  if (!('cookie' in out) && srv.cookie) out.cookie = srv.cookie;
  if (out.cookie === '') delete out.cookie;
  return out;
};
const get = (srv: Srv, p: string, headers: Record<string, string> = {}) =>
  fetch(srv.base + p, { headers: withCookie(srv, { 'x-forwarded-for': freshIp(), ...headers }) });
const post = (srv: Srv, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(srv.base + p, { method: 'POST', headers: withCookie(srv, { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers }), body: JSON.stringify(body) });
const ask = (content: string) => ({ lang: 'pl', messages: [{ role: 'user', content }] });

function checkNoMarkers(texts: string[]) {
  for (const t of texts) assert.ok(!t.includes('[[') && !t.includes(']]'), `marker leaked: ${JSON.stringify(t)}`);
}

// ---------- proxy + tool loop against the fake crew server ----------
describe('crew link (fake crew server)', () => {
  let crew: FakeCrew;
  let srv: Srv;
  before(async () => {
    crew = await startFakeCrew();
    srv = await startServer({ CREW_API: crew.base });
  });
  after(async () => {
    await stop(srv);
    await new Promise((r) => crew.server.close(r));
  });

  test('GET /api/crew/summary, activity: same JSON as the crew server; alerts without badge / person ids', async () => {
    const pub = (c: any) => ({ name: `${c.first_name} ${c.last_name}`, rank: c.rank, department: c.department });
    const alerts = {
      ...ALERTS,
      staffing: ALERTS.staffing.map((s) => ({ ...s, crew: s.crew.map(() => pub(CREW[1])) })),
      lone: ALERTS.lone.map((l) => ({ ...l, crew: pub(CREW[2]) })),
      lastCheckin: ALERTS.lastCheckin.map(({ id: _i, badge: _b, ...rest }) => rest),
    };
    for (const [p, want] of [['summary', SUMMARY], ['activity', ACTIVITY], ['alerts', alerts]] as const) {
      const r = await get(srv, '/api/crew/' + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await r.json(), want, p);
    }
  });

  test('GET /api/crew/rooms adds place {zone, at} from the map, null when unmapped', async () => {
    const rooms = await (await get(srv, '/api/crew/rooms')).json();
    assert.equal(rooms.length, ROOMS.length);
    for (const r of rooms) {
      const orig = ROOMS.find((x) => x.id === r.id)!;
      for (const [k, v] of Object.entries(orig)) assert.deepEqual(r[k], v, `field ${k} kept`);
      const p = CREW_ROOM_PLACES[r.code];
      if (p) assert.deepEqual(r.place, { zone: p.zone, at: p.at });
      else assert.equal(r.place, null);
    }
    assert.equal(rooms.find((r: any) => r.code === 'D2-08').place.zone, 'vehicle-d2');
  });

  test('GET /api/crew/rooms/:id: room + crew + place; unknown id 404', async () => {
    const r = await (await get(srv, '/api/crew/rooms/14')).json();
    assert.equal(r.code, 'D2-08');
    assert.equal(r.crew.length, 1);
    assert.deepEqual(r.crew[0], {
      name: 'Natalia Melnyk', rank: 'Bosman', department: 'Pokład',
      room: { code: 'D2-08', name: 'Magazyn bosmański', zone: CREW_ROOM_PLACES['D2-08'].zone }, since: T,
    }, 'room crew reduced to name, rank, department, room, since');
    assert.deepEqual(r.place, { zone: CREW_ROOM_PLACES['D2-08'].zone, at: CREW_ROOM_PLACES['D2-08'].at });
    assert.equal((await get(srv, '/api/crew/rooms/12345')).status, 404);
    assert.equal((await get(srv, '/api/crew/rooms/abc')).status, 404);
    assert.equal((await get(srv, '/api/crew/nope')).status, 404);
  });

  test('GET /api/crew/terminals adds place with terminalAt()', async () => {
    const ts = await (await get(srv, '/api/crew/terminals')).json();
    assert.equal(ts.length, TERMINALS.length);
    for (const t of ts) {
      const at = terminalAt(t.room_code, t.code);
      if (at) assert.deepEqual(t.place, { zone: CREW_ROOM_PLACES[t.room_code].zone, at });
      else assert.equal(t.place, null);
    }
    assert.notDeepEqual(ts[0].place.at, ts[1].place.at, 'second reader in a room is offset');
  });

  test('GET /api/crew/crew?q= passes the query through, people reduced to the map fields', async () => {
    const all = await (await get(srv, '/api/crew/crew')).json();
    assert.equal(all.length, CREW.length, 'no q: the whole list the map polls');
    const some = await (await get(srv, '/api/crew/crew?q=bosman')).json();
    assert.equal(some.length, 1);
    assert.deepEqual(some[0], {
      name: 'Natalia Melnyk', rank: 'Bosman', department: 'Pokład',
      room: { code: 'D2-08', name: 'Magazyn bosmański', zone: CREW_ROOM_PLACES['D2-08'].zone }, since: T,
    });
    const ashore = all.find((c: any) => c.name === 'Ola Nowak');
    assert.equal(ashore.room, null);
    for (const c of all) assert.deepEqual(Object.keys(c).sort(), ['department', 'name', 'rank', 'room', 'since'], 'only public fields');
    assert.ok(crew.hits.includes('GET /api/crew?q=bosman'));
  });

  test('GET /api/crew/crew: q shorter than 2 characters or with % / _ -> 400, never reaches the database', async () => {
    const before = crew.hits.length;
    for (const q of ['', ' ', 'a', ' b ', '%', '_', 'a%', 'an_a', '%%', '__']) {
      const r = await get(srv, '/api/crew/crew?q=' + encodeURIComponent(q));
      assert.equal(r.status, 400, `q=${JSON.stringify(q)}`);
      assert.deepEqual(await r.json(), { error: 'bad query' });
    }
    assert.equal(crew.hits.length, before, 'refused queries never hit the crew server');
    assert.equal((await get(srv, '/api/crew/crew?q=an')).status, 200);
  });

  test('responses are cached ~3 s per path', async () => {
    const before = crew.hits.filter((h) => h === 'GET /api/activity').length;
    await get(srv, '/api/crew/activity');
    await get(srv, '/api/crew/activity');
    const after = crew.hits.filter((h) => h === 'GET /api/activity').length;
    assert.ok(after - before <= 1, `upstream hit ${after - before} times`);
  });

  test('never proxies POST (or other writes)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/api/crew/checkin', '/api/crew/summary']) {
        const r = await fetch(srv.base + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
          body: method === 'DELETE' ? undefined : JSON.stringify({ badge: 'B-1006', terminal: 'T-D1-01-A' }) });
        assert.ok(r.status === 405 || r.status === 404, `${method} ${p} -> ${r.status}`);
      }
    }
    assert.equal((await get(srv, '/api/crew/checkin')).status, 404);
    assert.ok(!crew.hits.some((h) => !h.startsWith('GET ')), 'crew server got a non-GET: ' + crew.hits.join(', '));
    assert.ok(!crew.hits.some((h) => h.includes('checkin')), 'checkin never reached the crew server');
  });

  test('foreign Origin -> 403; localhost dev origin gets CORS', async () => {
    assert.equal((await get(srv, '/api/crew/summary', { origin: 'https://evil.example.com' })).status, 403);
    const ok = await get(srv, '/api/crew/summary', { origin: 'http://localhost:5173' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('own rate limit (120/min/IP), separate from the chat limit', async () => {
    const ip = '10.41.0.1';
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 125; i++) {
      const r = await get(srv, '/api/crew/summary', { 'x-forwarded-for': ip });
      statuses.push(r.status);
      if (r.status === 429 && !limited) limited = r; else await r.arrayBuffer();
    }
    assert.ok(statuses.slice(0, 120).every((s) => s === 200), 'first 120 pass');
    assert.ok(limited, 'got a 429');
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'retry-after');
    assert.equal((await limited.json()).error, 'rate limited');
    // chat from the same IP is unaffected
    const c = await post(srv, '/api/chat', ask('Pożar w kabinach'), { 'x-forwarded-for': ip });
    assert.equal(c.status, 200);
    // and the other way round: a chat-limited IP can still read the crew data
    const ip2 = '10.41.0.2';
    let chat429 = false;
    for (let i = 0; i < 22; i++) {
      const r = await post(srv, '/api/chat', ask('Pytanie'), { 'x-forwarded-for': ip2 });
      if (r.status === 429) chat429 = true;
      await r.arrayBuffer();
    }
    assert.ok(chat429, 'chat limit hit');
    assert.equal((await get(srv, '/api/crew/rooms', { 'x-forwarded-for': ip2 })).status, 200);
  });

  test('logged in as the Kapitan of the fake crew DB', () => { assert.ok(srv.cookie, 'login failed:\n' + srv.log.join('')); });

  test('without a session: proxy 401 for every data path, never reaches the crew DB', async () => {
    const n = crew.hits.length;
    for (const p of ['summary', 'rooms', 'rooms/14', 'crew', 'crew?q=bosman', 'terminals', 'activity', 'alerts']) {
      const r = await get(srv, '/api/crew/' + p, { cookie: '' });
      assert.equal(r.status, 401, p);
      assert.deepEqual(await r.json(), { error: 'login required' });
    }
    assert.equal((await get(srv, '/api/crew/summary', { cookie: 'ju_session=' + 'x'.repeat(43) })).status, 401, 'forged cookie');
    assert.equal(crew.hits.length, n);
  });

  test('without a session the chat crew tools answer "login required" (no crew data in the reply)', async () => {
    const n = crew.hits.length;
    const j = await (await post(srv, '/api/chat', ask('FAKE_TOOL gdzie jest bosman?'), { cookie: '' })).json();
    const text = j.text.join(' ');
    assert.match(text, /login required/);
    assert.doesNotMatch(text, /Natalia Melnyk|Magazyn bosmański/);
    assert.deepEqual(j.actions, []);
    const ev = await readSSE(await post(srv, '/api/chat/stream', ask('FAKE_TOOL gdzie jest bosman?'), { cookie: '' }));
    assert.equal(ev[ev.length - 1].event, 'done');
    assert.doesNotMatch(JSON.stringify(ev), /Natalia Melnyk/);
    assert.equal(crew.hits.length, n, 'the tool did not query the crew DB');
  });

  test('FAKE_TOOL through /api/chat: find_crew result reflected in the answer, ROUTE to the zone', async () => {
    const hits0 = crew.hits.length;
    const r = await post(srv, '/api/chat', ask('FAKE_TOOL gdzie jest bosman?'));
    assert.equal(r.status, 200);
    const j = await r.json();
    const text = j.text.join('\n');
    assert.match(text, /Natalia Melnyk/);
    assert.match(text, /Bosman/);
    assert.match(text, /Magazyn bosmański/);
    assert.match(text, /od 4[0-9] min/, 'minutes since check-in');
    checkNoMarkers(j.text);
    assert.equal(j.fallback, false);
    assert.deepEqual(j.actions.filter((a: any) => a.type === 'route').map((a: any) => a.zone), [CREW_ROOM_PLACES['D2-08'].zone]);
    // (the list may come from the proxy's 3 s cache of an earlier test; the names above can only come from the tool)
    assert.ok(hits0 >= 0 && crew.hits.some((h) => h === 'GET /api/crew'), 'tool fetched the crew list');
  });

  test('FAKE_TOOL through /api/chat/stream: deltas from both rounds, no marker leaks, done == /api/chat', async () => {
    const rs = await post(srv, '/api/chat/stream', ask('FAKE_TOOL gdzie jest bosman?'));
    assert.equal(rs.status, 200);
    const ev = await readSSE(rs);
    const names = ev.map((e) => e.event);
    assert.ok(!names.includes('error'), JSON.stringify(ev));
    assert.equal(names[names.length - 1], 'done');
    const deltas = ev.filter((e) => e.event === 'delta').map((e) => e.json.text as string);
    checkNoMarkers(deltas);
    const streamed = deltas.join('');
    assert.doesNotMatch(streamed, /ROUTE:|find_crew|"query"|tool_use/, 'no marker or tool input in deltas');
    assert.match(streamed, /Sprawdzam w bazie załogi/);
    assert.match(streamed, /Natalia Melnyk/);
    const done = ev[ev.length - 1].json;
    assert.equal(streamed.replace(/\s+/g, ' ').trim(), done.text.join('\n\n').replace(/\s+/g, ' ').trim());
    const j = await (await post(srv, '/api/chat', ask('FAKE_TOOL gdzie jest bosman?'))).json();
    assert.deepEqual(done.text.map((t: string) => t.replace(/\d+ min/, 'N min')), j.text.map((t: string) => t.replace(/\d+ min/, 'N min')));
    assert.deepEqual(done.actions, j.actions);
  });

  test('without FAKE_TOOL the chat does not touch the crew database', async () => {
    const n = crew.hits.length;
    const j = await (await post(srv, '/api/chat', ask('Pożar w maszynowni'))).json();
    assert.ok(j.text.length > 0);
    assert.equal(crew.hits.length, n);
  });
});

// ---------- crew database down / off ----------
describe('crew link: database down', () => {
  let srv: Srv;
  before(async () => {
    // the crew DB was reachable before: the roster cached in accounts.json lets the crew log in while it is down
    const authDir = mkdtempSync(path.join(tmpdir(), 'crew-down-auth-'));
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, 'accounts.json'), JSON.stringify({ version: 1, syncedAt: new Date().toISOString(), pins: {},
      members: [{ id: 1, name: 'Bartosz Kozłowski', rank: 'Kapitan', department: 'Pokład', role: 'captain', rfid: null, rfidType: null }] }));
    srv = await startServer({ CREW_API: `http://127.0.0.1:${await freePort()}`, AUTH_DIR: authDir });
  });

  test('login works from the cached roster while the crew DB is down', () => { assert.ok(srv.cookie, srv.log.join('')); });
  after(async () => { await stop(srv); });

  test('proxy answers 503 {error:"crew database unavailable"}', async () => {
    for (const p of ['summary', 'rooms', 'rooms/1', 'crew?q=xy', 'terminals', 'activity', 'alerts']) {
      const r = await get(srv, '/api/crew/' + p);
      assert.equal(r.status, 503, p);
      assert.deepEqual(await r.json(), { error: 'crew database unavailable' });
    }
  });

  test('FAKE_TOOL: tool error result -> Mewka says the database is unavailable (chat + stream)', async () => {
    const r = await post(srv, '/api/chat', ask('FAKE_TOOL gdzie jest bosman?'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.text.join(' '), /niedostępna/);
    assert.match(j.text.join(' '), /crew database unavailable/);
    assert.deepEqual(j.actions, []);
    const ev = await readSSE(await post(srv, '/api/chat/stream', ask('FAKE_TOOL gdzie jest bosman?')));
    assert.equal(ev[ev.length - 1].event, 'done');
    assert.match(ev[ev.length - 1].json.text.join(' '), /niedostępna/);
    checkNoMarkers(ev.filter((e) => e.event === 'delta').map((e) => e.json.text));
  });
});

describe('crew link: CREW_API=off', () => {
  let srv: Srv;
  before(async () => { srv = await startServer({ CREW_API: 'off' }); });
  after(async () => { await stop(srv); });

  test('proxy 503, chat has no crew tools (FAKE_TOOL gets the normal answer)', async () => {
    assert.equal((await get(srv, '/api/crew/summary')).status, 503);
    const j = await (await post(srv, '/api/chat', ask('FAKE_TOOL gdzie jest bosman?'))).json();
    assert.match(j.text.join(' '), /Tryb testowy/);
    assert.doesNotMatch(j.text.join(' '), /Sprawdzam w bazie/);
  });
});

// ---------- runCrewTool directly (compact JSON, privacy, validation) ----------
describe('runCrewTool', () => {
  let crew: FakeCrew;
  let mod: typeof import('../server/crew.ts');
  before(async () => {
    crew = await startFakeCrew();
    process.env.CREW_API = crew.base;
    mod = await import('../server/crew.ts');
    // closed until server/auth.ts registers its check (see the auth tests); this suite tests the tool content
    const closed = await mod.runCrewTool('crew_summary', {});
    assert.equal(closed.isError, true);
    assert.match(closed.content, /login required/);
    mod.setCrewAccessCheck(() => true);
  });
  after(async () => { await new Promise((r) => crew.server.close(r)); });

  test('find_crew: where/since/cabin/phone, never birth date or nationality (no details flag)', async () => {
    const r = await mod.runCrewTool('find_crew', { query: 'bosman' });
    assert.equal(r.isError, false);
    const j = JSON.parse(r.content);
    assert.equal(j.matches, 1);
    const c = j.crew[0];
    assert.equal(c.name, 'Natalia Melnyk');
    assert.equal(c.where, 'Magazyn bosmański');
    assert.equal(c.zone, CREW_ROOM_PLACES['D2-08'].zone);
    assert.equal(c.phone_ext, '206');
    assert.ok(c.cabin);
    assert.ok(!('birth_date' in c) && !('nationality' in c), 'no private fields by default');
    assert.doesNotMatch(r.content, /2000-12-24|Ukraina/);
    const d = await mod.runCrewTool('find_crew', { query: 'bosman', details: true }); // the old flag: ignored
    assert.doesNotMatch(d.content, /birth_date|nationality|2000-12-24|Ukraina/);
    const tool = mod.CREW_TOOLS.find((t: any) => t.name === 'find_crew') as any;
    assert.deepEqual(Object.keys(tool.input_schema.properties), ['query'], 'no details parameter in the tool schema');
  });

  test('find_crew folds case and Polish diacritics, all words must match', async () => {
    const a = JSON.parse((await mod.runCrewTool('find_crew', { query: 'lukasz zak' })).content);
    assert.equal(a.crew[0]?.name, 'Łukasz Żak');
    const b = JSON.parse((await mod.runCrewTool('find_crew', { query: 'B-1001' })).content);
    assert.equal(b.crew[0]?.rank, 'Kapitan');
    const ashore = JSON.parse((await mod.runCrewTool('find_crew', { query: 'nowak' })).content).crew[0];
    assert.equal(ashore.on_board, false);
    assert.equal(ashore.where, null);
  });

  test('room_people by code and by name fragment; unknown room lists the rooms', async () => {
    const a = JSON.parse((await mod.runCrewTool('room_people', { room: 'd2-08' })).content);
    assert.equal(a.found, true);
    assert.equal(a.name, 'Magazyn bosmański');
    assert.equal(a.capacity, 4);
    assert.deepEqual(a.crew.map((c: any) => c.name), ['Natalia Melnyk']);
    assert.doesNotMatch(JSON.stringify(a), /birth_date|nationality/);
    const b = JSON.parse((await mod.runCrewTool('room_people', { room: 'maszynownia' })).content);
    assert.equal(b.code, 'D1-01');
    assert.equal(b.hazardous, true);
    const c = JSON.parse((await mod.runCrewTool('room_people', { room: 'basen' })).content);
    assert.equal(c.found, false);
    assert.ok(c.rooms.length === ROOMS.length);
  });

  test('crew_summary, safety_alerts, list_terminals are compact and carry zones', async () => {
    const s = JSON.parse((await mod.runCrewTool('crew_summary', {})).content);
    assert.equal(s.onboard, 3);
    assert.equal(s.people_by_zone.bridge, 1);
    const a = JSON.parse((await mod.runCrewTool('safety_alerts', {})).content);
    assert.equal(a.understaffed[0].code, 'D4-01');
    assert.equal(a.understaffed[0].zone, 'bridge');
    assert.equal(a.lone_workers[0].person, 'Łukasz Żak (II mechanik)');
    assert.equal(a.stale_checkins[0].name, 'Natalia Melnyk');
    const t = JSON.parse((await mod.runCrewTool('list_terminals', {})).content);
    assert.equal(t.terminals.length, TERMINALS.length);
    assert.equal(t.terminals[0].zone, 'engine-room');
    assert.equal(t.terminals[2].zone, null);
  });

  test('bad input and unknown tools come back as is_error results', async () => {
    for (const [name, input] of [['find_crew', {}], ['find_crew', { query: 42 }],
      ['room_people', null], ['room_people', { room: '' }], ['drop_tables', {}]] as const) {
      const r = await mod.runCrewTool(name, input);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(input)}`);
      assert.ok(JSON.parse(r.content).error);
    }
  });
});

// ---------- smoke test against the real crew server (if it runs) ----------
describe('crew link: REAL crew server on :8790 (smoke, proxy only)', async () => {
  const REAL = 'http://127.0.0.1:8790';
  const up = await fetch(REAL + '/api/summary', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  let srv: Srv;
  before(async () => { if (up) srv = await startServer({ CREW_API: REAL }); });
  after(async () => { await stop(srv); });

  test('proxy rooms/terminals/summary/alerts from the real database', { skip: !up && 'crew server not running on :8790' }, async () => {
    const s = await (await get(srv, '/api/crew/summary')).json();
    assert.equal(typeof s.crew, 'number');
    const rooms = await (await get(srv, '/api/crew/rooms')).json();
    assert.ok(rooms.length > 0);
    assert.ok(rooms.every((r: any) => 'place' in r));
    assert.ok(rooms.filter((r: any) => r.place).length >= 1, 'some rooms are on the map');
    for (const r of rooms) if (CREW_ROOM_PLACES[r.code]) assert.equal(r.place.zone, CREW_ROOM_PLACES[r.code].zone);
    const ts = await (await get(srv, '/api/crew/terminals')).json();
    assert.ok(ts.length > 0 && ts.every((t: any) => 'place' in t));
    const one = await (await get(srv, `/api/crew/rooms/${rooms[0].id}`)).json();
    assert.ok(Array.isArray(one.crew));
    assert.equal(one.place?.zone ?? null, CREW_ROOM_PLACES[one.code]?.zone ?? null);
    const people = await (await get(srv, '/api/crew/crew')).json();
    assert.ok(people.length > 0 && people.every((c: any) => 'since' in c && !('birth_date' in c) && !('nationality' in c) && !('badge' in c)));
    const a = await (await get(srv, '/api/crew/alerts')).json();
    assert.ok(Array.isArray(a.staffing));
  });
});
