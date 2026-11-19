// Crew task list (server/tasks.ts, shared/tasks.ts): login and role rules, who sees what (mine / all), validation,
// take / done / cancel, and the auto tasks an alarm creates (fire detector, bridge raise) and cancels when it ends.
// Harness like tests/alarms.test.ts: node http server + handleTasksHttp + handleAlarmHttp + attachAlarms (auth), a fake
// crew DB for the accounts, Node's WebSocket as the bridge terminal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Task, TasksResponse } from '../shared/tasks.ts';
import { assignedTo, taskOrder } from '../shared/tasks.ts';
import type { ServerMsg } from '../shared/alarms.ts';

const CREW = [
  { id: 1, first_name: 'Bartosz', last_name: 'Kozłowski', rank: 'Kapitan', department: 'Pokład', rfid_uid: null },
  { id: 2, first_name: 'Jan', last_name: 'Kowal', rank: 'Motorzysta', department: 'Maszynownia', rfid_uid: null },
  { id: 3, first_name: 'Anna', last_name: 'Nowak', rank: 'Steward', department: 'Hotel', rfid_uid: null },
  { id: 4, first_name: 'Piotr', last_name: 'Wiśniewski', rank: 'Starszy mechanik', department: 'Maszynownia', rfid_uid: null },
  { id: 5, first_name: 'Ewa', last_name: 'Zając', rank: 'Marynarz', department: 'Pokład', rfid_uid: null },
];
const crew = createServer((req, res) => {
  const body = req.url === '/api/crew' ? CREW : req.url === '/api/rooms' ? [] : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(body ? JSON.stringify(body) : '{"error":"Not found"}');
});
const DEMO_PIN = '2468';
const dir = mkdtempSync(path.join(tmpdir(), 'tasks-test-'));
const FILE = path.join(dir, 'data', 'tasks.json');
let server: Server;
let base = '';
let tasksMod: typeof import('../server/tasks.ts');
const cookie: Record<number, string> = {};
const open: WebSocket[] = [];

before(async () => {
  await new Promise<void>((r) => crew.listen(0, '127.0.0.1', r));
  process.env.CREW_API = `http://127.0.0.1:${(crew.address() as { port: number }).port}`;
  process.env.ALARMS_FILE = path.join(dir, 'data', 'alarms.json');
  process.env.TASKS_FILE = FILE;
  process.env.TASKS_SEED = '0';
  process.env.TASKS_SAVE_MS = '30';
  process.env.TASKS_WRITE_PER_MIN = '1000';
  process.env.AUTH_DIR = path.join(dir, 'auth');
  process.env.ACCOUNTS_DEMO_PIN = DEMO_PIN;
  for (const k of ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS', 'SENSOR_KEY', 'TERMINAL_KEY', 'BAND_KEY']) delete process.env[k];
  const alarms = await import('../server/alarms.ts');
  tasksMod = await import('../server/tasks.ts');
  server = createServer(async (req, res) => {
    if (await tasksMod.handleTasksHttp(req, res)) return;
    if (await alarms.handleAlarmHttp(req, res)) return;
    res.writeHead(404).end();
  });
  alarms.attachAlarms(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const { id } of CREW) {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'pin', id, pin: DEMO_PIN }) });
    assert.equal(r.status, 200, 'login ' + id);
    cookie[id] = (r.headers.get('set-cookie') ?? '').split(';')[0];
  }
});
after(async () => {
  for (const ws of open) try { ws.close(); } catch { /* closed */ }
  await new Promise((r) => setTimeout(r, 50));
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => crew.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const CAPTAIN = 1, MOTORMAN = 2, STEWARD = 3, CHIEF_ENG = 4, SEAMAN = 5;
async function list(who: number, scope = 'mine'): Promise<TasksResponse> {
  const r = await fetch(`${base}/api/tasks?scope=${scope}`, { headers: { cookie: cookie[who] } });
  assert.equal(r.status, 200);
  return r.json() as Promise<TasksResponse>;
}
async function post(who: number | null, body: unknown, type = 'application/json') {
  const r = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': type, ...(who ? { cookie: cookie[who] } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function patch(who: number, id: string, body: unknown) {
  const r = await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie[who] }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
const titles = (r: TasksResponse) => r.tasks.map((t) => t.title);

test('login required; crew cannot create; origin checked', async () => {
  assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
  assert.equal((await post(null, { title: 'x', assignee: { kind: 'all' } })).status, 401);
  assert.equal((await post(STEWARD, { title: 'x', assignee: { kind: 'all' } })).status, 403);
  assert.equal((await post(MOTORMAN, { title: 'x', assignee: { kind: 'all' } })).status, 403);
  const r = await fetch(`${base}/api/tasks`, { headers: { cookie: cookie[CAPTAIN], origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal((await fetch(`${base}/api/tasks/not-an-id`, { method: 'PATCH', headers: { cookie: cookie[CAPTAIN] } })).status, 404);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'DELETE', headers: { cookie: cookie[CAPTAIN] } })).status, 405);
});

test('validation', async () => {
  const ok = { title: 'Test', assignee: { kind: 'all' } };
  assert.equal((await post(CAPTAIN, { ...ok, title: '' })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, title: 'x'.repeat(121) })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, details: 'x'.repeat(501) })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, assignee: { kind: 'role', value: 'admiral' } })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, assignee: { kind: 'department', value: 'Kuchnia' } })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, assignee: { kind: 'person', value: 999 } })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, priority: 'asap' })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, zone: 'kitchen' })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, dueInMin: 0 })).status, 400);
  assert.equal((await post(CAPTAIN, { ...ok, due: 'tomorrow' })).status, 400);
  assert.equal((await post(CAPTAIN, JSON.stringify(ok), 'text/plain')).status, 415);
  assert.equal((await post(CAPTAIN, '{broken')).status, 400);
  // control characters are cleaned, a title over 120 visible chars is refused (not cut)
  const r = await post(CAPTAIN, { ...ok, title: '  Sprawdzić\u0007  gaśnice ', priority: 'low' });
  assert.equal(r.status, 201);
  assert.equal(r.body.task.title, 'Sprawdzić gaśnice');
  await patch(CAPTAIN, r.body.task.id, { status: 'cancelled' });
});

test('visibility: mine = person / role / department / all; scope=all only for officers', async () => {
  const mk = async (title: string, assignee: unknown, extra: object = {}) => {
    const r = await post(CAPTAIN, { title, assignee, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task as Task;
  };
  const hotel = await mk('V: kamizelki w kabinach', { kind: 'department', value: 'Hotel' }, { priority: 'normal', dueInMin: 60, zone: 'cabins-aft' });
  const eng = await mk('V: odczyt zęz', { kind: 'role', value: 'engine' }, { priority: 'high' });
  const jan = await mk('V: dla Jana', { kind: 'person', value: String(MOTORMAN) }, { priority: 'urgent', dueInMin: 5 });
  const all = await mk('V: odprawa', { kind: 'all' }, { priority: 'low' });
  const bridge = await mk('V: szalupa 2', { kind: 'role', value: 'bridge' });
  assert.equal(jan.assignee.label, 'Jan Kowal, Motorzysta');
  assert.equal(hotel.assignee.label, 'Dział hotelowy');
  assert.equal(hotel.zone, 'cabins-aft');
  assert.ok(hotel.due && Date.parse(hotel.due) > Date.now());

  const steward = await list(STEWARD, 'all'); // crew asking for all gets mine
  assert.equal(steward.scope, 'mine');
  assert.equal(steward.canAll, false);
  assert.deepEqual(titles(steward).filter((t) => t.startsWith('V:')).sort(), ['V: kamizelki w kabinach', 'V: odprawa']);
  const motorman = await list(MOTORMAN);
  assert.deepEqual(titles(motorman).filter((t) => t.startsWith('V:')).sort(), ['V: dla Jana', 'V: odprawa']);
  const chief = await list(CHIEF_ENG);
  assert.deepEqual(titles(chief).filter((t) => t.startsWith('V:')).sort(), ['V: odczyt zęz', 'V: odprawa']);
  // the master gets the bridge's tasks too
  const cap = await list(CAPTAIN);
  assert.ok(titles(cap).includes('V: szalupa 2'));
  assert.ok(!titles(cap).includes('V: dla Jana'));
  const chiefAll = await list(CHIEF_ENG, 'all');
  assert.equal(chiefAll.scope, 'all');
  for (const t of [hotel, eng, jan, all, bridge]) assert.ok(titles(chiefAll).includes(t.title));
  // order: urgent, high, normal, low
  const v = titles(chiefAll).filter((t) => t.startsWith('V:'));
  assert.ok(v.indexOf('V: dla Jana') < v.indexOf('V: odczyt zęz'));
  assert.ok(v.indexOf('V: odczyt zęz') < v.indexOf('V: kamizelki w kabinach'));
  assert.ok(v.indexOf('V: kamizelki w kabinach') < v.indexOf('V: odprawa'));
  assert.equal(motorman.mineOpen, motorman.tasks.filter((t) => t.status === 'open' || t.status === 'in-progress').length);
  // a crew member cannot even see / patch a task that is not theirs
  assert.equal((await patch(STEWARD, jan.id, { status: 'in-progress' })).status, 404);
  for (const t of [hotel, eng, jan, all, bridge]) await patch(CAPTAIN, t.id, { status: 'cancelled' });
});

test('take, done with note, cancel rights, finished is final', async () => {
  const t = (await post(CHIEF_ENG, { title: 'Wymienić żarówki w korytarzu D3', assignee: { kind: 'department', value: 'Hotel' } })).body.task as Task;
  assert.equal(t.createdBy.name, 'Piotr Wiśniewski');
  assert.equal((await patch(STEWARD, t.id, { status: 'cancelled' })).status, 403);
  assert.equal((await patch(STEWARD, t.id, { title: 'inny' })).status, 403);
  const taken = await patch(STEWARD, t.id, { status: 'in-progress' });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.task.status, 'in-progress');
  assert.equal(taken.body.task.takenBy.name, 'Anna Nowak');
  assert.equal((await patch(STEWARD, t.id, { status: 'done', note: 'x'.repeat(201) })).status, 400);
  const done = await patch(STEWARD, t.id, { status: 'done', note: 'Wymienione 4 szt.' });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.doneBy.name, 'Anna Nowak');
  assert.equal(done.body.task.note, 'Wymienione 4 szt.');
  assert.ok(done.body.task.doneAt);
  assert.equal((await patch(STEWARD, t.id, { status: 'open' })).status, 409);
  // finished tasks stay in the list (24 h), below the active ones, the last finished first
  const mine = await list(STEWARD);
  const firstDone = mine.tasks.findIndex((x) => x.status === 'done' || x.status === 'cancelled');
  assert.equal(mine.tasks[firstDone].id, t.id);
  assert.ok(mine.tasks.slice(firstDone).every((x) => x.status === 'done' || x.status === 'cancelled'));

  // the creator (engine officer) may edit / cancel their own task; the bridge any
  const t2 = (await post(CHIEF_ENG, { title: 'Sprawdzić filtr paliwa', assignee: { kind: 'role', value: 'engine' } })).body.task as Task;
  const ed = await patch(CHIEF_ENG, t2.id, { priority: 'urgent', dueInMin: 15, zone: 'engine-room' });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.task.priority, 'urgent');
  const t3 = (await post(CAPTAIN, { title: 'Zadanie kapitana', assignee: { kind: 'role', value: 'engine' } })).body.task as Task;
  assert.equal((await patch(CHIEF_ENG, t3.id, { status: 'cancelled' })).status, 403);
  const c = await patch(CAPTAIN, t3.id, { status: 'cancelled', note: 'Nieaktualne' });
  assert.equal(c.body.task.status, 'cancelled');
  assert.equal((await patch(CHIEF_ENG, t2.id, { status: 'cancelled' })).status, 200);
  assert.equal((await patch(CAPTAIN, t2.id, { bogus: 1 })).status, 409);
});

test('auto tasks: a fire detector raises tasks, another detector adds one, ending the alarm cancels them', async () => {
  const r = await fetch(`${base}/api/alarms/sensor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sensor: 'C104', drill: true }) });
  assert.equal(r.status, 200);
  const { alarmId } = await r.json() as { alarmId: string };
  const all = (await list(CAPTAIN, 'all')).tasks.filter((t) => t.alarmId === alarmId);
  assert.ok(all.length >= 2 && all.length <= 4, `got ${all.length}`);
  const recon = all.find((t) => t.title.startsWith('Grupa pożarowa'))!;
  assert.ok(recon, 'fire team task');
  assert.match(recon.title, /kabiny rufowe/);
  assert.match(recon.title, /C104/);
  assert.equal(recon.priority, 'urgent');
  assert.equal(recon.assignee.kind, 'department');
  assert.equal(recon.zone, 'cabins-aft');
  assert.equal(recon.alarmKind, 'fire');
  assert.equal(recon.alarmDrill, true);
  // the deck seaman sees the fire team task, the steward does not
  assert.ok((await list(SEAMAN)).tasks.some((t) => t.id === recon.id));
  assert.ok(!(await list(STEWARD)).tasks.some((t) => t.id === recon.id));
  // the seaman takes it
  assert.equal((await patch(SEAMAN, recon.id, { status: 'in-progress' })).status, 200);

  await fetch(`${base}/api/alarms/sensor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sensor: 'D3-K1', drill: true }) });
  const after2 = (await list(CAPTAIN, 'all')).tasks.filter((t) => t.alarmId === alarmId);
  assert.equal(after2.length, all.length + 1);
  assert.ok(after2.some((t) => t.title.includes('D3-K1')));

  // a bridge terminal (captain login) ends the alarm
  const ws = new (WebSocket as any)(`${base.replace('http', 'ws')}/api/alarms/ws`, { headers: { cookie: cookie[CAPTAIN] } }) as WebSocket;
  open.push(ws);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')); });
  ws.send(JSON.stringify({ type: 'hello', terminalId: 'T-TASKS-1', name: 'Mostek test', role: 'bridge', zone: 'bridge' }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20));
  ws.send(JSON.stringify({ type: 'end', alarmId }));
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === 'state' && m.reason === 'ended'); i++) await new Promise((r) => setTimeout(r, 20));
  const ended = (await list(CAPTAIN, 'all')).tasks.filter((t) => t.alarmId === alarmId);
  assert.equal(ended.length, all.length + 1);
  for (const t of ended) {
    assert.equal(t.status, 'cancelled', t.title);
    assert.equal(t.note, 'Alarm zakończony');
  }
  // a new raise from the bridge (medical, a zone) creates its own tasks; replacing it cancels them
  ws.send(JSON.stringify({ type: 'raise', kind: 'medical', zone: 'restaurant', blocked: null, message: '', drill: true }));
  for (let i = 0; i < 50 && !(await list(CAPTAIN, 'all')).tasks.some((t) => t.alarmKind === 'medical' && t.status === 'open'); i++) await new Promise((r) => setTimeout(r, 20));
  const med = (await list(CAPTAIN, 'all')).tasks.filter((t) => t.alarmKind === 'medical' && t.status === 'open');
  assert.ok(med.length >= 2);
  assert.ok(med.some((t) => t.assignee.value === 'Medyczny' && /restauracja/.test(t.title)));
  ws.send(JSON.stringify({ type: 'raise', kind: 'blackout', zone: null, blocked: null, message: '', drill: true }));
  for (let i = 0; i < 50 && !(await list(CAPTAIN, 'all')).tasks.some((t) => t.alarmKind === 'blackout'); i++) await new Promise((r) => setTimeout(r, 20));
  const now = (await list(CAPTAIN, 'all')).tasks;
  assert.ok(now.filter((t) => t.alarmKind === 'medical').every((t) => t.status === 'cancelled' && t.note?.startsWith('Alarm zakończony')));
  assert.ok(now.some((t) => t.alarmKind === 'blackout' && t.assignee.value === 'engine' && t.status === 'open'));
  // persisted
  tasksMod.flushTasks();
  const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { tasks: Task[] };
  assert.ok(saved.tasks.some((t) => t.alarmKind === 'blackout'));
});

test('shared rules: assignedTo and order', () => {
  const base = { id: 'x', title: 't', status: 'open', createdBy: { id: null, name: 'x', rank: '' }, createdAt: '2026-11-19T10:00:00Z', updatedAt: '' } as const;
  const t = (assignee: Task['assignee'], priority: Task['priority'] = 'normal', due?: string): Task => ({ ...base, assignee, priority, ...(due ? { due } : {}) });
  const me = { id: 7, role: 'crew' as const, department: 'Hotel' };
  assert.ok(assignedTo(t({ kind: 'department', value: 'Hotel', label: '' }), me));
  assert.ok(!assignedTo(t({ kind: 'department', value: 'Pokład', label: '' }), me));
  assert.ok(assignedTo(t({ kind: 'person', value: '7', label: '' }), me));
  assert.ok(assignedTo(t({ kind: 'role', value: 'bridge', label: '' }), { id: 1, role: 'captain', department: 'Pokład' }));
  assert.ok(!assignedTo(t({ kind: 'role', value: 'captain', label: '' }), { id: 2, role: 'bridge', department: 'Pokład' }));
  const a = t({ kind: 'all', value: '', label: '' }, 'normal', '2026-11-19T12:00:00Z');
  const b = t({ kind: 'all', value: '', label: '' }, 'normal', '2026-11-19T11:00:00Z');
  const c = t({ kind: 'all', value: '', label: '' }, 'high');
  assert.deepEqual([a, b, c].sort(taskOrder), [c, b, a]);
});
