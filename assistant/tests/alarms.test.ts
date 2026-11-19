// Ship alarm system (server/alarms.ts, docs/ALARMS.md). A tiny harness: node http server + attachAlarms + handleAlarmHttp
// (+ the real crew-video WebSocket attached AFTER us, to prove both share the 'upgrade' event), a fake crew DB for the
// muster accountability, and Node's built-in WebSocket client as the terminals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AlarmState, ServerMsg } from '../shared/alarms.ts';

// ---------- fake crew DB: people per room ----------
const ROOMS = [
  { code: 'D4-01', name: 'Mostek nawigacyjny', people: 3 },   // bridge -> muster B
  { code: 'D3-02', name: 'Kabiny załogi blok A', people: 5 }, // cabins-mid -> muster A
  { code: 'D2-07', name: 'Szpital okrętowy', people: 2 },     // lounge -> muster B
  { code: 'X9-99', name: 'spoza mapy', people: 7 },           // not on our ship map: ignored
];
const crew = createServer((req, res) => {
  res.writeHead(req.url === '/api/rooms' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(req.url === '/api/rooms' ? JSON.stringify(ROOMS) : '{"error":"Not found"}');
});

const dir = mkdtempSync(path.join(tmpdir(), 'alarms-test-'));
const FILE = path.join(dir, 'data', 'alarms.json');
let server: Server;
let base = '';
let wsBase = '';
let mod: typeof import('../server/alarms.ts');

before(async () => {
  await new Promise<void>((r) => crew.listen(0, '127.0.0.1', r));
  process.env.CREW_API = `http://127.0.0.1:${(crew.address() as { port: number }).port}`;
  process.env.ALARMS_FILE = FILE;
  process.env.ALARMS_SAVE_MS = '50';
  for (const k of ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS']) delete process.env[k];
  mod = await import('../server/alarms.ts');
  const { attachCrewVideoWebSocket } = await import('../server/crew-video.ts');
  server = createServer(async (req, res) => {
    if (await mod.handleAlarmHttp(req, res)) return;
    res.writeHead(404).end();
  });
  mod.attachAlarms(server);
  attachCrewVideoWebSocket(server); // after us on purpose: its listener destroys every path that is not its own
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

const open: WebSocket[] = [];
after(async () => {
  for (const ws of open) try { ws.close(); } catch { /* closed */ }
  await new Promise((r) => setTimeout(r, 50));
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => crew.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

// ---------- terminal client ----------
interface Term {
  ws: WebSocket;
  msgs: ServerMsg[];
  closed: Promise<number>;
  next(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
  send(o: unknown): void;
}
function connect(): Promise<Term> {
  const ws = new WebSocket(`${wsBase}/api/alarms/ws`);
  open.push(ws);
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  let seen = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
  const t: Term = {
    ws, msgs, closed,
    // resolves with the first matching message not consumed before (includes ones already received)
    next(pred, ms = 3000) {
      for (let i = seen; i < msgs.length; i++) if (pred(msgs[i])) { seen = i + 1; return Promise.resolve(msgs[i]); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout; got ' + JSON.stringify(msgs.slice(-5)))), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); seen = msgs.length; resolve(m); } });
      });
    },
    send(o) { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); },
  };
  return new Promise((resolve, reject) => { ws.onopen = () => resolve(t); ws.onerror = () => reject(new Error('ws error')); });
}
let idN = 0;
async function terminal(role: 'bridge' | 'crew', zone: string | null = null, extra: Record<string, unknown> = {}) {
  const t = await connect();
  const terminalId = `T-TEST-${role}-${++idN}`;
  t.send({ type: 'hello', terminalId, name: `${role === 'bridge' ? 'Mostek' : 'Kabiny'} ${idN}`, role, zone, ...extra });
  const w = await t.next((m) => m.type === 'welcome');
  assert.equal(w.type, 'welcome');
  return Object.assign(t, { terminalId });
}
const isErr = (code: string) => (m: ServerMsg) => m.type === 'error' && m.code === code;
const stateWith = (reason: string) => (m: ServerMsg) => m.type === 'state' && m.reason === reason;
const drill = { type: 'raise', kind: 'fire', zone: 'cabins-aft', blocked: 'stair-aft', message: 'Pożar w kabinie 104', drill: true };

// ---------- tests ----------
test('crew role cannot raise or end; real alarm needs confirm', async () => {
  const c = await terminal('crew', 'cabins-mid');
  c.send(drill);
  await c.next(isErr('forbidden'));
  c.send({ type: 'end', alarmId: '00000000-0000-4000-8000-000000000000' });
  await c.next(isErr('forbidden'));
  const b = await terminal('bridge', 'bridge');
  b.send({ ...drill, drill: false });
  await b.next(isErr('confirm'));
  c.ws.close(); b.ws.close();
});

test('bridge raises, two terminals receive it, crew acks with reaction time and headcount, muster table, bridge ends', async () => {
  const b = await terminal('bridge', 'bridge');
  const c1 = await terminal('crew', 'cabins-mid');
  const c2 = await terminal('crew', null, { place: 'D2-07' }); // zone from the crew map: lounge
  b.send(drill);
  const [s1, s2] = await Promise.all([c1.next(stateWith('raised')), c2.next(stateWith('raised'))]);
  for (const s of [s1, s2]) {
    assert.equal(s.type, 'state');
    const a = (s as { state: AlarmState }).state.active!;
    assert.equal(a.kind, 'fire');
    assert.equal(a.drill, true);
    assert.equal(a.zone, 'cabins-aft');
    assert.equal(a.blocked, 'stair-aft');
    assert.equal(a.message, 'Pożar w kabinie 104');
    assert.ok(a.raisedBy.startsWith('Mostek'));
    assert.ok(a.acks[b.terminalId], 'raiser is acknowledged at once');
  }
  const alarm = (s1 as { state: AlarmState }).state.active!;
  assert.equal((s2 as { state: AlarmState }).state.terminals.find((t) => t.terminalId === c2.terminalId)?.zone, 'lounge');

  await new Promise((r) => setTimeout(r, 30));
  c1.send({ type: 'ack', alarmId: alarm.id, user: 'Jan Kowalski', headcount: 4 });
  const ackState = (await b.next((m) => m.type === 'state' && !!m.state.active?.acks[c1.terminalId])) as { state: AlarmState };
  const ack = ackState.state.active!.acks[c1.terminalId];
  const reaction = Date.parse(ack.at) - Date.parse(alarm.at);
  assert.ok(reaction >= 30, `reaction ${reaction} ms`);
  assert.equal(ack.user, 'Jan Kowalski');
  assert.equal(ack.headcount, 4);
  // a second ack keeps the first time
  c1.send({ type: 'ack', alarmId: alarm.id });
  const again = (await b.next(stateWith('ack'))) as { state: AlarmState };
  assert.equal(again.state.active!.acks[c1.terminalId].at, ack.at);

  // muster accountability with the crew DB numbers (aft stair blocked: cabins-mid detours to the forward stair -> muster B)
  const crewReady = (m: ServerMsg) => m.type === 'state' && !!m.state.muster?.crewOnline && !!m.state.active?.acks[c1.terminalId];
  const withCrew = (b.msgs.findLast(crewReady) ?? await b.next(crewReady, 4000)) as { state: AlarmState };
  const muster = withCrew.state.muster!;
  const zoneRow = (z: string) => muster.rows.flatMap((r) => r.zones.map((x) => ({ ...x, station: r.station }))).find((x) => x.zone === z);
  assert.deepEqual({ ...zoneRow('cabins-mid') }, { zone: 'cabins-mid', expected: 5, terminals: 1, acked: 1, reported: 4, station: 'muster-b' });
  assert.equal(zoneRow('bridge')!.expected, 3);
  assert.equal(zoneRow('bridge')!.acked, 1);
  assert.equal(zoneRow('lounge')!.acked, 0);
  assert.equal(muster.rows.find((r) => r.station === 'muster-b')!.expected, 10);

  c2.send({ type: 'end', alarmId: alarm.id });
  await c2.next(isErr('forbidden'));
  b.send({ type: 'end', alarmId: alarm.id });
  const ended = (await c2.next(stateWith('ended'))) as { state: AlarmState };
  assert.equal(ended.state.active, null);
  b.send({ type: 'end', alarmId: alarm.id });
  await b.next(isErr('no-alarm'));
  c1.send({ type: 'ack', alarmId: alarm.id });
  await c1.next(isErr('no-alarm'));

  // log: HTTP + file
  const r = await fetch(`${base}/api/alarms/log?limit=5`);
  assert.equal(r.status, 200);
  const { alarms } = (await r.json()) as { alarms: AlarmState['active'][] };
  const logged = alarms.find((a) => a!.id === alarm.id)!;
  assert.equal(logged.endReason, 'ended');
  assert.ok(logged.endedAt);
  mod.flushAlarms();
  const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { log: { id: string; acks: Record<string, unknown>; endedAt: string }[] };
  const fromFile = saved.log.find((a) => a.id === alarm.id)!;
  assert.ok(fromFile.endedAt);
  assert.ok(fromFile.acks[c1.terminalId]);
  const st = (await (await fetch(`${base}/api/alarms/state`)).json()) as AlarmState;
  assert.equal(st.active, null);
  for (const t of [b, c1, c2]) t.ws.close();
});

test('a new alarm replaces the active one; a fresh connection gets the snapshot', async () => {
  const b = await terminal('bridge', 'bridge');
  b.send({ type: 'raise', kind: 'general', zone: null, blocked: null, message: '', drill: true });
  const first = ((await b.next(stateWith('raised'))) as { state: AlarmState }).state.active!;
  b.send({ type: 'raise', kind: 'abandon', zone: null, blocked: null, message: 'Do szalup', drill: false, confirm: true });
  const second = ((await b.next(stateWith('raised'))) as { state: AlarmState }).state.active!;
  assert.equal(second.kind, 'abandon');
  assert.equal(second.drill, false);
  const late = await connect();
  late.send({ type: 'hello', terminalId: 'T-LATE-1', name: 'Spóźniony', role: 'crew', zone: 'vehicle-d1' });
  const w = (await late.next((m) => m.type === 'welcome')) as { state: AlarmState };
  assert.equal(w.state.active!.id, second.id);
  const { alarms } = (await (await fetch(`${base}/api/alarms/log?limit=2`)).json()) as { alarms: { id: string; endReason?: string }[] };
  assert.deepEqual(alarms.map((a) => a.id), [second.id, first.id]);
  assert.equal(alarms[1].endReason, 'replaced');
  b.send({ type: 'end', alarmId: second.id });
  await late.next(stateWith('ended'));
  b.ws.close(); late.ws.close();
});

test('validation: hello, raise fields, message length, ack before hello, HTTP limit', async () => {
  const t = await connect();
  t.send({ type: 'raise', ...drill });
  await t.next(isErr('not-hello'));
  t.send({ type: 'hello', terminalId: 'x', name: 'A', role: 'admin' });
  await t.next(isErr('invalid'));
  t.send('not json');
  await t.next(isErr('json'));
  t.send({ type: 'nope' });
  await t.next(isErr('unknown'));
  t.ws.close();

  const b = await terminal('bridge', 'bridge');
  b.send({ ...drill, kind: 'party' });
  await b.next(isErr('invalid'));
  b.send({ ...drill, zone: 'pool' });
  await b.next(isErr('invalid'));
  b.send({ ...drill, drill: 'yes' });
  await b.next(isErr('invalid'));
  b.send({ ...drill, message: 'x'.repeat(201) });
  await b.next(isErr('too-long'));
  b.send({ type: 'hello', terminalId: 'T-AGAIN', name: 'Again', role: 'bridge' });
  await b.next(isErr('hello-twice'));
  b.send({ type: 'ack', alarmId: 'not-a-uuid' });
  await b.next(isErr('invalid'));
  b.ws.close();

  assert.equal((await fetch(`${base}/api/alarms/log?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/alarms/log?limit=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/alarms/other`)).status, 404);
  assert.equal((await fetch(`${base}/api/alarms/state`, { method: 'POST' })).status, 405);
});

test('oversize frame closes the connection (1009)', async () => {
  const t = await terminal('crew');
  t.send({ type: 'ack', alarmId: '00000000-0000-4000-8000-000000000000', user: 'x'.repeat(5000) });
  assert.equal(await t.closed, 1009);
});

test('foreign Origin is refused (WebSocket 403, HTTP 403)', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/alarms/ws`, { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), origin: 'https://evil.example',
    } });
    req.on('upgrade', () => resolve(101));
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  const r = await fetch(`${base}/api/alarms/state`, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const ok = await fetch(`${base}/api/alarms/state`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(ok.status, 200);
});

test('per-connection rate limit', async () => {
  const t = await terminal('crew');
  for (let i = 0; i < 40; i++) t.send({ type: 'ping' });
  await t.next(isErr('rate'));
  const pongs = t.msgs.filter((m) => m.type === 'pong').length;
  assert.ok(pongs >= 15 && pongs < 40, `pongs ${pongs}`);
  t.ws.close();
});

test('crew-video WebSocket still works next to the alarm socket', async () => {
  const ws = new WebSocket(`${wsBase}/crew-video-ws`);
  open.push(ws);
  const msg = await new Promise<{ type: string }>((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: 'Mostek', room: 'TEST-ROOM' }));
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    ws.onerror = () => reject(new Error('crew-video ws failed'));
  });
  assert.equal(msg.type, 'welcome');
  ws.close();
});
