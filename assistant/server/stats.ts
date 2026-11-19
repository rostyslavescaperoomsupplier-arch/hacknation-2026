// Statystyki (tab "Statystyki", docs/STATS.md): gym ranking + general ship statistics, read straight from the crew
// SQLite database (READ-ONLY) and the alarm log (server/data/alarms.json). Node built-ins only (node:sqlite).
//   GET /api/stats/gym?period=7d|30d|all   time per person in the gym (Siłownia, role Rekreacja), ranking, departments, top 3
//   GET /api/stats/ship                    on board / ashore, departments, decks, room occupancy, check-ins per hour,
//                                          staffing of key rooms, active alerts, alarm reaction times, watches, embarkations
// Privacy (RODO / data minimisation): people appear ONLY in the gym ranking, as { rank, name, department } plus their
// gym time. Never badge, RFID, cabin, phone extension, birth date, nationality, ids or the user field of alarm acks.
// Ship statistics are counts only. Same origin / x-assistant-token check as the crew proxy and its per-IP bucket
// (guard.ts takeCrewToken, 120 / min), GET only.
// Access: when server/auth.ts exports getSession(req) a logged-in session is required (401 otherwise); the lead can also
// wire any check with setStatsAccessCheck(fn).
// Env: CREW_DB (default ../crew/data/crew.db relative to the assistant folder; production /var/www/jantar-crew/data/crew.db),
//      ALARMS_FILE (same as alarms.ts), STATS_GYM_CODE (room code of the gym; default: the room named "Siłownia" with role
//      "Rekreacja", else D3-05).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, corsOrigin, originAllowed, takeCrewToken, tokenOk } from './guard.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CACHE_MS = 10_000;
/** one gym visit counts at most this long (forgotten check-out, card left in the gym) */
export const VISIT_CAP_MIN = 240;
export const PERIODS = { '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity } as const;
export type Period = keyof typeof PERIODS;
export const isPeriod = (v: unknown): v is Period => v === '7d' || v === '30d' || v === 'all';

const crewDbPath = () => process.env.CREW_DB || path.join(here, '..', '..', 'crew', 'data', 'crew.db');
const alarmsPath = () => process.env.ALARMS_FILE || path.join(here, 'data', 'alarms.json');

// ---------- access hook ----------
type AccessCheck = (req: IncomingMessage) => boolean | Promise<boolean>;
let accessCheck: AccessCheck | null = null;
let authProbe: Promise<AccessCheck | null> | null = null;
/** HOOK for the lead: require something (e.g. a logged-in session) before the stats are served. false -> 401.
 *  Overrides the automatic getSession() check from server/auth.ts. Pass null to go back to the automatic one. */
export function setStatsAccessCheck(fn: AccessCheck | null) { accessCheck = fn; }

/** server/auth.ts (AUTH agent) may export getSession(req): use it when it is there. Variable specifier on purpose, so
 *  the type-check does not depend on a file another agent owns. */
function autoCheck(): Promise<AccessCheck | null> {
  authProbe ??= (async () => {
    try {
      const spec = './auth.ts';
      const mod: any = await import(spec);
      if (typeof mod?.getSession !== 'function') return null;
      return async (req: IncomingMessage) => !!(await mod.getSession(req));
    } catch (e: any) {
      // no auth module at all -> open (demo without accounts); a broken one -> closed, never silently public
      if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
      console.error('[assistant] stats: server/auth.ts failed to load, stats closed:', e instanceof Error ? e.message : e);
      return () => false;
    }
  })();
  return authProbe;
}

// ---------- database ----------
let db: DatabaseSync | null = null;
let dbFile = '';
function openCrewDb(): DatabaseSync {
  const file = crewDbPath();
  if (db && dbFile === file) return db;
  try { db?.close(); } catch { /* already closed */ }
  db = null;
  const d = new DatabaseSync(file, { readOnly: true });
  d.prepare('SELECT 1 FROM checkins LIMIT 1').all(); // fails now (not later) when the file is not a crew DB
  db = d; dbFile = file;
  return d;
}
/** For tests: drop the open handle and the cache (another CREW_DB / ALARMS_FILE). */
export function resetStats() {
  try { db?.close(); } catch { /* ignore */ }
  db = null; dbFile = ''; cache.clear(); authProbe = null;
}

const cache = new Map<string, { t: number; data: unknown }>();
function cached<T>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data as T;
  const data = make();
  cache.set(key, { t: Date.now(), data });
  return data;
}

interface RoomRow {
  id: number; code: string; name: string; role: string; capacity: number; deck: number; deck_name: string;
  min_staff: number; staff_hours: string; hazardous: number;
}
interface CrewRow { id: number; first_name: string; last_name: string; department: string; shift: string; cabin_id: number | null; embarked_at: string }
interface Ev { crew_id: number; room_id: number; direction: 'in' | 'out'; at: string }

const rooms = (d: DatabaseSync) => d.prepare(`SELECT r.id, r.code, r.name, r.role, r.capacity, d.level AS deck, d.name AS deck_name,
  r.min_staff, r.staff_hours, r.hazardous FROM rooms r JOIN decks d ON d.id = r.deck_id ORDER BY d.level, r.code`).all() as unknown as RoomRow[];
// only the columns the statistics need; no badge, rfid, phone, birth date, nationality
const crewRows = (d: DatabaseSync) => d.prepare(
  'SELECT id, first_name, last_name, department, shift, cabin_id, embarked_at FROM crew').all() as unknown as CrewRow[];
const events = (d: DatabaseSync) => d.prepare(
  'SELECT crew_id, room_id, direction, at FROM checkins ORDER BY at, id').all() as unknown as Ev[];

function gymRoom(all: RoomRow[]): RoomRow | null {
  const code = process.env.STATS_GYM_CODE;
  if (code) return all.find((r) => r.code === code) ?? null;
  return all.find((r) => r.role === 'Rekreacja' && /^siłownia/i.test(r.name))
    ?? all.find((r) => r.code === 'D3-05') ?? null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// ---------- gym ----------
export interface GymPerson {
  rank: number; name: string; department: string;
  minutes: number; sessions: number; avgMinutes: number; lastVisit: string | null; ongoing: boolean;
}
export interface GymStats {
  period: Period; from: string | null; now: string;
  room: { code: string; name: string } | null;
  capMinutes: number;
  totals: { minutes: number; sessions: number; people: number; crew: number };
  ranking: GymPerson[];
  top3: GymPerson[];
  departments: { department: string; minutes: number; sessions: number; people: number }[];
}

/** Gym time per person. A visit = a check-in 'in' into the gym, until that person's next check-in anywhere (in or out);
 *  a visit still open counts until now; each visit counts at most VISIT_CAP_MIN. Only the part inside the period counts,
 *  and a session counts in a period when some of it falls inside. */
export function gymStats(d: DatabaseSync, period: Period, now = Date.now()): GymStats {
  const all = rooms(d);
  const gym = gymRoom(all);
  const crew = crewRows(d);
  const from = period === 'all' ? -Infinity : now - PERIODS[period];
  const per = new Map<number, { ms: number; sessions: number; last: number; ongoing: boolean }>();
  if (gym) {
    const byCrew = new Map<number, Ev[]>();
    for (const e of events(d)) {
      let l = byCrew.get(e.crew_id);
      if (!l) byCrew.set(e.crew_id, l = []);
      l.push(e);
    }
    for (const [id, evs] of byCrew) {
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        if (e.direction !== 'in' || e.room_id !== gym.id) continue;
        const start = Date.parse(e.at);
        if (!Number.isFinite(start) || start > now) continue;
        // a repeated tap at the gym door is the same visit: it lasts until the first check-in that is not "in gym"
        let j = i + 1;
        while (j < evs.length && evs[j].direction === 'in' && evs[j].room_id === gym.id) j++;
        const next = evs[j];
        addVisit(per, id, start, next ? Date.parse(next.at) : now, !next, from, now);
        i = j - 1;
      }
    }
  }
  const byId = new Map(crew.map((c) => [c.id, c]));
  const list = [...per].filter(([id, v]) => v.ms > 0 && byId.has(id)).map(([id, v]) => {
    const c = byId.get(id)!;
    const minutes = Math.round(v.ms / MIN);
    return {
      rank: 0, name: `${c.first_name} ${c.last_name}`, department: c.department,
      minutes, sessions: v.sessions, avgMinutes: v.sessions ? Math.round(v.ms / MIN / v.sessions) : 0,
      lastVisit: v.last ? new Date(Math.floor(v.last / MIN) * MIN).toISOString() : null, ongoing: v.ongoing,
    };
  }).filter((p) => p.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions || a.name.localeCompare(b.name, 'pl'));
  // equal minutes share a rank (1, 2, 2, 4)
  list.forEach((p, i) => { p.rank = i > 0 && list[i - 1].minutes === p.minutes ? list[i - 1].rank : i + 1; });
  const depts = new Map<string, { department: string; minutes: number; sessions: number; people: number }>();
  for (const p of list) {
    const x = depts.get(p.department) ?? { department: p.department, minutes: 0, sessions: 0, people: 0 };
    x.minutes += p.minutes; x.sessions += p.sessions; x.people++;
    depts.set(p.department, x);
  }
  return {
    period, from: Number.isFinite(from) ? new Date(from).toISOString() : null, now: new Date(now).toISOString(),
    room: gym ? { code: gym.code, name: gym.name } : null,
    capMinutes: VISIT_CAP_MIN,
    totals: {
      minutes: list.reduce((s, p) => s + p.minutes, 0), sessions: list.reduce((s, p) => s + p.sessions, 0),
      people: list.length, crew: crew.length,
    },
    ranking: list,
    top3: list.slice(0, 3),
    departments: [...depts.values()].sort((a, b) => b.minutes - a.minutes),
  };
}

function addVisit(per: Map<number, { ms: number; sessions: number; last: number; ongoing: boolean }>, id: number,
  start: number, end: number, open: boolean, from: number, now: number) {
  const stop = Math.min(end, start + VISIT_CAP_MIN * MIN, now);
  const ms = stop - Math.max(start, from);
  if (ms <= 0) return; // the whole visit is before the period (or has no length)
  const x = per.get(id) ?? { ms: 0, sessions: 0, last: 0, ongoing: false };
  x.ms += ms; x.sessions++;
  if (start >= x.last) { x.last = start; x.ongoing = open && now - start < VISIT_CAP_MIN * MIN; }
  per.set(id, x);
}

// ---------- alarms ----------
export interface AlarmsSummary {
  days: number; total: number; real: number; drill: number; active: boolean;
  byKind: { kind: string; count: number }[];
  ack: { count: number; avgSec: number | null; medianSec: number | null; maxSec: number | null };
  slowestTerminal: { name: string; avgSec: number; acks: number } | null;
  lastAlarm: { kind: string; drill: boolean; at: string } | null;
}

/** Reaction time = first ack of a terminal - alarm start; the terminal that raised the alarm (ack 0 s) is left out. */
export function alarmsSummary(log: unknown[], now = Date.now(), days = 30): AlarmsSummary {
  const from = now - days * DAY;
  const list = log.filter((a: any) => a && typeof a === 'object' && typeof a.at === 'string' && typeof a.kind === 'string'
    && typeof a.drill === 'boolean' && Date.parse(a.at) >= from && Date.parse(a.at) <= now) as any[];
  const secs: number[] = [];
  const perTerm = new Map<string, number[]>();
  const kinds = new Map<string, number>();
  for (const a of list) {
    kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    const t0 = Date.parse(a.at);
    for (const [tid, ack] of Object.entries((a.acks && typeof a.acks === 'object' ? a.acks : {}) as Record<string, any>)) {
      if (tid === a.raisedById || !ack || typeof ack.at !== 'string') continue;
      const s = (Date.parse(ack.at) - t0) / 1000;
      if (!Number.isFinite(s) || s < 0) continue;
      secs.push(s);
      const name = typeof ack.name === 'string' && ack.name ? ack.name.slice(0, 40) : tid.slice(0, 40);
      perTerm.set(name, [...(perTerm.get(name) ?? []), s]);
    }
  }
  const sorted = [...secs].sort((a, b) => a - b);
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  let slowest: AlarmsSummary['slowestTerminal'] = null;
  for (const [name, xs] of perTerm) {
    const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
    if (!slowest || avg > slowest.avgSec) slowest = { name, avgSec: round1(avg), acks: xs.length };
  }
  const newest = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return {
    days, total: list.length, real: list.filter((a) => !a.drill).length, drill: list.filter((a) => a.drill).length,
    active: log.some((a: any) => a && typeof a === 'object' && typeof a.at === 'string' && !a.endedAt),
    byKind: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    ack: {
      count: secs.length,
      avgSec: secs.length ? round1(secs.reduce((s, x) => s + x, 0) / secs.length) : null,
      medianSec: median === null ? null : round1(median),
      maxSec: sorted.length ? round1(sorted[sorted.length - 1]) : null,
    },
    slowestTerminal: slowest,
    lastAlarm: newest ? { kind: newest.kind, drill: newest.drill, at: newest.at } : null,
  };
}

export function readAlarmLog(file = alarmsPath()): unknown[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { log?: unknown };
    return Array.isArray(data.log) ? data.log : [];
  } catch { return []; }
}

// ---------- ship ----------
type Status = 'good' | 'warning' | 'critical';
// "06-19" -> active 06:00..18:59 ship (server) time; "22-06" wraps midnight. Same rule as crew/server/alerts.ts.
function activeAt(hours: string, t: number) {
  const [a, b] = hours.split('-').map(Number);
  const h = new Date(t).getHours();
  return a <= b ? h >= a && h < b : h >= a || h < b;
}
// thresholds as in crew/server/alerts.ts LIMITS
const LONE_WARN_MIN = 30, STALE_WARN_H = 4, CABIN_WARN_H = 12, STALE_CRIT_H = 8, CABIN_CRIT_H = 16, LONE_CRIT_MIN = 60;

export function shipStats(d: DatabaseSync, alarmLog: unknown[], now = Date.now()) {
  const all = rooms(d);
  const crew = crewRows(d);
  const evs = events(d);
  const roomById = new Map(all.map((r) => [r.id, r]));

  // replay the log (as crew/server/alerts.ts): where everyone is, headcount history of staffed rooms, lone workers
  const loc = new Map<number, number | null>();
  const last = new Map<number, { t: number; room: number; dir: string }>();
  const inside = new Map<number, Set<number>>(all.map((r) => [r.id, new Set()]));
  const history = new Map<number, [number, number][]>(all.filter((r) => r.min_staff > 0).map((r) => [r.id, []]));
  const aloneSince = new Map<number, number>();
  for (const e of evs) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t > now || !inside.has(e.room_id)) continue;
    last.set(e.crew_id, { t, room: e.room_id, dir: e.direction });
    const prev = loc.get(e.crew_id) ?? null;
    const next = e.direction === 'in' ? e.room_id : null;
    if (prev === next) continue;
    for (const [rid, add] of [[prev, false], [next, true]] as [number | null, boolean][]) {
      if (rid === null) continue;
      const s = inside.get(rid)!;
      add ? s.add(e.crew_id) : s.delete(e.crew_id);
      history.get(rid)?.push([t, s.size]);
      if (roomById.get(rid)!.hazardous) s.size === 1 ? aloneSince.set(rid, t) : aloneSince.delete(rid);
    }
    loc.set(e.crew_id, next);
  }
  const onboardIds = new Set(crew.filter((c) => (loc.get(c.id) ?? null) !== null).map((c) => c.id));

  // departments and watches: totals and on board now
  const group = (key: (c: CrewRow) => string) => {
    const m = new Map<string, { total: number; onboard: number }>();
    for (const c of crew) {
      const x = m.get(key(c)) ?? { total: 0, onboard: 0 };
      x.total++; if (onboardIds.has(c.id)) x.onboard++;
      m.set(key(c), x);
    }
    return m;
  };
  const departments = [...group((c) => c.department)].map(([department, x]) => ({ department, ...x }))
    .sort((a, b) => b.total - a.total || a.department.localeCompare(b.department, 'pl'));
  const watches = [...group((c) => c.shift)].map(([shift, x]) => ({ shift, ...x }))
    .sort((a, b) => a.shift.localeCompare(b.shift));

  // decks now
  const deckMap = new Map<number, { deck: number; name: string; people: number; rooms: number }>();
  for (const r of all) {
    const x = deckMap.get(r.deck) ?? { deck: r.deck, name: r.deck_name, people: 0, rooms: 0 };
    x.people += inside.get(r.id)!.size; x.rooms++;
    deckMap.set(r.deck, x);
  }
  const decks = [...deckMap.values()].sort((a, b) => b.deck - a.deck);

  // rooms now
  const occ = all.map((r) => {
    const people = inside.get(r.id)!.size;
    return { code: r.code, name: r.name, role: r.role, deck: r.deck, people, capacity: r.capacity,
      occupancy: round1((people * 100) / r.capacity) };
  });
  const busyRooms = occ.filter((r) => r.people > 0)
    .sort((a, b) => b.occupancy - a.occupancy || b.people - a.people).slice(0, 8);
  const overCapacity = occ.filter((r) => r.people > r.capacity).sort((a, b) => b.occupancy - a.occupancy);

  // check-ins per hour, last 24 h; the last bucket is the current hour (same buckets as crew /api/activity)
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const perHour = Array.from({ length: 24 }, (_, i) => ({ start: new Date(end - (24 - i) * HOUR).toISOString(), count: 0 }));
  for (const e of evs) {
    const t = Date.parse(e.at);
    if (t > now) continue;
    const i = 23 - Math.floor((end - 1 - t) / HOUR);
    if (i >= 0 && i < 24) perHour[i].count++;
  }

  // staffing of key rooms: now + share of the last 24 h (minute steps) in which the minimum was met
  const staffing = all.filter((r) => r.min_staff > 0).sort((a, b) => b.deck - a.deck || a.code.localeCompare(b.code)).map((r) => {
    const h = history.get(r.id)!;
    let i = 0, n = 0, activeMin = 0, okMin = 0;
    for (let t = now - DAY; t <= now; t += MIN) {
      while (i < h.length && h[i][0] <= t) n = h[i++][1];
      if (!activeAt(r.staff_hours, t)) continue;
      activeMin++;
      if (n >= r.min_staff) okMin++;
    }
    const people = inside.get(r.id)!.size;
    const isActive = activeAt(r.staff_hours, now);
    const ok = !isActive || people >= r.min_staff;
    return {
      code: r.code, name: r.name, deck: r.deck, minStaff: r.min_staff, hours: r.staff_hours, active: isActive, people,
      status: (ok ? 'good' : people === 0 ? 'critical' : 'warning') as Status,
      coverage24h: activeMin ? round1((okMin / activeMin) * 100) : 100,
    };
  });

  // active alerts (counts only, thresholds of crew/server/alerts.ts)
  const lone = [...aloneSince.values()].map((t) => (now - t) / MIN);
  const stale = crew.map((c) => {
    const l = last.get(c.id);
    if (!l) return 'critical' as const;
    if (l.dir === 'out') return 'good' as const; // ashore
    const hours = (now - l.t) / HOUR;
    const [w, cr] = l.room === c.cabin_id ? [CABIN_WARN_H, CABIN_CRIT_H] : [STALE_WARN_H, STALE_CRIT_H];
    return hours >= cr ? 'critical' as const : hours >= w ? 'warning' as const : 'good' as const;
  });
  const alerts = {
    staffing: { critical: staffing.filter((s) => s.status === 'critical').length, warning: staffing.filter((s) => s.status === 'warning').length },
    lone: { critical: lone.filter((m) => m >= LONE_CRIT_MIN).length, warning: lone.filter((m) => m >= LONE_WARN_MIN && m < LONE_CRIT_MIN).length },
    lastCheckin: { critical: stale.filter((s) => s === 'critical').length, warning: stale.filter((s) => s === 'warning').length },
    total: 0,
  };
  alerts.total = alerts.staffing.critical + alerts.staffing.warning + alerts.lone.critical + alerts.lone.warning
    + alerts.lastCheckin.critical + alerts.lastCheckin.warning;

  // embarkations (counts, no names)
  const emb = (days: number) => crew.filter((c) => {
    const t = Date.parse(c.embarked_at);
    return Number.isFinite(t) && t <= now && now - t <= days * DAY;
  }).length;
  const embDays = crew.map((c) => (now - Date.parse(c.embarked_at)) / DAY).filter((x) => Number.isFinite(x) && x >= 0);

  return {
    now: new Date(now).toISOString(),
    crew: { total: crew.length, onboard: onboardIds.size, ashore: crew.length - onboardIds.size },
    checkins24h: perHour.reduce((s, b) => s + b.count, 0),
    departments, decks, watches,
    rooms: { total: all.length, occupied: occ.filter((r) => r.people > 0).length, busy: busyRooms, overCapacity },
    checkinsPerHour: perHour,
    staffing,
    alerts,
    alarms: alarmsSummary(alarmLog, now),
    embarked: {
      last7d: emb(7), last30d: emb(30),
      medianDaysOnBoard: embDays.length ? Math.round([...embDays].sort((a, b) => a - b)[Math.floor(embDays.length / 2)]) : null,
    },
  };
}
export type ShipStats = ReturnType<typeof shipStats>;

// ---------- HTTP ----------
function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

export async function handleStatsHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let u: URL;
  try { u = new URL(req.url || '/', 'http://x'); } catch { return false; }
  const p = u.pathname;
  if (p !== '/api/stats' && !p.startsWith('/api/stats/')) return false;
  const t0 = Date.now();
  const log = (status: number) => { if (status !== 200) console.log(`[assistant] stats ${p} ${status} ${Date.now() - t0}ms`); };

  const cors = corsOrigin(req);
  if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('vary', 'origin'); res.setHeader('access-control-allow-credentials', 'true'); }
  if (req.method === 'OPTIONS') {
    if (!cors) { send(res, 403, { error: 'forbidden' }); return true; }
    res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'x-assistant-token', 'access-control-max-age': '600' });
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'GET only' }, { allow: 'GET' }); log(405); return true; }
  if (!originAllowed(req) || !tokenOk(req)) { send(res, 403, { error: 'forbidden' }); log(403); return true; }
  const check = accessCheck ?? await autoCheck();
  if (check) {
    let ok = false;
    try { ok = await check(req); } catch { ok = false; }
    if (!ok) { send(res, 401, { error: 'login required' }); log(401); return true; }
  }
  const rate = takeCrewToken(clientIp(req));
  if (!rate.ok) { send(res, 429, { error: 'rate limited' }, { 'retry-after': String(rate.retryAfter) }); log(429); return true; }

  const sub = p.slice('/api/stats/'.length);
  if (sub !== 'gym' && sub !== 'ship') { send(res, 404, { error: 'not found' }); log(404); return true; }
  const allowed = sub === 'gym' ? ['period'] : [];
  for (const k of u.searchParams.keys()) if (!allowed.includes(k)) { send(res, 400, { error: `unknown parameter: ${k.slice(0, 20)}` }); log(400); return true; }
  let period: Period = '7d';
  if (sub === 'gym') {
    const raw = u.searchParams.getAll('period');
    if (raw.length > 1 || (raw.length === 1 && !isPeriod(raw[0]))) { send(res, 400, { error: 'period must be 7d, 30d or all' }); log(400); return true; }
    if (raw.length) period = raw[0] as Period;
  }
  let d: DatabaseSync;
  try { d = openCrewDb(); } catch (e) {
    console.error('[assistant] stats: crew database unavailable:', e instanceof Error ? e.message : e);
    send(res, 503, { error: 'crew database unavailable' }); log(503); return true;
  }
  try {
    const body = sub === 'gym'
      ? cached('gym:' + period, () => gymStats(d, period))
      : cached('ship', () => shipStats(d, readAlarmLog()));
    send(res, 200, body);
  } catch (e) {
    console.error('[assistant] stats:', e instanceof Error ? e.message : e);
    resetStats(); // reopen next time (file replaced, schema changed)
    send(res, 503, { error: 'crew database unavailable' }); log(503);
  }
  return true;
}
