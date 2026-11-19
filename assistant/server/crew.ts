// Crew database link (teammates' `crew/` server, see assistant/CONTRACT-CREW.md).
//  - client: GET <CREW_API>/api/... with a 2 s timeout and a 3 s in-memory cache per path (in-flight requests shared).
//    CREW_API defaults to http://127.0.0.1:8790; set CREW_API=off (or empty) to switch the crew features off.
//  - handleCrewProxy: read-only proxy for the browser, GET /api/crew/{summary|rooms|rooms/:id|crew?q=|terminals|activity|alerts}.
//    Same JSON as the crew server; rooms and terminals get `place: { zone, at } | null` from shared/crew-map.ts;
//    crew rows (crew?q= and rooms/:id .crew) lose birth_date, nationality and badge.
//    Same origin / x-assistant-token check as the chat, own rate limit (120 / min / IP), 503 when the database is down.
//  - CREW_TOOLS + runCrewTool: read-only Claude tools for the chat; results are compact JSON, no birth date / nationality
//    unless the tool input says `details: true`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { CREW_ROOM_PLACES, terminalAt, type CrewZone } from '../shared/crew-map.ts';
import { clientIp, corsOrigin, originAllowed, takeCrewToken, tokenOk } from './guard.ts';

const RAW = process.env.CREW_API === undefined ? 'http://127.0.0.1:8790' : process.env.CREW_API.trim();
export const CREW_API = RAW.replace(/\/+$/, '');
export const crewEnabled = !!CREW_API && CREW_API.toLowerCase() !== 'off';
const TIMEOUT_MS = 2000;
const CACHE_MS = 3000;

// ---------- client ----------
export class CrewDown extends Error {}
export class CrewNotFound extends Error {}

const cache = new Map<string, { t: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/** GET a crew API path (e.g. "/api/rooms"). Throws CrewNotFound on 404, CrewDown on anything else that is not 200. */
export async function crewGet<T = any>(p: string): Promise<T> {
  if (!crewEnabled) throw new CrewDown('crew database not configured');
  const hit = cache.get(p);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data as T;
  let pending = inflight.get(p);
  if (!pending) {
    pending = (async () => {
      let r: Response;
      try {
        r = await fetch(CREW_API + p, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
      } catch (e) { throw new CrewDown(e instanceof Error ? e.message : String(e)); }
      if (r.status === 404) { await r.arrayBuffer().catch(() => {}); throw new CrewNotFound(p); }
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); throw new CrewDown(`status ${r.status}`); }
      let data: unknown;
      try { data = await r.json(); } catch { throw new CrewDown('bad JSON'); }
      cache.set(p, { t: Date.now(), data });
      if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.t >= CACHE_MS) cache.delete(k);
      return data;
    })().finally(() => inflight.delete(p));
    inflight.set(p, pending);
  }
  return (await pending) as T;
}

// ---------- places ----------
interface Place { zone: CrewZone; at: [number, number, number] }
const roomPlace = (code: string): Place | null => {
  const p = CREW_ROOM_PLACES[code];
  return p ? { zone: p.zone, at: p.at } : null;
};
const terminalPlace = (roomCode: string, code: string): Place | null => {
  const p = CREW_ROOM_PLACES[roomCode];
  const at = terminalAt(roomCode, code);
  return p && at ? { zone: p.zone, at } : null;
};
const zoneOf = (code: string | null | undefined): CrewZone | null => (code && CREW_ROOM_PLACES[code]?.zone) || null;

// ---------- proxy ----------
/** Fields the browser never gets from the proxy (the map UI does not show them): crew lists drop them. */
const PRIVATE_FIELDS = ['birth_date', 'nationality', 'badge'];
const publicPerson = (c: any) => {
  if (!c || typeof c !== 'object') return c;
  const out = { ...c };
  for (const k of PRIVATE_FIELDS) delete out[k];
  return out;
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

/** Handles /api/crew/*; returns false for any other URL (the caller goes on routing). */
export async function handleCrewProxy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let u: URL;
  try { u = new URL(req.url || '/', 'http://x'); } catch { return false; }
  const p = u.pathname;
  if (p !== '/api/crew' && !p.startsWith('/api/crew/')) return false;
  const t0 = Date.now();
  const log = (status: number) => { if (status !== 200) console.log(`[assistant] crew ${p} ${status} ${Date.now() - t0}ms`); };

  const cors = corsOrigin(req);
  if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('vary', 'origin'); }
  if (req.method === 'OPTIONS') {
    if (!cors) { send(res, 403, { error: 'forbidden' }); return true; }
    res.writeHead(204, {
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': 'x-assistant-token',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'GET only' }, { allow: 'GET' }); log(405); return true; }
  if (!originAllowed(req) || !tokenOk(req)) { send(res, 403, { error: 'forbidden' }); log(403); return true; }
  const rate = takeCrewToken(clientIp(req));
  if (!rate.ok) { send(res, 429, { error: 'rate limited' }, { 'retry-after': String(rate.retryAfter) }); log(429); return true; }

  const sub = p.slice('/api/crew/'.length);
  let upstream: string;
  let shape: (data: any) => unknown = (d) => d;
  let m: RegExpExecArray | null;
  if (sub === 'summary' || sub === 'activity' || sub === 'alerts') upstream = '/api/' + sub;
  else if (sub === 'rooms') {
    upstream = '/api/rooms';
    shape = (rows: any[]) => Array.isArray(rows) ? rows.map((r) => ({ ...r, place: roomPlace(r.code) })) : rows;
  } else if ((m = /^rooms\/(\d{1,9})$/.exec(sub))) {
    upstream = '/api/rooms/' + m[1];
    shape = (r: any) => (r && typeof r === 'object'
      ? { ...r, ...(Array.isArray(r.crew) ? { crew: r.crew.map(publicPerson) } : {}), place: roomPlace(r.code) }
      : r);
  } else if (sub === 'terminals') {
    upstream = '/api/terminals';
    shape = (rows: any[]) => Array.isArray(rows) ? rows.map((t) => ({ ...t, place: terminalPlace(t.room_code, t.code) })) : rows;
  } else if (sub === 'crew') {
    const q = (u.searchParams.get('q') ?? '').slice(0, 64);
    upstream = '/api/crew' + (q ? '?q=' + encodeURIComponent(q) : '');
    shape = (rows: any[]) => Array.isArray(rows) ? rows.map(publicPerson) : rows;
  } else { send(res, 404, { error: 'not found' }); log(404); return true; }

  if (!crewEnabled) { send(res, 503, { error: 'crew database unavailable' }); log(503); return true; }
  try {
    send(res, 200, shape(await crewGet(upstream)));
  } catch (e) {
    if (e instanceof CrewNotFound) { send(res, 404, { error: 'not found' }); log(404); return true; }
    console.warn(`[assistant] crew database: ${e instanceof Error ? e.message : e}`);
    send(res, 503, { error: 'crew database unavailable' });
    log(503);
  }
  return true;
}

// ---------- tools ----------
// strict: true on the tools that take arguments (grammar-constrained inputs); the inputs are validated again in runCrewTool.
export const CREW_TOOLS: BetaToolUnion[] = [
  {
    name: 'crew_summary',
    description: 'Live headline numbers of the crew database: crew total, on board, ashore, rooms, terminals, check-ins in the last '
      + '24 h, time of the last card tap, and how many people are in each ship zone right now. Use for "ile osób jest na pokładzie".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }, // no arguments: strict adds nothing
  },
  {
    name: 'find_crew',
    description: 'Find crew members by name, surname, rank (e.g. "bosman", "kapitan", "II mechanik"), department or badge (e.g. "B-1006") '
      + 'and tell where each one is now (room from the last card check-in, zone on the ship model, since when), their cabin and phone '
      + 'extension. Returns at most 8 matches. Set details to true only when an officer explicitly needs nationality or date of birth.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, surname, rank, department or badge; several words must all match.' },
        details: { type: 'boolean', description: 'Also return nationality, date of birth and embarkation date. Default false.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_people',
    description: 'Who is in a room right now: people inside (name, rank, since when), capacity, occupancy in %, minimum staffing, '
      + 'whether the room is hazardous or restricted, and its zone on the ship model. The room is a code like "D1-01" or part of '
      + 'its Polish name like "maszynownia", "mostek", "kuchnia".',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { room: { type: 'string', description: 'Room code (e.g. "D4-01") or a fragment of the room name.' } },
      required: ['room'],
      additionalProperties: false,
    },
  },
  {
    name: 'safety_alerts',
    description: 'Current safety alerts from the check-in log: key rooms below minimum staffing, lone workers in hazardous rooms '
      + '(and for how long), and people whose last check-in is too old (possible lost card, or someone to check on).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }, // no arguments: strict adds nothing
  },
  {
    name: 'list_terminals',
    description: 'List the card check-in terminals: terminal code, room code, room name and ship zone.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }, // no arguments: strict adds nothing
  },
];
export const CREW_TOOL_NAMES = new Set(CREW_TOOLS.map((t) => (t as { name: string }).name));

export interface ToolOutput { content: string; isError: boolean }
class BadInput extends Error {}

const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
const minutesAgo = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
};

function inputObj(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadInput('input must be an object');
  return input as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !v.trim()) throw new BadInput(`"${k}" must be a non-empty string`);
  if (v.length > 100) throw new BadInput(`"${k}" is too long`);
  return v.trim();
}
function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new BadInput(`"${k}" must be a boolean`);
  return v;
}

function person(c: any, details: boolean) {
  const out: Record<string, unknown> = {
    name: `${c.first_name} ${c.last_name}`, rank: c.rank, department: c.department, badge: c.badge, shift: c.shift,
    on_board: c.room_id != null,
    where: c.room_name ?? null, room_code: c.room_code ?? null, zone: zoneOf(c.room_code),
    since: c.since ?? null, minutes_ago: minutesAgo(c.since),
    cabin: c.cabin ?? null, phone_ext: c.phone_ext ?? null,
  };
  if (details) Object.assign(out, { nationality: c.nationality ?? null, birth_date: c.birth_date ?? null, embarked_at: c.embarked_at ?? null });
  return out;
}

async function findCrew(o: Record<string, unknown>) {
  const query = str(o, 'query');
  const details = bool(o, 'details');
  const words = fold(query).split(/\s+/).filter(Boolean);
  const all = await crewGet<any[]>('/api/crew');
  const hits = all.filter((c) => {
    const hay = fold([c.first_name, c.last_name, c.rank, c.badge, c.department, c.room_name].join(' '));
    return words.every((w) => hay.includes(w));
  });
  return { query, matches: hits.length, crew: hits.slice(0, 8).map((c) => person(c, details)) };
}

async function roomPeople(o: Record<string, unknown>) {
  const q = str(o, 'room');
  const fq = fold(q);
  const rooms = await crewGet<any[]>('/api/rooms');
  const byCode = rooms.find((r) => fold(r.code) === fq);
  const byName = rooms.filter((r) => fold(r.name) === fq);
  const partial = rooms.filter((r) => fold(r.name).includes(fq) || fold(r.role).includes(fq));
  const room = byCode ?? byName[0] ?? partial[0];
  if (!room) return { found: false, query: q, rooms: rooms.map((r) => `${r.code} ${r.name}`) };
  const full = await crewGet<any>(`/api/rooms/${room.id}`);
  return {
    found: true,
    code: full.code, name: full.name, deck: full.deck, deck_name: full.deck_name, zone: zoneOf(full.code),
    people: full.people, capacity: full.capacity, occupancy_pct: full.occupancy,
    min_staff: full.min_staff, staff_hours: full.staff_hours, hazardous: !!full.hazardous, restricted: !!full.restricted,
    crew: (full.crew ?? []).map((c: any) => ({ name: `${c.first_name} ${c.last_name}`, rank: c.rank, since: c.since, minutes_ago: minutesAgo(c.since) })),
    also_matching: partial.filter((r) => r !== room).slice(0, 5).map((r) => `${r.code} ${r.name}`),
  };
}

async function crewSummary() {
  const [s, rooms] = await Promise.all([crewGet<any>('/api/summary'), crewGet<any[]>('/api/rooms')]);
  const byZone: Record<string, number> = {};
  for (const r of rooms) {
    const z = zoneOf(r.code) ?? 'unmapped';
    byZone[z] = (byZone[z] ?? 0) + (Number(r.people) || 0);
  }
  return { ...s, last_checkin_minutes_ago: minutesAgo(s.lastCheckin), people_by_zone: byZone };
}

async function safetyAlerts() {
  const a = await crewGet<any>('/api/alerts');
  const staffing = (a.staffing ?? []) as any[];
  return {
    counts: a.counts,
    understaffed: staffing.filter((s) => s.status !== 'good').map((s) => ({
      room: s.name, code: s.code, zone: zoneOf(s.code), status: s.status, people: s.people, min_staff: s.min_staff,
      staff_hours: s.staff_hours, understaffed_since: s.understaffed_since, understaffed_all_day: s.understaffed_all_day,
      crew: (s.crew ?? []).map((c: any) => `${c.name} (${c.rank})`),
    })),
    staffing_ok: staffing.filter((s) => s.status === 'good').map((s) => `${s.code} ${s.name}: ${s.people}/${s.min_staff}`),
    lone_workers: ((a.lone ?? []) as any[]).map((l) => ({
      room: l.name, code: l.code, zone: zoneOf(l.code), status: l.status, minutes: l.minutes, since: l.since,
      person: l.crew ? `${l.crew.name} (${l.crew.rank})` : null,
    })),
    stale_checkins: ((a.lastCheckin ?? []) as any[]).filter((c) => c.status === 'warning' || c.status === 'critical').slice(0, 10)
      .map((c) => ({ name: c.name, rank: c.rank, status: c.status, last_room: c.room, in_cabin: c.in_cabin, hours: c.hours })),
    limits: a.limits,
  };
}

async function listTerminals() {
  const rows = await crewGet<any[]>('/api/terminals');
  return { terminals: rows.map((t) => ({ code: t.code, room_code: t.room_code, room: t.room_name, zone: zoneOf(t.room_code) })) };
}

/** Run one crew tool. Never throws: failures come back as { isError: true } for an is_error tool_result. */
export async function runCrewTool(name: string, input: unknown): Promise<ToolOutput> {
  const ok = (v: unknown): ToolOutput => ({ content: JSON.stringify(v), isError: false });
  const err = (error: string): ToolOutput => ({ content: JSON.stringify({ error }), isError: true });
  try {
    switch (name) {
      case 'crew_summary': return ok(await crewSummary());
      case 'find_crew': return ok(await findCrew(inputObj(input)));
      case 'room_people': return ok(await roomPeople(inputObj(input)));
      case 'safety_alerts': return ok(await safetyAlerts());
      case 'list_terminals': return ok(await listTerminals());
      default: return err(`unknown tool ${name}`);
    }
  } catch (e) {
    if (e instanceof BadInput) return err('invalid input: ' + e.message);
    if (e instanceof CrewDown || e instanceof CrewNotFound) {
      console.warn(`[assistant] crew tool ${name}: database unavailable (${e.message})`);
      return err('crew database unavailable');
    }
    console.warn(`[assistant] crew tool ${name}:`, e instanceof Error ? e.message : e);
    return err('crew tool failed');
  }
}
