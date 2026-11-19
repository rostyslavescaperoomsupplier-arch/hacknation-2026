// "Mewka, zadzwoń na mostek" -> a call from the Łączność tab to the terminal in that room.
// The chat recognises the request itself (no model round trip, works with the local engine and offline), then hands
// it to CrewVideoChat through requestCall(): it waits until the comms socket is ready, finds an online terminal in that
// room (Person.place = crew room code) and starts the call; when none is online it says so on the comms screen.
export type CallMedia = 'video' | 'audio';
export interface CallTarget { room: string; label: { pl: string; en: string } }
export interface CallRequest extends CallTarget { media: CallMedia; at: number }

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

/** room code (shared/crew-map.ts) -> name + word stems people use for it (folded, no diacritics) */
const ROOMS: [string, string, string, string[]][] = [
  ['D4-01', 'Mostek nawigacyjny', 'Navigation bridge', ['mostek', 'mostk', 'bridge', 'sternowk', 'nawigac']],
  ['D3-06', 'Biuro kapitana', "Captain's office", ['kapitan', 'captain', 'master']],
  ['D4-02', 'Kabina radiowa (GMDSS)', 'Radio room (GMDSS)', ['radio', 'radiow', 'gmdss', 'radiooficer']],
  ['D4-03', 'Sala odpraw', 'Briefing room', ['odpraw', 'briefing']],
  ['D1-01', 'Maszynownia główna', 'Engine room', ['maszynown', 'engine room', 'silnik', 'mechanik']],
  ['D1-02', 'Centrala manewrowa (ECR)', 'Engine control room', ['ecr', 'cmk', 'centrala manewr', 'centrali manewr', 'engine control', 'kontroli maszyn']],
  ['D1-03', 'Warsztat mechaniczny', 'Workshop', ['warsztat', 'workshop']],
  ['D1-04', 'Pompownia', 'Pump room', ['pompown', 'pump']],
  ['D2-03', 'Kuchnia', 'Galley', ['kuchni', 'kucharz', 'galley', 'kitchen']],
  ['D2-04', 'Mesa załogi', 'Crew mess', ['mesa', 'mesy', 'mesie', 'mese', 'mess']],
  ['D2-07', 'Szpital okrętowy', 'Ship hospital', ['szpital', 'lekarz', 'medyk', 'ambulator', 'hospital', 'doctor', 'medic']],
  ['D2-06', 'Pralnia', 'Laundry', ['pralni', 'laundry']],
  ['D3-04', 'Świetlica', 'Day room', ['swietlic', 'day room', 'lounge']],
  ['D3-05', 'Siłownia', 'Gym', ['silown', 'gym']],
  ['D4-04', 'Stacja ratunkowa', 'Muster station', ['stacj ratunk', 'stacja ratunk', 'stacji ratunk', 'zbiork', 'muster', 'szalup']],
  ['D2-01', 'Pokład ładunkowy', 'Cargo deck', ['ladunkow', 'cargo']],
  ['D2-02', 'Biuro ładunkowe', 'Cargo office', ['biuro ladunk', 'biura ladunk', 'cargo office']],
  ['D2-08', 'Magazyn bosmański', "Bosun's store", ['bosman', 'bosun']],
];

const CALL_RE = /\b(zadzwon\w*|zadzwoni\w*|dzwon\w*|polacz\w*|zawolaj\w*|wywolaj\w*|call|ring|connect)\b/;
const AUDIO_RE = /\b(glosow\w*|audio|voice|bez (wideo|kamery|obrazu))\b/;

/** null = not a call request. room '' = a call request without a recognisable place (open Łączność). */
export function parseCallIntent(text: string): (CallTarget & { media: CallMedia }) | null {
  const t = fold(text);
  if (!CALL_RE.test(t)) return null;
  // "dzwonek", "dzwonki alarmowe": the alarm bell, not a call
  if (/\bdzwonk\w*/.test(t) && !/\b(zadzwon|polacz)/.test(t)) return null;
  const media: CallMedia = AUDIO_RE.test(t) ? 'audio' : 'video';
  for (const [room, pl, en, stems] of ROOMS) if (stems.some((s) => t.includes(s))) return { room, label: { pl, en }, media };
  return { room: '', label: { pl: 'Łączność', en: 'Comms' }, media };
}

// ---- hand-off to the comms tab (it may mount only after the tab opens) ----
let pending: CallRequest | null = null;
export const CALL_EVENT = 'jantar:call';
export function requestCall(r: CallTarget & { media: CallMedia }) {
  pending = { ...r, at: Date.now() };
  dispatchEvent(new CustomEvent(CALL_EVENT));
}
/** take the pending request (once); older than 20 s = stale */
export function takeCall(): CallRequest | null {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at < 20_000 ? p : null;
}
export function peekCall(): CallRequest | null { return pending && Date.now() - pending.at < 20_000 ? pending : null; }
