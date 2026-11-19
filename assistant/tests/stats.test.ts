// Statystyki (server/stats.ts, docs/STATS.md): gym ranking from a temporary crew SQLite database with known check-ins,
// ship statistics shape, alarm reaction-time summary from a temporary alarms.json, HTTP param validation, access hook,
// and no private fields in any output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA } from '../../crew/server/db.ts';
import {
  gymStats, shipStats, alarmsSummary, readAlarmLog, handleStatsHttp, setStatsAccessCheck, resetStats, VISIT_CAP_MIN,
  type GymStats,
} from '../server/stats.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T = Date.now();
const dir = mkdtempSync(path.join(tmpdir(), 'stats-test-'));
const DB_FILE = path.join(dir, 'crew.db');
const ALARMS = path.join(dir, 'alarms.json');

// rooms: id, code, name, role, deck, capacity, min_staff
const ROOMS: [number, string, string, string, number, number, number][] = [
  [1, 'D3-05', 'Siłownia', 'Rekreacja', 3, 2, 0],
  [2, 'D2-04', 'Mesa załogi', 'Wyżywienie', 2, 2, 0],          // capacity 2, 6 people at the end -> over capacity
  [3, 'D4-01', 'Mostek nawigacyjny', 'Nawigacja', 4, 8, 2],    // min 2, nobody there -> staffing critical
  [4, 'D1-02', 'Centrala manewrowa (ECR)', 'Maszynownia', 1, 6, 0],  // "siłowni" in the description only, not the gym
];
// crew: id, first, last, department, shift
const CREW: [number, string, string, string, string][] = [
  [1, 'Anna', 'Nowak', 'Pokład', '00-04'],
  [2, 'Bartosz', 'Kowalski', 'Maszynownia', '04-08'],
  [3, 'Cezary', 'Mazur', 'Maszynownia', 'dzienna'],
  [4, 'Dorota', 'Lis', 'Hotel', 'dzienna'],          // never in the gym, ashore
  [5, 'Edward', 'Wójcik', 'Pokład', '08-12'],         // gym 40 days ago only
  [6, 'Filip', 'Zając', 'Hotel', 'dzienna'],          // ties with Anna in 7d
  [7, 'Grzegorz', 'Bąk', 'Pokład', '00-04'],          // double tap at the gym door
  [8, 'Hanna', 'Wiśniewska', 'Medyczny', 'dzienna'],  // visit across the 7-day boundary
  [9, 'Igor', 'Szewczenko', 'Pokład', '04-08'],       // no check-ins at all
];
// check-ins: crew, room, direction, time (ms before T)
const EV: [number, number, 'in' | 'out', number][] = [
  [1, 1, 'in', 10 * DAY], [1, 2, 'out', 10 * DAY - 30 * MIN],   // 30 min, 10 days ago
  [1, 1, 'in', 2 * HOUR], [1, 2, 'in', 1 * HOUR],               // 60 min
  [2, 1, 'in', 6 * HOUR], [2, 2, 'in', 30 * MIN],               // 5.5 h -> capped at 4 h
  [3, 1, 'in', 45 * MIN],                                       // ongoing: 45 min until now
  [4, 2, 'in', 5 * HOUR], [4, 2, 'out', 3 * HOUR],              // never in the gym; ashore
  [5, 1, 'in', 40 * DAY], [5, 2, 'in', 40 * DAY - 100 * MIN],   // 100 min, 40 days ago
  [5, 2, 'in', 2 * HOUR],
  [6, 1, 'in', 3 * HOUR], [6, 2, 'in', 2 * HOUR],               // 60 min
  [7, 1, 'in', 3 * DAY], [7, 1, 'in', 3 * DAY - 20 * MIN], [7, 2, 'in', 3 * DAY - 50 * MIN], // one 50-min visit
  [8, 1, 'in', 7 * DAY + 30 * MIN], [8, 4, 'in', 7 * DAY - 20 * MIN], // 50 min, 20 of them inside the last 7 days
  [8, 2, 'in', 1 * HOUR],
];

const PRIVATE_KEYS = ['badge', 'rfid_uid', 'rfid_type', 'rfid', 'cabin', 'cabin_id', 'phone_ext', 'phone', 'birth_date',
  'nationality', 'crew_id', 'id', 'user', 'embarked_at'];
const PRIVATE_VALUES = ['B-1001', '04:AA:BB', 'Ukraina', 'Polska', '1990-05-17', 'Jan Kowalski', '201'];

function walkKeys(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((v) => walkKeys(v, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); walkKeys(v, out); }
  return out;
}
function assertNoPrivate(body: unknown) {
  const keys = walkKeys(body);
  for (const k of PRIVATE_KEYS) assert.ok(!keys.has(k), `private key in output: ${k}`);
  const s = JSON.stringify(body);
  for (const v of PRIVATE_VALUES) assert.ok(!s.includes(`"${v}`), `private value in output: ${v}`);
}

let db: DatabaseSync;
let server: Server;
let base = '';

before(async () => {
  const w = new DatabaseSync(DB_FILE);
  w.exec(SCHEMA);
  for (const lvl of [1, 2, 3, 4]) w.prepare('INSERT INTO decks (id, level, name) VALUES (?, ?, ?)').run(lvl, lvl, `Pokład ${lvl}`);
  for (const [id, code, name, role, deck, cap, minStaff] of ROOMS) {
    w.prepare(`INSERT INTO rooms (id, code, name, role, description, deck_id, area_m2, capacity, min_staff, staff_hours)
      VALUES (?, ?, ?, ?, ?, ?, 20, ?, ?, '00-24')`).run(id, code, name, role, 'Sterowanie i monitoring siłowni', deck, cap, minStaff);
    w.prepare('INSERT INTO terminals (id, code, room_id) VALUES (?, ?, ?)').run(id, `T-${code}-A`, id);
  }
  for (const [id, first, last, dept, shift] of CREW) {
    w.prepare(`INSERT INTO crew (id, badge, rfid_uid, rfid_type, first_name, last_name, rank, department, shift, nationality,
      birth_date, phone_ext, cabin_id, embarked_at) VALUES (?, ?, ?, 'karta', ?, ?, 'Marynarz', ?, ?, ?, '1990-05-17', ?, NULL, ?)`)
      .run(id, `B-100${id}`, `04:AA:BB:CC:DD:EE:0${id}`, first, last, dept, shift, id % 2 ? 'Ukraina' : 'Polska', String(200 + id),
        new Date(T - (id <= 2 ? 3 : 20) * DAY).toISOString().slice(0, 10));
  }
  const ins = w.prepare('INSERT INTO checkins (crew_id, terminal_id, room_id, direction, at) VALUES (?, ?, ?, ?, ?)');
  for (const [c, room, dir, ago] of EV) ins.run(c, room, room, dir, new Date(T - ago).toISOString());
  w.close();
  db = new DatabaseSync(DB_FILE, { readOnly: true });

  writeFileSync(ALARMS, JSON.stringify({
    version: 1,
    log: [
      { id: 'a1', kind: 'fire', drill: true, raisedBy: 'Mostek', raisedById: 'bridge-1', at: new Date(T - DAY).toISOString(),
        endedAt: new Date(T - DAY + 600_000).toISOString(), zone: null, blocked: null, message: '',
        acks: {
          'bridge-1': { at: new Date(T - DAY).toISOString(), name: 'Mostek' },
          'term-a': { at: new Date(T - DAY + 10_000).toISOString(), name: 'Terminal A', user: 'Jan Kowalski' },
          'term-b': { at: new Date(T - DAY + 30_000).toISOString(), name: 'Terminal B', headcount: 4 },
        } },
      { id: 'a2', kind: 'general', drill: false, raisedBy: 'Mostek', raisedById: 'bridge-1', at: new Date(T - 2 * DAY).toISOString(),
        endedAt: new Date(T - 2 * DAY + 600_000).toISOString(), zone: null, blocked: null, message: '',
        acks: {
          'bridge-1': { at: new Date(T - 2 * DAY).toISOString(), name: 'Mostek' },
          'term-a': { at: new Date(T - 2 * DAY + 20_000).toISOString(), name: 'Terminal A' },
          'term-b': { at: new Date(T - 2 * DAY + 60_000).toISOString(), name: 'Terminal B' },
        } },
      { id: 'a3', kind: 'mob', drill: true, raisedBy: 'Mostek', raisedById: 'bridge-1', at: new Date(T - 40 * DAY).toISOString(),
        endedAt: new Date(T - 40 * DAY + 60_000).toISOString(), zone: null, blocked: null, message: '',
        acks: { 'term-c': { at: new Date(T - 40 * DAY + 900_000).toISOString(), name: 'Terminal C' } } },
    ],
  }));

  process.env.CREW_DB = DB_FILE;
  process.env.ALARMS_FILE = ALARMS;
  for (const k of ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS', 'STATS_GYM_CODE']) delete process.env[k];
  setStatsAccessCheck(() => true); // no AUTH module in the test: everything allowed unless a test says otherwise
  server = createServer(async (req, res) => {
    if (await handleStatsHttp(req, res)) return;
    res.writeHead(404).end('{"error":"outside"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  db?.close();
  resetStats();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const row = (g: GymStats, name: string) => g.ranking.find((p) => p.name === name);
const table = (g: GymStats) => g.ranking.map((p) => [p.rank, p.name, p.minutes, p.sessions]);

test('gym 7d: cap at 4 h, ongoing visit, double tap, boundary clip, ties share a rank', () => {
  const g = gymStats(db, '7d', T);
  assert.equal(g.room?.code, 'D3-05');
  assert.equal(g.capMinutes, VISIT_CAP_MIN);
  assert.deepEqual(table(g), [
    [1, 'Bartosz Kowalski', 240, 1],
    [2, 'Anna Nowak', 60, 1],
    [2, 'Filip Zając', 60, 1],
    [4, 'Grzegorz Bąk', 50, 1],
    [5, 'Cezary Mazur', 45, 1],
    [6, 'Hanna Wiśniewska', 20, 1],
  ]);
  assert.equal(row(g, 'Cezary Mazur')!.ongoing, true);
  assert.equal(row(g, 'Anna Nowak')!.ongoing, false);
  assert.equal(row(g, 'Dorota Lis'), undefined, 'never in the gym: not ranked');
  assert.equal(row(g, 'Edward Wójcik'), undefined, '40 days ago: not in 7d');
  assert.deepEqual(g.top3.map((p) => p.name), ['Bartosz Kowalski', 'Anna Nowak', 'Filip Zając']);
  assert.deepEqual(g.totals, { minutes: 475, sessions: 6, people: 6, crew: 9 });
  assert.deepEqual(g.departments, [
    { department: 'Maszynownia', minutes: 285, sessions: 2, people: 2 },
    { department: 'Pokład', minutes: 110, sessions: 2, people: 2 },
    { department: 'Hotel', minutes: 60, sessions: 1, people: 1 },
    { department: 'Medyczny', minutes: 20, sessions: 1, people: 1 },
  ]);
  const anna = row(g, 'Anna Nowak')!;
  assert.equal(anna.avgMinutes, 60);
  assert.equal(Date.parse(anna.lastVisit!), Math.floor((T - 2 * HOUR) / MIN) * MIN);
});

test('gym 30d and all: older visits come in', () => {
  const m = gymStats(db, '30d', T);
  assert.deepEqual(table(m), [
    [1, 'Bartosz Kowalski', 240, 1],
    [2, 'Anna Nowak', 90, 2],
    [3, 'Filip Zając', 60, 1],
    [4, 'Grzegorz Bąk', 50, 1],
    [4, 'Hanna Wiśniewska', 50, 1],
    [6, 'Cezary Mazur', 45, 1],
  ]);
  assert.equal(row(m, 'Anna Nowak')!.avgMinutes, 45);
  const a = gymStats(db, 'all', T);
  assert.equal(a.from, null);
  assert.deepEqual(a.ranking.slice(0, 3).map((p) => [p.name, p.minutes]), [['Bartosz Kowalski', 240], ['Edward Wójcik', 100], ['Anna Nowak', 90]]);
  assert.equal(a.totals.people, 7);
});

test('gym output has only rank, name, department and gym numbers', () => {
  const g = gymStats(db, 'all', T);
  for (const p of g.ranking) assert.deepEqual(Object.keys(p).sort(),
    ['avgMinutes', 'department', 'lastVisit', 'minutes', 'name', 'ongoing', 'rank', 'sessions']);
  assertNoPrivate(g);
});

test('alarms summary: last 30 days, real vs drill, reaction times without the raising terminal', () => {
  const s = alarmsSummary(readAlarmLog(ALARMS), T);
  assert.equal(s.total, 2);
  assert.equal(s.real, 1);
  assert.equal(s.drill, 1);
  assert.equal(s.active, false);
  assert.deepEqual(s.ack, { count: 4, avgSec: 30, medianSec: 25, maxSec: 60 });
  assert.deepEqual(s.slowestTerminal, { name: 'Terminal B', avgSec: 45, acks: 2 });
  assert.deepEqual(s.lastAlarm, { kind: 'fire', drill: true, at: new Date(T - DAY).toISOString() });
  assertNoPrivate(s);
  // missing / broken file -> empty summary, no throw
  assert.deepEqual(readAlarmLog(path.join(dir, 'nope.json')), []);
  assert.equal(alarmsSummary([null, 5, { at: 'x' }], T).total, 0);
});

test('ship stats: shape and numbers', () => {
  const s = shipStats(db, readAlarmLog(ALARMS), T);
  assert.deepEqual(s.crew, { total: 9, onboard: 7, ashore: 2 }); // Dorota checked out, Igor never checked in
  assert.deepEqual(s.departments.map((d) => [d.department, d.total, d.onboard]),
    [['Pokład', 4, 3], ['Hotel', 2, 1], ['Maszynownia', 2, 2], ['Medyczny', 1, 1]]);
  assert.equal(s.decks.reduce((n, d) => n + d.people, 0), 7);
  assert.equal(s.decks[0].deck, 4);
  const mess = s.rooms.overCapacity.find((r) => r.code === 'D2-04');
  assert.ok(mess && mess.people === 6 && mess.capacity === 2 && mess.occupancy === 300);
  assert.equal(s.rooms.busy[0].code, 'D2-04');
  assert.equal(s.checkinsPerHour.length, 24);
  assert.ok(s.checkinsPerHour.every((b) => typeof b.start === 'string' && Number.isInteger(b.count)));
  assert.equal(s.checkins24h, s.checkinsPerHour.reduce((n, b) => n + b.count, 0));
  assert.equal(s.checkins24h, 11);
  assert.deepEqual(s.staffing.map((r) => [r.code, r.people, r.status, r.coverage24h]), [['D4-01', 0, 'critical', 0]]);
  assert.equal(s.alerts.staffing.critical, 1);
  assert.equal(s.alerts.lastCheckin.critical, 2); // Igor: no check-in at all; Grzegorz: last one 3 days ago
  assert.ok(s.alerts.total >= 2);
  assert.equal(s.alarms.total, 2);
  assert.deepEqual(s.watches.map((w) => w.shift), ['00-04', '04-08', '08-12', 'dzienna']);
  assert.equal(s.embarked.last7d, 2);
  assert.equal(s.embarked.last30d, 9);
  assertNoPrivate(s);
});

// ---------- HTTP ----------
const get = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, init);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

test('HTTP: gym + ship endpoints', async () => {
  const g = await get('/api/stats/gym?period=30d');
  assert.equal(g.status, 200);
  assert.equal(g.body.period, '30d');
  assert.equal(g.body.top3[0].name, 'Bartosz Kowalski');
  assertNoPrivate(g.body);
  const d = await get('/api/stats/gym');
  assert.equal(d.body.period, '7d');
  const s = await get('/api/stats/ship');
  assert.equal(s.status, 200);
  assert.equal(s.body.crew.total, 9);
  assert.equal(s.body.alarms.ack.avgSec, 30);
  assertNoPrivate(s.body);
});

test('HTTP: parameter validation, methods, unknown paths', async () => {
  for (const q of ['period=1y', 'period=', 'period=7d&period=30d', 'period=7D', 'x=1', 'period=7d&debug=1'])
    assert.equal((await get('/api/stats/gym?' + q)).status, 400, q);
  assert.equal((await get('/api/stats/ship?period=7d')).status, 400);
  assert.equal((await get('/api/stats/crew')).status, 404);
  assert.equal((await get('/api/stats/../crew')).status, 404); // normalised by the URL parser to /api/crew -> not ours
  assert.equal((await get('/api/statsx')).body.error, 'outside');
  assert.equal((await get('/api/stats/gym', { method: 'POST' })).status, 405);
  assert.equal((await get('/api/stats/gym', { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('HTTP: access hook -> 401', async () => {
  setStatsAccessCheck(() => false);
  try {
    const r = await get('/api/stats/ship');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'login required' });
  } finally { setStatsAccessCheck(() => true); }
});

test('HTTP: crew database missing -> 503', async () => {
  resetStats();
  process.env.CREW_DB = path.join(dir, 'missing.db');
  try {
    assert.equal((await get('/api/stats/gym')).status, 503);
  } finally {
    process.env.CREW_DB = DB_FILE;
    resetStats();
  }
  assert.equal((await get('/api/stats/gym')).status, 200);
});
