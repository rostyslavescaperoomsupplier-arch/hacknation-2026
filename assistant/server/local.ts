// Server side of the local (free, no-LLM) Mewka engine. The engine itself lives in src/local/engine.ts and is the
// same code the browser runs; here it only gets a crew source backed by the server's crew tools (crew.ts), so the
// server can answer /api/chat* without an LLM: ASSISTANT_ENGINE=local, or auto without Anthropic credentials (index.ts).
import type { Lang, Turn } from './guard.ts';
import { runCrewTool } from './crew.ts';
import { answerLocal, answerDeltas, type LocalAnswer } from '../src/local/engine.ts';
import { CrewError, type CrewPerson, type CrewSource } from '../src/local/crew.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tool(name: string, input: unknown): Promise<Json> {
  const r = await runCrewTool(name, input);
  if (r.isError) throw new CrewError(/login required/.test(r.content) ? 'auth' : 'down', r.content); // auth.ts: chat user not logged in
  return JSON.parse(r.content);
}

/** CrewSource over runCrewTool (crew database at CREW_API): "login required" -> CrewError('auth') (the answer asks the
 *  user to log in), any other tool error ("crew database unavailable") -> CrewError('down'). */
export const toolCrewSource: CrewSource = {
  async find(query) {
    const d = await tool('find_crew', { query });
    const crew: CrewPerson[] = (d.crew ?? []).map((c: Json) => ({
      name: c.name, rank: c.rank ?? '', room: c.on_board ? c.where ?? null : null, code: c.room_code ?? null,
      zone: c.zone ?? null, minutesAgo: c.minutes_ago ?? null,
    }));
    return { total: Number(d.matches) || crew.length, crew };
  },
  async room(code) {
    const d = await tool('room_people', { room: code });
    if (!d.found) return null;
    return {
      code: d.code, name: d.name, zone: d.zone ?? null,
      people: (d.crew ?? []).map((c: Json) => ({ name: c.name, rank: c.rank ?? '', room: d.name, code: d.code, zone: d.zone ?? null, minutesAgo: c.minutes_ago ?? null })),
      minStaff: Number(d.min_staff) || 0, staffHours: String(d.staff_hours ?? ''), hazardous: !!d.hazardous,
    };
  },
  async summary() {
    const s = await tool('crew_summary', {});
    return { crew: Number(s.crew) || 0, onboard: Number(s.onboard) || 0, ashore: Number(s.ashore) || 0, lastMinutesAgo: s.last_checkin_minutes_ago ?? null, byZone: s.people_by_zone ?? {} };
  },
  async alerts() {
    const a = await tool('safety_alerts', {});
    return {
      lone: (a.lone_workers ?? []).map((x: Json) => ({ person: x.person, room: x.room, zone: x.zone, minutes: Number(x.minutes) || 0, status: x.status })),
      under: (a.understaffed ?? []).map((x: Json) => ({ room: x.room, zone: x.zone, people: Number(x.people) || 0, min: Number(x.min_staff) || 0 })),
      stale: (a.stale_checkins ?? []).map((x: Json) => ({ name: x.name, rank: x.rank, room: x.last_room ?? null, hours: Number(x.hours) || 0 })),
    };
  },
};

export type LocalReply = Omit<LocalAnswer, 'intent' | 'lang'>;
const wire = ({ intent: _i, lang: _l, ...r }: LocalAnswer): LocalReply => r;

/** POST /api/chat in local mode: the /api/chat shape plus engine: "local". */
export async function localAsk(lang: Lang, turns: Turn[]): Promise<LocalReply> {
  return wire(await answerLocal(lang, turns, toolCrewSource));
}

/** POST /api/chat/stream in local mode: one delta per paragraph, then the authoritative reply. */
export async function localAskStream(lang: Lang, turns: Turn[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<LocalReply> {
  const r = await localAsk(lang, turns);
  for (const d of answerDeltas(r)) {
    signal?.throwIfAborted();
    onDelta(d);
    await new Promise((res) => setTimeout(res, 15));
  }
  return r;
}
