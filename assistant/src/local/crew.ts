// Crew data for the local engine, behind one small interface (CrewSource):
//  - httpCrewSource(): the browser reads the assistant server's read-only proxy /api/crew/* (same origin, optional
//    x-assistant-token). 401 (login required) -> CrewError('auth'); anything else that fails -> CrewError('down').
//  - the server builds its own source from its crew tools (server/local.ts).
// Answers only use: name, rank, room (name + code + ship-model zone), minutes since the last check-in.
import { CREW_ROOM_PLACES } from '../../shared/crew-map.ts';
import { fold } from './text.ts';

export interface CrewPerson { name: string; rank: string; room: string | null; code: string | null; zone: string | null; minutesAgo: number | null }
export interface CrewRoom { code: string; name: string; zone: string | null; people: CrewPerson[]; minStaff: number; staffHours: string; hazardous: boolean }
export interface CrewSummary { crew: number; onboard: number; ashore: number; lastMinutesAgo: number | null; byZone: Record<string, number> }
export interface CrewAlerts {
  lone: { person: string | null; room: string; zone: string | null; minutes: number; status: string }[];
  under: { room: string; zone: string | null; people: number; min: number }[];
  stale: { name: string; rank: string; room: string | null; hours: number }[];
}
export interface CrewSource {
  /** people whose name / rank / room contains every word of `query` (diacritics-insensitive); `total` = all matches */
  find(query: string): Promise<{ total: number; crew: CrewPerson[] }>;
  /** one room by its code ("D4-01"); null when the database does not know it */
  room(code: string): Promise<CrewRoom | null>;
  summary(): Promise<CrewSummary>;
  alerts(): Promise<CrewAlerts>;
}

export class CrewError extends Error {
  kind: 'down' | 'auth';
  constructor(kind: 'down' | 'auth', msg: string = kind) { super(msg); this.kind = kind; }
}

export const minutesSince = (iso: unknown, now = Date.now()) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
};
export const zoneOfCode = (code: unknown) => (typeof code === 'string' && CREW_ROOM_PLACES[code]?.zone) || null;

/** find() semantics shared by both sources: every query word is in "name rank room" (folded) */
export function matchCrew(all: CrewPerson[], query: string): { total: number; crew: CrewPerson[] } {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hits = all.filter((c) => {
    const hay = fold([c.name, c.rank, c.room ?? ''].join(' '));
    return words.every((w) => hay.includes(w));
  });
  return { total: hits.length, crew: hits.slice(0, 8) };
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Crew source over the /api/crew/* proxy (browser; also usable from Node with an absolute `base`). */
export function httpCrewSource(base = '', headers: Record<string, string> = {}, timeoutMs = 4000): CrewSource {
  const get = async (p: string): Promise<Json> => {
    let r: Response;
    try {
      r = await fetch(base + '/api/crew/' + p, { headers, credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw new CrewError('down', e instanceof Error ? e.message : String(e)); }
    if (r.status === 401) throw new CrewError('auth');
    if (r.status === 404) return null;
    if (!r.ok) throw new CrewError('down', `status ${r.status}`);
    try { return await r.json(); } catch { throw new CrewError('down', 'bad JSON'); }
  };
  const person = (c: Json): CrewPerson => ({
    name: String(c?.name ?? ''), rank: String(c?.rank ?? ''),
    room: c?.room?.name ?? null, code: c?.room?.code ?? null, zone: c?.room?.zone ?? zoneOfCode(c?.room?.code),
    minutesAgo: minutesSince(c?.since),
  });
  return {
    async find(query) {
      const all = await get('crew');
      return matchCrew(Array.isArray(all) ? all.map(person) : [], query);
    },
    async room(code) {
      const rooms = await get('rooms');
      const row = Array.isArray(rooms) ? rooms.find((r: Json) => r.code === code) : null;
      if (!row) return null;
      const full = await get('rooms/' + row.id);
      if (!full) return null;
      return {
        code, name: String(full.name ?? row.name), zone: full.place?.zone ?? zoneOfCode(code),
        people: Array.isArray(full.crew) ? full.crew.map(person) : [],
        minStaff: Number(full.min_staff) || 0, staffHours: String(full.staff_hours ?? ''), hazardous: !!full.hazardous,
      };
    },
    async summary() {
      const [s, rooms] = await Promise.all([get('summary'), get('rooms')]);
      const byZone: Record<string, number> = {};
      for (const r of Array.isArray(rooms) ? rooms : []) {
        const z = r.place?.zone ?? zoneOfCode(r.code) ?? 'unmapped';
        byZone[z] = (byZone[z] ?? 0) + (Number(r.people) || 0);
      }
      return { crew: Number(s?.crew) || 0, onboard: Number(s?.onboard) || 0, ashore: Number(s?.ashore) || 0, lastMinutesAgo: minutesSince(s?.lastCheckin), byZone };
    },
    async alerts() {
      const a = (await get('alerts')) ?? {};
      return {
        lone: (a.lone ?? []).map((x: Json) => ({ person: x.crew ? `${x.crew.name} (${x.crew.rank})` : null, room: x.name, zone: zoneOfCode(x.code), minutes: Number(x.minutes) || 0, status: x.status })),
        under: (a.staffing ?? []).filter((x: Json) => x.status !== 'good').map((x: Json) => ({ room: x.name, zone: zoneOfCode(x.code), people: Number(x.people) || 0, min: Number(x.min_staff) || 0 })),
        stale: (a.lastCheckin ?? []).filter((x: Json) => x.status === 'warning' || x.status === 'critical').slice(0, 10)
          .map((x: Json) => ({ name: x.name, rank: x.rank, room: x.room ?? null, hours: Number(x.hours) || 0 })),
      };
    },
  };
}
