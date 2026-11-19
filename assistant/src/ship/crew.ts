// Live crew data for the "Załoga" layer of the ship view: terminals, rooms with headcounts, people and safety alerts
// from the crew database (teammates' crew/ server) through the assistant's read-only proxy /api/crew/*.
// The proxy adds `place: {zone, at}` to rooms and terminals; when it is missing we compute it from the shared map.
import { useEffect, useMemo, useState } from 'react';
import { CREW_ROOM_PLACES, terminalAt, type CrewZone } from '../../shared/crew-map';
import { ZONE, type Text2, type Vec3, type ZoneId } from './routes';

export const CREW_API = '/api/crew';
const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;

export type Severity = 'critical' | 'warning';
export interface Place { zone: CrewZone; at: Vec3 }

export interface CrewTerminal { code: string; room_code: string; room_name: string; place: Place | null }
export interface CrewRoom {
  id: number; code: string; name: string; capacity: number; people: number; occupancy: number;
  min_staff: number; hazardous: number; restricted: number; terminals: number; place: Place | null;
}
export interface CrewPerson { id: number; name: string; rank: string; department: string; room_code: string; since: string | null }
export interface CrewAlert { room: string; severity: Severity; text: Text2 }

export interface ZoneCrew {
  zone: CrewZone;
  people: number;
  rooms: CrewRoom[];
  persons: CrewPerson[];
  severity: Severity | null;
  alerts: CrewAlert[];
}

export interface CrewData {
  status: 'loading' | 'ok' | 'down';
  terminals: CrewTerminal[];
  rooms: CrewRoom[];
  people: CrewPerson[];
  alerts: CrewAlert[];
  /** worst alert per room code */
  roomSeverity: Record<string, Severity>;
  byZone: Partial<Record<CrewZone, ZoneCrew>>;
  updated: number | null;
}

/** crew zones in display order (top of the ship first) */
export const CREW_ZONES: CrewZone[] = [
  'bridge', 'boat-deck', 'restaurant', 'lounge', 'reclining-lounge', 'cabins-fwd', 'cabins-mid', 'cabins-aft',
  'vehicle-d2', 'vehicle-d1', 'engine-room', 'engine-control',
];
const BOAT_DECK: { name: Text2; deck: Text2 } = {
  name: { pl: 'Pokład szalupowy (stacja ratunkowa)', en: 'Boat deck (muster station)' },
  deck: { pl: 'Pokład 5', en: 'Deck 5' },
};
export const crewZoneName = (z: CrewZone): Text2 => (z === 'boat-deck' ? BOAT_DECK.name : ZONE[z as ZoneId].name);
export const crewZoneDeck = (z: CrewZone): Text2 => (z === 'boat-deck' ? BOAT_DECK.deck : ZONE[z as ZoneId].deck);

/** where the headcount badge of a zone floats (top of the zone box) */
export function zoneBadgeAt(z: CrewZone): Vec3 {
  if (z === 'boat-deck') return [12, 22, -40];
  const b = ZONE[z as ZoneId].box;
  return [(b.min[0] + b.max[0]) / 2, b.max[1] + 0.8, (b.min[2] + b.max[2]) / 2];
}

const sevRank = (s: Severity | null | undefined) => (s === 'critical' ? 2 : s === 'warning' ? 1 : 0);
export const worse = (a: Severity | null | undefined, b: Severity | null | undefined): Severity | null =>
  (sevRank(a) >= sevRank(b) ? a : b) ?? null;

/** "HH:MM" in the viewer's time */
export function hhmm(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function roomPlace(code: string, given: unknown): Place | null {
  const g = given as Place | null | undefined;
  if (g && typeof g.zone === 'string' && Array.isArray(g.at)) return g;
  const p = CREW_ROOM_PLACES[code];
  return p ? { zone: p.zone, at: p.at } : null;
}

// ---- raw API shapes (only the fields we use) ----
interface RawTerminal { code: string; room_code: string; room_name: string; place?: Place | null }
interface RawRoom { id: number; code: string; name: string; capacity: number; people: number; occupancy: number; min_staff: number; hazardous: number; restricted: number; terminals: number; place?: Place | null }
interface RawCrew { id: number; first_name: string; last_name: string; rank: string; department: string; room_code: string | null; since: string | null }
interface RawPerson { name: string; rank: string }
interface RawAlerts {
  staffing: { code: string; people: number; min_staff: number; status: string }[];
  lone: { code: string; minutes: number; crew: RawPerson; status: string }[];
  lastCheckin: (RawPerson & { room: string | null; hours: number | null; status: string })[];
}

const isSev = (s: string): s is Severity => s === 'critical' || s === 'warning';

function build(t: RawTerminal[], r: RawRoom[], c: RawCrew[], a: RawAlerts): Omit<CrewData, 'status' | 'updated'> {
  const terminals: CrewTerminal[] = t.map((x) => {
    let place = x.place && Array.isArray(x.place.at) ? x.place : null;
    if (!place) {
      const at = terminalAt(x.room_code, x.code);
      const rp = CREW_ROOM_PLACES[x.room_code];
      place = at && rp ? { zone: rp.zone, at } : null;
    }
    return { code: x.code, room_code: x.room_code, room_name: x.room_name, place };
  });
  const rooms: CrewRoom[] = r.map((x) => ({
    id: x.id, code: x.code, name: x.name, capacity: x.capacity, people: x.people, occupancy: x.occupancy,
    min_staff: x.min_staff, hazardous: x.hazardous, restricted: x.restricted, terminals: x.terminals, place: roomPlace(x.code, x.place),
  }));
  const people: CrewPerson[] = c.filter((x) => x.room_code).map((x) => ({
    id: x.id, name: `${x.first_name} ${x.last_name}`, rank: x.rank, department: x.department, room_code: x.room_code as string, since: x.since,
  }));

  const codeByName = new Map(rooms.map((x) => [x.name, x.code]));
  const alerts: CrewAlert[] = [];
  for (const s of a.staffing ?? []) if (isSev(s.status)) alerts.push({ room: s.code, severity: s.status,
    text: { pl: `Obsada poniżej minimum: ${s.people} z ${s.min_staff} os.`, en: `Below minimum staffing: ${s.people} of ${s.min_staff}` } });
  for (const s of a.lone ?? []) if (isSev(s.status)) alerts.push({ room: s.code, severity: s.status,
    text: { pl: `Samotna praca od ${s.minutes} min: ${s.crew.name}`, en: `Working alone for ${s.minutes} min: ${s.crew.name}` } });
  for (const s of a.lastCheckin ?? []) {
    const code = s.room ? codeByName.get(s.room) : undefined;
    if (!code || !isSev(s.status)) continue;
    const h = String(s.hours ?? '?');
    alerts.push({ room: code, severity: s.status,
      text: { pl: `Brak odbicia karty od ${h.replace('.', ',')} h: ${s.name} (${s.rank})`, en: `No card check-in for ${h} h: ${s.name} (${s.rank})` } });
  }
  alerts.sort((x, y) => sevRank(y.severity) - sevRank(x.severity));

  const roomSeverity: Record<string, Severity> = {};
  for (const al of alerts) roomSeverity[al.room] = worse(roomSeverity[al.room], al.severity) as Severity;

  const byZone: Partial<Record<CrewZone, ZoneCrew>> = {};
  const roomZone = new Map<string, CrewZone>();
  for (const room of rooms) {
    if (!room.place) continue;
    const z = room.place.zone;
    roomZone.set(room.code, z);
    const e = byZone[z] ??= { zone: z, people: 0, rooms: [], persons: [], severity: null, alerts: [] };
    e.people += room.people;
    e.rooms.push(room);
    e.severity = worse(e.severity, roomSeverity[room.code]);
  }
  for (const p of people) { const z = roomZone.get(p.room_code); if (z) byZone[z]!.persons.push(p); }
  for (const al of alerts) { const z = roomZone.get(al.room); if (z) byZone[z]!.alerts.push(al); }
  for (const e of Object.values(byZone)) e!.persons.sort((x, y) => x.name.localeCompare(y.name, 'pl'));
  return { terminals, rooms, people, alerts, roomSeverity, byZone };
}

const EMPTY: CrewData = { status: 'loading', terminals: [], rooms: [], people: [], alerts: [], roomSeverity: {}, byZone: {}, updated: null };

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${CREW_API}/${path}`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Polls the crew database every 5 s while `enabled` and the page is visible; backs off on errors. */
export function useCrewData(enabled: boolean): CrewData {
  const [data, setData] = useState<CrewData>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | null = null;
    let fails = 0;
    let stopped = false;

    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(run, ms); };
    async function run() {
      if (stopped) return;
      if (document.visibilityState !== 'visible') return; // resumed by visibilitychange
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      const kill = setTimeout(() => c.abort(), 8000);
      try {
        const [t, r, p, a] = await Promise.all([
          getJson<RawTerminal[]>('terminals', c.signal),
          getJson<RawRoom[]>('rooms', c.signal),
          getJson<RawCrew[]>('crew', c.signal),
          getJson<RawAlerts>('alerts', c.signal),
        ]);
        if (stopped) return;
        fails = 0;
        setData({ status: 'ok', ...build(t, r, p, a), updated: Date.now() });
        schedule(POLL_MS);
      } catch {
        if (stopped) return;
        fails++;
        setData((d) => (d.status === 'down' ? d : { ...EMPTY, status: 'down' }));
        schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(fails, 4)));
      } finally {
        clearTimeout(kill);
      }
    }
    const onVis = () => { if (document.visibilityState === 'visible') schedule(0); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVis);
    run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);

  return data;
}

/** crew zones an evacuation route passes through (any waypoint inside the zone box) + the boat deck */
export function useRouteZones(points: Vec3[], start: ZoneId): CrewZone[] {
  return useMemo(() => {
    const out = new Set<CrewZone>([start, 'boat-deck']);
    for (const z of Object.values(ZONE)) {
      const { min, max } = z.box;
      if (points.some((p) => p[0] >= min[0] - 0.5 && p[0] <= max[0] + 0.5 && p[1] >= min[1] - 0.5 && p[1] <= max[1] + 0.5 && p[2] >= min[2] - 0.5 && p[2] <= max[2] + 0.5)) out.add(z.id);
    }
    return [...out];
  }, [points, start]);
}
