// Safety statistics computed by replaying the check-in log in time order:
//  - staffing: rooms with a required minimum crew (bridge, ECR, ...) - is it met now, since when not, % of last 24 h covered
//  - lone workers: someone alone in a hazardous room, and for how long
//  - last check-in: time since each person's last card tap (a lost card, or someone who may need checking on)
import type { DatabaseSync } from 'node:sqlite';

export const LIMITS = {
  loneWarnMin: 30,    // alone in a hazardous room: warning after 30 min
  loneCritMin: 60,    // ... critical after 60 min
  staleWarnH: 4,      // no check-in outside own cabin: warning after 4 h
  staleCritH: 8,
  cabinWarnH: 12,     // in own cabin (sleep, rest): warning after 12 h
  cabinCritH: 16,
};

type Status = 'good' | 'warning' | 'critical' | 'neutral';
const HOUR = 3600_000, MIN = 60_000;

// "06-19" -> active from 06:00 to 18:59 ship time; "22-06" wraps midnight
function active(hours: string, t: number) {
  const [a, b] = hours.split('-').map(Number);
  const h = new Date(t).getHours();
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

interface Room { id: number; code: string; name: string; deck: number; min_staff: number; staff_hours: string; hazardous: number }
interface Crew { id: number; badge: string; first_name: string; last_name: string; rank: string; department: string; shift: string; cabin_id: number | null }
interface Ev { crew_id: number; room_id: number; direction: 'in' | 'out'; at: string }

export function alerts(db: DatabaseSync) {
  const now = Date.now();
  const rooms = db.prepare(`SELECT r.id, r.code, r.name, d.level AS deck, r.min_staff, r.staff_hours, r.hazardous
    FROM rooms r JOIN decks d ON d.id = r.deck_id ORDER BY d.level DESC, r.code`).all() as unknown as Room[];
  const crew = db.prepare('SELECT id, badge, first_name, last_name, rank, department, shift, cabin_id FROM crew').all() as unknown as Crew[];
  const events = db.prepare('SELECT crew_id, room_id, direction, at FROM checkins ORDER BY at, id').all() as unknown as Ev[];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const crewById = new Map(crew.map((c) => [c.id, c]));
  const person = (id: number) => {
    const c = crewById.get(id)!;
    return { id: c.id, badge: c.badge, name: `${c.first_name} ${c.last_name}`, rank: c.rank, department: c.department };
  };

  // ---- replay ----
  const loc = new Map<number, number | null>();             // crew -> room (null = out)
  const last = new Map<number, { t: number; room: number; direction: string }>();
  const inside = new Map<number, Set<number>>(rooms.map((r) => [r.id, new Set()]));
  const history = new Map<number, [number, number][]>();      // staffed room -> [time, headcount] changes
  const aloneSince = new Map<number, number>();                // hazardous room -> time it became 1 person
  for (const r of rooms) if (r.min_staff > 0) history.set(r.id, []);

  const changed = (roomId: number, t: number) => {
    const n = inside.get(roomId)!.size;
    history.get(roomId)?.push([t, n]);
    if (roomById.get(roomId)!.hazardous) n === 1 ? aloneSince.set(roomId, t) : aloneSince.delete(roomId);
  };
  for (const e of events) {
    const t = Date.parse(e.at);
    last.set(e.crew_id, { t, room: e.room_id, direction: e.direction });
    const prev = loc.get(e.crew_id) ?? null;
    const next = e.direction === 'in' ? e.room_id : null;
    if (prev === next) continue;
    if (prev !== null) { inside.get(prev)!.delete(e.crew_id); changed(prev, t); }
    if (next !== null) { inside.get(next)!.add(e.crew_id); changed(next, t); }
    loc.set(e.crew_id, next);
  }

  // ---- staffing: walk the last 24 h minute by minute ----
  const staffing = rooms.filter((r) => r.min_staff > 0).map((r) => {
    const h = history.get(r.id)!;
    let i = 0, n = 0, activeMin = 0, okMin = 0, badStart: number | null = null;
    const from = now - 24 * HOUR;
    for (let t = from; t <= now; t += MIN) {
      while (i < h.length && h[i][0] <= t) n = h[i++][1];
      if (!active(r.staff_hours, t)) { badStart = null; continue; }
      activeMin++;
      if (n >= r.min_staff) { okMin++; badStart = null; } else if (badStart === null) badStart = t;
    }
    const people = inside.get(r.id)!.size;
    const isActive = active(r.staff_hours, now);
    const ok = !isActive || people >= r.min_staff;
    return {
      room_id: r.id, code: r.code, name: r.name, deck: r.deck,
      min_staff: r.min_staff, staff_hours: r.staff_hours, active: isActive,
      people, crew: [...inside.get(r.id)!].map(person),
      status: (ok ? 'good' : people === 0 ? 'critical' : 'warning') as Status,
      understaffed_since: ok ? null : badStart === from ? null : badStart && new Date(badStart).toISOString(),
      understaffed_all_day: !ok && badStart === from,
      coverage_24h: activeMin ? Math.round((okMin / activeMin) * 1000) / 10 : 100,
    };
  });

  // ---- lone workers in hazardous rooms ----
  const lone = [...aloneSince].map(([roomId, t]) => {
    const r = roomById.get(roomId)!;
    const minutes = Math.floor((now - t) / MIN);
    return {
      room_id: r.id, code: r.code, name: r.name, deck: r.deck,
      crew: person([...inside.get(roomId)!][0]),
      since: new Date(t).toISOString(), minutes,
      status: (minutes >= LIMITS.loneCritMin ? 'critical' : minutes >= LIMITS.loneWarnMin ? 'warning' : 'good') as Status,
    };
  }).sort((a, b) => b.minutes - a.minutes);

  // ---- time since last check-in ----
  const rank: Record<Status, number> = { critical: 0, warning: 1, good: 2, neutral: 3 };
  const lastCheckin = crew.map((c) => {
    const l = last.get(c.id);
    if (!l) return { ...person(c.id), room: null, in_cabin: false, ashore: false, since: null, hours: null, status: 'critical' as Status };
    const hours = Math.round(((now - l.t) / HOUR) * 10) / 10;
    const ashore = l.direction === 'out';
    const inCabin = !ashore && l.room === c.cabin_id;
    const [warn, crit] = inCabin ? [LIMITS.cabinWarnH, LIMITS.cabinCritH] : [LIMITS.staleWarnH, LIMITS.staleCritH];
    const status: Status = ashore ? 'neutral' : hours >= crit ? 'critical' : hours >= warn ? 'warning' : 'good';
    const room = roomById.get(l.room)!;
    return { ...person(c.id), room: ashore ? null : room.name, in_cabin: inCabin, ashore, since: new Date(l.t).toISOString(), hours, status };
  }).sort((a, b) => rank[a.status] - rank[b.status] || (b.hours ?? Infinity) - (a.hours ?? Infinity));

  const count = (list: { status: Status }[]) => ({
    critical: list.filter((x) => x.status === 'critical').length,
    warning: list.filter((x) => x.status === 'warning').length,
  });
  return {
    limits: LIMITS,
    staffing, lone, lastCheckin,
    counts: { staffing: count(staffing), lone: count(lone), lastCheckin: count(lastCheckin) },
  };
}
