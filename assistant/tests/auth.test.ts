// Crew accounts + login (server/auth.ts, docs/ACCOUNTS.md). Harness like alarms.test.ts: a node http server with the
// crew proxy + alarm HTTP, attachAlarms() (which also attaches auth: /api/auth/* and the request context), a fake crew
// DB with RFID tags, and Node's WebSocket client (with a Cookie header) as the alarm terminals.
// PINs are generated for real here (no ACCOUNTS_DEMO_PIN) and read back from the one-off demo-pins.txt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMsg } from '../shared/alarms.ts';

const CREW = [
  { id: 1, badge: 'B-1001', rfid_uid: '04:A3:1F:5B:C2:6E:80', rfid_type: 'karta', first_name: 'Bartosz', last_name: 'Kozłowski', rank: 'Kapitan', department: 'Pokład' },
  { id: 2, badge: 'B-1002', rfid_uid: null, rfid_type: null, first_name: 'Anna', last_name: 'Wiśniewska', rank: 'Starszy oficer', department: 'Pokład' },
  { id: 3, badge: 'B-1003', rfid_uid: 'DE:AD:BE:EF', rfid_type: 'opaska', first_name: 'Jan', last_name: 'Kowal', rank: 'Motorzysta', department: 'Maszynownia' },
  { id: 4, badge: 'B-1004', rfid_uid: null, rfid_type: null, first_name: 'Łukasz', last_name: 'Żak', rank: 'II mechanik', department: 'Maszynownia' },
].map((c) => ({ ...c, shift: 'dzienna', nationality: 'Polska', birth_date: '1980-01-01', phone_ext: '200', cabin: 'x', room_id: 21,
  room_code: 'D4-01', room_name: 'Mostek nawigacyjny', since: new Date().toISOString() }));
const crewDb = createServer((req, res) => {
  const p = new URL(req.url || '/', 'http://x').pathname;
  const body = p === '/api/crew' ? CREW : p === '/api/rooms' ? [{ code: 'D4-01', name: 'Mostek', people: 2 }]
    : p === '/api/summary' ? { crew: 4, onboard: 4 } : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'Not found' }));
});

const dir = mkdtempSync(path.join(tmpdir(), 'auth-test-'));
let server: Server;
let base = '';
let wsBase = '';
let auth: typeof import('../server/auth.ts');
let crew: typeof import('../server/crew.ts');
let pinOf: Record<number, string> = {};

before(async () => {
  await new Promise<void>((r) => crewDb.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    CREW_API: `http://127.0.0.1:${(crewDb.address() as { port: number }).port}`,
    AUTH_DIR: path.join(dir, 'auth'), ALARMS_FILE: path.join(dir, 'alarms.json'), ALARMS_SAVE_MS: '50',
  });
  for (const k of ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS', 'ACCOUNTS_DEMO_PIN']) delete process.env[k];
  auth = await import('../server/auth.ts');
  crew = await import('../server/crew.ts');
  const alarms = await import('../server/alarms.ts');
  server = createServer(async (req, res) => {
    if (await crew.handleCrewProxy(req, res)) return;
    if (await alarms.handleAlarmHttp(req, res)) return;
    res.writeHead(404).end();
  });
  alarms.attachAlarms(server); // also attaches auth: no extra wiring in the harness, same as index.ts
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  // first roster request syncs the crew DB and generates the PINs
  assert.equal((await fetch(base + '/api/auth/roster')).status, 200);
  const txt = readFileSync(path.join(dir, 'auth', 'demo-pins.txt'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = /^(\d+)\t[^\t]+\t[^\t]+\t(\d{4,6})$/.exec(line);
    if (m) pinOf[Number(m[1])] = m[2];
  }
});

const open: WebSocket[] = [];
after(async () => {
  for (const ws of open) try { ws.close(); } catch { /* closed */ }
  await new Promise((r) => setTimeout(r, 50));
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => crewDb.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

let ipN = 1;
const freshIp = () => `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
function login(body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers }, body: JSON.stringify(body),
  });
}
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
async function loginPin(id: number) {
  const r = await login({ method: 'pin', id, pin: pinOf[id] });
  assert.equal(r.status, 200, `login ${id}`);
  return cookieOf(r);
}
const get = (p: string, cookie?: string) => fetch(base + p, { headers: { 'x-forwarded-for': freshIp(), ...(cookie ? { cookie } : {}) } });

// ---------- WebSocket terminal ----------
interface Term { ws: WebSocket; msgs: ServerMsg[]; next(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>; send(o: unknown): void }
function connect(cookie?: string): Promise<Term> {
  const ws = new (WebSocket as any)(`${wsBase}/api/alarms/ws`, cookie ? { headers: { cookie } } : undefined) as WebSocket;
  open.push(ws);
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  let seen = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const t: Term = {
    ws, msgs,
    next(pred, ms = 3000) {
      for (let i = seen; i < msgs.length; i++) if (pred(msgs[i])) { seen = i + 1; return Promise.resolve(msgs[i]); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout; got ' + JSON.stringify(msgs.slice(-4)))), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); seen = msgs.length; resolve(m); } });
      });
    },
    send(o) { ws.send(JSON.stringify(o)); },
  };
  return new Promise((resolve, reject) => { ws.onopen = () => resolve(t); ws.onerror = () => reject(new Error('ws error')); });
}
let termN = 0;
async function terminal(cookie: string | undefined, role: 'bridge' | 'crew' = 'bridge') {
  const t = await connect(cookie);
  t.send({ type: 'hello', terminalId: `T-AUTH-${++termN}`, name: `Terminal ${termN}`, role, zone: 'bridge' });
  const w = await t.next((m) => m.type === 'welcome');
  return Object.assign(t, { role: (w as Extract<ServerMsg, { type: 'welcome' }>).role, terminalId: `T-AUTH-${termN}` });
}
const isErr = (code: string) => (m: ServerMsg) => m.type === 'error' && m.code === code;
const drill = { type: 'raise', kind: 'fire', zone: 'cabins-aft', blocked: null, message: 'Ćwiczenie', drill: true };

// ---------- tests ----------
test('roles by rank: captain > bridge, engine, crew', () => {
  const r = auth.roleForRank;
  assert.equal(r('Kapitan'), 'captain');
  for (const k of ['Starszy oficer', 'II oficer', 'III oficer', 'Oficer radiowy', 'Oficer radiowy (GMDSS)']) assert.equal(r(k), 'bridge', k);
  for (const k of ['Starszy mechanik', 'II mechanik', 'IV mechanik', 'Elektryk']) assert.equal(r(k), 'engine', k);
  for (const k of ['Bosman', 'Marynarz AB', 'Kadet pokładowy', 'Kadet maszynowy', 'Motorzysta', 'Szef kuchni', 'Lekarz okrętowy', '']) assert.equal(r(k), 'crew', k);
  assert.ok(auth.hasRole('captain', ['bridge']));
  assert.ok(!auth.hasRole('engine', ['bridge']));
  assert.ok(!auth.hasRole('bridge', ['captain']));
});

test('roster: every crew member, role, no RFID / location; PINs stored hashed, plaintext list chmod 600', async () => {
  const j = await (await get('/api/auth/roster')).json();
  assert.equal(j.members.length, 4);
  assert.equal(j.live, true);
  assert.equal(j.rfid, true);
  const cap = j.members.find((m: any) => m.id === 1);
  assert.deepEqual(cap, { id: 1, name: 'Bartosz Kozłowski', rank: 'Kapitan', department: 'Pokład', role: 'captain' });
  assert.doesNotMatch(JSON.stringify(j), /rfid_uid|04A31F|DEADBEEF|D4-01|since|birth/);
  assert.equal(Object.keys(pinOf).length, 4, 'one PIN per member in demo-pins.txt');
  for (const p of Object.values(pinOf)) assert.match(p, /^\d{6}$/);
  const accounts = readFileSync(path.join(dir, 'auth', 'accounts.json'), 'utf8');
  for (const p of Object.values(pinOf)) assert.ok(!accounts.includes(`"${p}"`), 'plaintext PIN in accounts.json');
  assert.match(accounts, /"hash"/);
  for (const f of ['accounts.json', 'demo-pins.txt']) assert.equal(statSync(path.join(dir, 'auth', f)).mode & 0o777, 0o600, f);
});

test('login by PIN: cookie HttpOnly, SameSite=Strict, Path=/, 12 h, Secure only over https; /me', async () => {
  const r = await login({ method: 'pin', id: 1, pin: pinOf[1] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.name, 'Bartosz Kozłowski');
  assert.equal(j.user.role, 'captain');
  assert.equal(j.user.method, 'pin');
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /^ju_session=[A-Za-z0-9_-]{40,}; /);
  assert.match(sc, /; HttpOnly/);
  assert.match(sc, /; SameSite=Strict/);
  assert.match(sc, /; Path=\//);
  assert.match(sc, /; Max-Age=43200/);
  assert.doesNotMatch(sc, /Secure/);
  const me = await (await get('/api/auth/me', cookieOf(r))).json();
  assert.equal(me.user.id, 1);
  assert.deepEqual(await (await get('/api/auth/me')).json(), { user: null });
  // behind nginx with TLS (loopback peer + X-Forwarded-Proto: https)
  const s = await login({ method: 'pin', id: 1, pin: pinOf[1] }, { 'x-forwarded-proto': 'https' });
  assert.match(s.headers.get('set-cookie')!, /; Secure/);
  // the session file keeps only token hashes
  auth.flushAuth();
  const stored = readFileSync(path.join(dir, 'auth', 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(cookieOf(r).split('=')[1]), 'raw token in sessions.json');
});

test('login by RFID: reader formats normalised to hex, decimal readers, unknown card', async () => {
  for (const uid of ['04:A3:1F:5B:C2:6E:80', '04a31f5bc26e80', '04-A3-1F-5B-C2-6E-80', ' 04 A3 1F 5B C2 6E 80\n']) {
    const r = await login({ method: 'rfid', uid });
    assert.equal(r.status, 200, uid);
    const j = await r.json();
    assert.equal(j.user.id, 1);
    assert.equal(j.user.method, 'rfid');
  }
  for (const uid of ['DEADBEEF', String(0xDEADBEEF), String(0xEFBEADDE)]) { // hex, decimal, decimal of the reversed bytes
    const r = await login({ method: 'rfid', uid });
    assert.equal(r.status, 200, uid);
    assert.equal((await r.json()).user.name, 'Jan Kowal');
  }
  const bad = await login({ method: 'rfid', uid: '01:02:03:04:05:06:07' });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'unknown-card' });
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.equal((await login({ method: 'rfid', uid: 'xyz' })).status, 400);
});

test('wrong PIN: 401 with attempts left, 5th locks the account (even the right PIN), other accounts unaffected', async () => {
  const wrong = pinOf[4] === '000000' ? '000001' : '000000';
  for (let i = 1; i <= 4; i++) {
    const r = await login({ method: 'pin', id: 4, pin: wrong });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'bad-credentials', left: 5 - i });
  }
  const locked = await login({ method: 'pin', id: 4, pin: wrong });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'locked');
  const right = await login({ method: 'pin', id: 4, pin: pinOf[4] });
  assert.equal(right.status, 429, 'locked account refuses the right PIN too');
  assert.ok(Number(right.headers.get('retry-after')) > 60);
  assert.equal((await login({ method: 'pin', id: 2, pin: pinOf[2] })).status, 200);
  // unknown id: same answer as a wrong PIN; malformed PIN: 400
  assert.equal((await login({ method: 'pin', id: 999, pin: '123456' })).status, 401);
  assert.equal((await login({ method: 'pin', id: 1, pin: '12' })).status, 400);
  assert.equal((await login({ method: 'pin', id: 1, pin: '12a456' })).status, 400);
});

test('per-IP login limit; origin, content-type and method checks', async () => {
  const ip = '10.78.0.1';
  const st: number[] = [];
  for (let i = 0; i < 12; i++) st.push((await login({ method: 'rfid', uid: '0102030405060708' }, { 'x-forwarded-for': ip })).status);
  assert.deepEqual(st.slice(0, 10), Array(10).fill(401));
  assert.equal(st[11], 429);
  assert.equal((await login({ method: 'pin', id: 1, pin: pinOf[1] }, { origin: 'https://evil.example' })).status, 403);
  const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: 'method=pin&id=1&pin=' + pinOf[1] });
  assert.equal(form.status, 415);
  assert.equal((await get('/api/auth/login')).status, 405);
  assert.equal((await get('/api/auth/nope')).status, 404);
});

test('/api/crew/* needs a session: 401 without (or with a forged cookie), 200 with', async () => {
  const no = await get('/api/crew/summary');
  assert.equal(no.status, 401);
  assert.deepEqual(await no.json(), { error: 'login required' });
  assert.equal((await get('/api/crew/crew', 'ju_session=' + 'A'.repeat(43))).status, 401);
  const c = await loginPin(3); // any role may read
  const ok = await get('/api/crew/summary', c);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { crew: 4, onboard: 4 });
  const people = await (await get('/api/crew/crew', c)).json();
  assert.equal(people.length, 4);
  assert.doesNotMatch(JSON.stringify(people), /rfid|DEADBEEF/);
});

test('alarms over WebSocket: role from the session cookie, not from hello', async () => {
  const anon = await terminal(undefined, 'bridge');
  assert.equal(anon.role, 'crew', 'no login: hello role bridge is downgraded');
  anon.send(drill);
  await anon.next(isErr('forbidden'));

  const motorman = await terminal(await loginPin(3), 'bridge');
  assert.equal(motorman.role, 'crew', 'Motorzysta asked for bridge');
  motorman.send(drill);
  await motorman.next(isErr('forbidden'));

  const captainCookie = await loginPin(1);
  const cap = await terminal(captainCookie, 'bridge');
  assert.equal(cap.role, 'bridge');
  cap.send(drill);
  const st = await cap.next((m) => m.type === 'state' && m.reason === 'raised') as Extract<ServerMsg, { type: 'state' }>;
  const a = st.state.active!;
  assert.match(a.raisedBy, /Bartosz Kozłowski, Kapitan/);
  assert.match(a.raisedBy, /Terminal \d+/);
  assert.equal(a.acks[cap.terminalId].user, 'Bartosz Kozłowski, Kapitan');

  // ack: the logged-in user is recorded, whatever the form says
  motorman.send({ type: 'ack', alarmId: a.id, user: 'Ktoś inny', headcount: 3 });
  const acked = await motorman.next((m) => m.type === 'state' && m.reason === 'ack') as Extract<ServerMsg, { type: 'state' }>;
  assert.equal(acked.state.active!.acks[motorman.terminalId].user, 'Jan Kowal, Motorzysta');
  // an anonymous terminal may still acknowledge (every screen must be able to), its free text stays
  anon.send({ type: 'ack', alarmId: a.id, user: 'Gość' });
  const acked2 = await anon.next((m) => m.type === 'state' && m.reason === 'ack' && !!m.state.active?.acks[anon.terminalId]) as Extract<ServerMsg, { type: 'state' }>;
  assert.equal(acked2.state.active!.acks[anon.terminalId].user, 'Gość');

  // the bridge officer (not captain) may end it
  const officer = await terminal(await loginPin(2), 'bridge');
  assert.equal(officer.role, 'bridge');
  officer.send({ type: 'end', alarmId: a.id });
  const ended = await officer.next((m) => m.type === 'state' && m.reason === 'ended') as Extract<ServerMsg, { type: 'state' }>;
  assert.equal(ended.state.active, null);
  for (const t of [anon, motorman, cap, officer]) t.ws.close();
});

test('logout: cookie cleared, /me null, crew 401, an open bridge socket loses the right at once', async () => {
  const c = await loginPin(1);
  const cap = await terminal(c, 'bridge');
  assert.equal(cap.role, 'bridge');
  const out = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: c, 'x-forwarded-for': freshIp() } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie')!, /^ju_session=; .*Max-Age=0/);
  assert.deepEqual(await (await get('/api/auth/me', c)).json(), { user: null });
  assert.equal((await get('/api/crew/summary', c)).status, 401);
  cap.send(drill);
  await cap.next(isErr('forbidden'));
  cap.ws.close();
});

test('crew chat tools answer only inside a logged-in request context', async () => {
  const outside = await crew.runCrewTool('crew_summary', {});
  assert.equal(outside.isError, true);
  assert.match(outside.content, /login required/);
  const anon = await auth.runWithRequest({ headers: {} } as IncomingMessage, () => crew.runCrewTool('find_crew', { query: 'Kowal' }));
  assert.equal(anon.isError, true);
  const c = await loginPin(3);
  const inside = await auth.runWithRequest({ headers: { cookie: c } } as IncomingMessage, () => crew.runCrewTool('find_crew', { query: 'Kowal' }));
  assert.equal(inside.isError, false);
  assert.equal(JSON.parse(inside.content).crew[0].name, 'Jan Kowal');
});
