// Training evacuation routes on the stylized Jantar Unity model (public/models/ship.glb).
// Coordinates in metres, Y up, bow = +Z, port = -X, starboard = +X (see ship-anchors.txt).
// Routes follow the model geometry: zone -> corridor / deck centreline -> nearest stairwell -> up to the
// boat deck D5 -> muster station by the lifeboats. TRAINING material, not the ship's Muster List.
import type { Lang } from '../types';

export type ZoneId =
  | 'bridge' | 'cabins-fwd' | 'cabins-mid' | 'cabins-aft' | 'restaurant' | 'lounge' | 'reclining-lounge'
  | 'vehicle-d1' | 'vehicle-d2' | 'engine-room' | 'engine-control';
export type MusterId = 'muster-a' | 'muster-b';
export type Stair = 'stair-aft' | 'stair-fwd';
export type Vec3 = [number, number, number];
export interface Box { min: Vec3; max: Vec3 }
export interface Text2 { pl: string; en: string }

export const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);
export const tr = (lang: Lang, t: Text2) => (lang === 'pl' ? t.pl : t.en);

/** floor heights of the decks */
export const DECK_Y = { engine: -4, d1: 1.8, d2: 7.0, d3: 12.5, d4: 16.0, d5: 19.5, bridge: 22.1 } as const;
const LEVELS = [DECK_Y.engine, DECK_Y.d1, DECK_Y.d2, DECK_Y.d3, DECK_Y.d4, DECK_Y.d5];

export interface Zone {
  id: ZoneId;
  name: Text2;
  deck: Text2;
  /** walking start point (floor level) */
  anchor: Vec3;
  /** highlight box */
  box: Box;
  /** model node groups ("Cabin 112", "Restaurant D4") that make up the zone */
  groups: string[];
}

const cabins = (a: number[]) => a.map((n) => `Cabin ${n}`);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const ZONES: Zone[] = [
  { id: 'bridge', name: { pl: 'Mostek kapitański', en: 'Navigation bridge' }, deck: { pl: 'Pokład 5 (mostek)', en: 'Deck 5 (bridge)' },
    anchor: [0, DECK_Y.bridge, 52], box: { min: [-15, 19.5, 35.5], max: [15, 25.5, 62.5] }, groups: ['Bridge', 'Bridge furniture'] },
  { id: 'cabins-fwd', name: { pl: 'Kabiny dziobowe 122-123, 146-147', en: 'Forward cabins 122-123, 146-147' }, deck: { pl: 'Pokład 3', en: 'Deck 3' },
    anchor: [-7, DECK_Y.d3, 41], box: { min: [-14.3, 12.5, 35.9], max: [14.3, 15.7, 46.5] }, groups: cabins([122, 123, 146, 147]) },
  { id: 'cabins-mid', name: { pl: 'Kabiny śródokręcie 112-118, 136-142', en: 'Midship cabins 112-118, 136-142' }, deck: { pl: 'Pokład 3', en: 'Deck 3' },
    anchor: [-7, DECK_Y.d3, 1.5], box: { min: [-14.3, 12.5, -17.1], max: [14.3, 15.7, 20] }, groups: cabins([...range(112, 118), ...range(136, 142)]) },
  { id: 'cabins-aft', name: { pl: 'Kabiny rufowe 100-108, 124-132', en: 'Aft cabins 100-108, 124-132' }, deck: { pl: 'Pokład 3', en: 'Deck 3' },
    anchor: [-7, DECK_Y.d3, -57], box: { min: [-14.3, 12.5, -80.7], max: [14.3, 15.7, -33] }, groups: cabins([...range(100, 108), ...range(124, 132)]) },
  { id: 'restaurant', name: { pl: 'Restauracja', en: 'Restaurant' }, deck: { pl: 'Pokład 4', en: 'Deck 4' },
    anchor: [0, DECK_Y.d4, 46], box: { min: [-11.7, 16, 35.4], max: [11.7, 19.5, 56.6] }, groups: ['Restaurant D4'] },
  { id: 'lounge', name: { pl: 'Salon (bar)', en: 'Lounge (bar)' }, deck: { pl: 'Pokład 4', en: 'Deck 4' },
    anchor: [0, DECK_Y.d4, 11], box: { min: [-11, 16, 6.6], max: [11, 19.5, 15.4] }, groups: ['Lounge D4'] },
  { id: 'reclining-lounge', name: { pl: 'Salon z fotelami lotniczymi', en: 'Reclining seat lounge' }, deck: { pl: 'Pokład 4', en: 'Deck 4' },
    anchor: [0, DECK_Y.d4, -54], box: { min: [-11.4, 16, -70.4], max: [12.4, 19.5, -37.6] }, groups: ['Reclining lounge D4'] },
  { id: 'vehicle-d1', name: { pl: 'Pokład samochodowy 1', en: 'Vehicle deck 1' }, deck: { pl: 'Pokład 1', en: 'Deck 1' },
    anchor: [0, DECK_Y.d1, -45], box: { min: [-14.5, 1.8, -97.5], max: [14.5, 6.6, 63] }, groups: ['Vehicle D1'] },
  { id: 'vehicle-d2', name: { pl: 'Pokład samochodowy 2', en: 'Vehicle deck 2' }, deck: { pl: 'Pokład 2', en: 'Deck 2' },
    anchor: [0, DECK_Y.d2, -45], box: { min: [-14.5, 7, -94], max: [14.5, 11.9, 63] }, groups: ['Vehicle D2'] },
  { id: 'engine-room', name: { pl: 'Maszynownia (silniki)', en: 'Engine room' }, deck: { pl: 'Pod pokładem 1', en: 'Below deck 1' },
    anchor: [0, DECK_Y.engine, -52], box: { min: [-8.2, -4, -66.1], max: [8.2, 0.2, -37.8] }, groups: ['Engine 1', 'Engine 2', 'Engine 3', 'Engine 4'] },
  { id: 'engine-control', name: { pl: 'Centrum kontroli maszynowni', en: 'Engine control room' }, deck: { pl: 'Pod pokładem 1', en: 'Below deck 1' },
    anchor: [0, DECK_Y.engine, -79], box: { min: [-9.1, -4, -83.5], max: [9.1, -0.9, -74.1] }, groups: ['Engine control room'] },
];
export const ZONE: Record<ZoneId, Zone> = Object.fromEntries(ZONES.map((z) => [z.id, z])) as Record<ZoneId, Zone>;
export const isZoneId = (s: unknown): s is ZoneId => typeof s === 'string' && s in ZONE;

export interface Muster {
  id: MusterId;
  name: Text2;
  /** marker points, port and starboard */
  points: [Vec3, Vec3];
  where: Text2;
}
export const MUSTERS: Muster[] = [
  { id: 'muster-a', name: { pl: 'Punkt zbiórki A', en: 'Muster station A' },
    points: [[-12, DECK_Y.d5, -40], [12, DECK_Y.d5, -40]],
    where: { pl: 'pokład 5 (szalupowy), rufa, przy szalupach lewej i prawej burty', en: 'deck 5 (boat deck), aft, by the port and starboard lifeboats' } },
  { id: 'muster-b', name: { pl: 'Punkt zbiórki B', en: 'Muster station B' },
    points: [[-12, DECK_Y.d5, 0], [12, DECK_Y.d5, 0]],
    where: { pl: 'pokład 5 (szalupowy), część dziobowa, przy szalupach lewej i prawej burty', en: 'deck 5 (boat deck), forward part, by the port and starboard lifeboats' } },
];
export const MUSTER: Record<MusterId, Muster> = { 'muster-a': MUSTERS[0], 'muster-b': MUSTERS[1] };

export interface StairDef { id: Stair; zc: number; box: Box; name: Text2; muster: MusterId; group: string }
export const STAIRS: Record<Stair, StairDef> = {
  'stair-aft': { id: 'stair-aft', zc: -24, box: { min: [3, 2, -29], max: [7, 20.5, -19] }, name: { pl: 'schody rufowe', en: 'aft stairwell' }, muster: 'muster-a', group: 'Stairwell -29' },
  'stair-fwd': { id: 'stair-fwd', zc: 27, box: { min: [3, 2, 22], max: [7, 20.5, 32] }, name: { pl: 'schody dziobowe', en: 'forward stairwell' }, muster: 'muster-b', group: 'Stairwell 22' },
};
const other = (s: Stair): Stair => (s === 'stair-aft' ? 'stair-fwd' : 'stair-aft');

export interface Route {
  zone: ZoneId;
  /** stairwell used (null: bridge, which has its own stairs to the boat deck) */
  stair: Stair | null;
  muster: MusterId;
  /** ordered waypoints at floor level */
  points: Vec3[];
  steps: Text2[];
  /** metres along the path */
  distance: number;
  /** estimated walking time (s): 1.2 m/s on the level, 0.6 m/s on stairs */
  seconds: number;
  /** the blocked stairwell forced a detour */
  detour: boolean;
  blocked: Stair | null;
}

const len = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
export function pathLength(p: Vec3[]): number {
  let d = 0;
  for (let i = 1; i < p.length; i++) d += len(p[i - 1], p[i]);
  return d;
}

/** switchback flights inside a stairwell from floor `from` to floor `to`; starts at (4, from, zStart). */
function climb(zc: number, zStart: number, from: number, to: number): Vec3[] {
  const levels = LEVELS.filter((y) => y >= from - 0.01 && y <= to + 0.01);
  const pts: Vec3[] = [];
  let cur = zStart;
  for (let i = 0; i < levels.length - 1; i++) {
    const ya = levels[i], yb = levels[i + 1], ym = (ya + yb) / 2;
    const far = 2 * zc - cur;
    pts.push([4, ya, cur], [4, ym, far], [6, ym, far], [6, yb, cur]);
  }
  return pts;
}

/** deck name, Polish in the genitive ("z pokładu 3") */
const deckFrom = (y: number): Text2 =>
  y < 0 ? { pl: 'maszynowni', en: 'the engine room' } :
  y < 5 ? { pl: 'pokładu 1', en: 'deck 1' } :
  y < 10 ? { pl: 'pokładu 2', en: 'deck 2' } :
  y < 14 ? { pl: 'pokładu 3', en: 'deck 3' } :
  y < 18 ? { pl: 'pokładu 4', en: 'deck 4' } : { pl: 'pokładu 5', en: 'deck 5' };

const dirWord = (fromZ: number, toZ: number): Text2 => (toZ < fromZ ? { pl: 'na rufę', en: 'aft' } : { pl: 'na dziób', en: 'forward' });
const m = (x: number) => Math.round(x);

const START: Record<ZoneId, Text2> = {
  'bridge': { pl: 'Przekaż wachtę zgodnie z rozkładem alarmowym, opuść mostek tylnym wyjściem', en: 'Hand over the watch as per the muster list, leave the bridge by the aft exit' },
  'cabins-fwd': { pl: 'Wyjdź z kabiny na korytarz kabinowy (oś statku)', en: 'Leave the cabin into the cabin corridor (centreline)' },
  'cabins-mid': { pl: 'Wyjdź z kabiny na korytarz kabinowy (oś statku)', en: 'Leave the cabin into the cabin corridor (centreline)' },
  'cabins-aft': { pl: 'Wyjdź z kabiny na korytarz kabinowy (oś statku)', en: 'Leave the cabin into the cabin corridor (centreline)' },
  'restaurant': { pl: 'Wyjdź z restauracji na główny ciąg komunikacyjny pokładu 4', en: 'Leave the restaurant into the main passage of deck 4' },
  'lounge': { pl: 'Wyjdź z salonu na główny ciąg komunikacyjny pokładu 4', en: 'Leave the lounge into the main passage of deck 4' },
  'reclining-lounge': { pl: 'Wyjdź z salonu foteli na główny ciąg komunikacyjny pokładu 4', en: 'Leave the reclining lounge into the main passage of deck 4' },
  'vehicle-d1': { pl: 'Odejdź od pojazdów do przejścia w osi pokładu samochodowego 1, nie wracaj do auta', en: 'Move away from the vehicles to the centre walkway of vehicle deck 1, do not go back to the car' },
  'vehicle-d2': { pl: 'Odejdź od pojazdów do przejścia w osi pokładu samochodowego 2, nie wracaj do auta', en: 'Move away from the vehicles to the centre walkway of vehicle deck 2, do not go back to the car' },
  'engine-room': { pl: 'Zabezpiecz stanowisko wg polecenia, idź przejściem między silnikami', en: 'Secure your station as ordered, walk along the passage between the engines' },
  'engine-control': { pl: 'Wyjdź z centrum kontroli maszynowni do przejścia w osi maszynowni', en: 'Leave the engine control room into the engine room centre passage' },
};

const FINAL: Text2 = {
  pl: 'Załóż kamizelkę ratunkową, zgłoś się dowódcy grupy do sprawdzenia obecności i czekaj na polecenia',
  en: 'Put on a lifejacket, report to the group leader for the roll call and wait for instructions',
};

/** Ordered evacuation route from `zone` to its muster station. `blocked` stairwell is avoided. */
export function route(zone: ZoneId, blocked: Stair | null = null): Route {
  const z = ZONE[zone];
  const [sx, sy, sz] = z.anchor;
  const steps: Text2[] = [START[zone]];
  const d5 = DECK_Y.d5;

  // ---- bridge: own stairs (x -6..-4, z 31..35.7) down to the boat deck, port side to muster B ----
  if (zone === 'bridge') {
    const points: Vec3[] = [[sx, sy, sz], [-5, sy, 38], [-5, sy, 35.6], [-5, d5, 31], [-12, d5, 24], MUSTER['muster-b'].points[0]];
    steps.push(
      { pl: 'Schodami mostka w dół na pokład 5 (pokład szalupowy), bez użycia klatek schodowych', en: 'Take the bridge stairs down to deck 5 (boat deck), no stairwell needed' },
      { pl: `Idź lewą burtą na rufę do punktu zbiórki B przy szalupach lewej i prawej burty`, en: 'Walk aft along the port side to muster station B by the port and starboard lifeboats' },
      FINAL,
    );
    return finish(zone, null, 'muster-b', points, steps, false, blocked);
  }

  // ---- pick the stairwell ----
  const nearest: Stair = Math.abs(sz - STAIRS['stair-aft'].zc) <= Math.abs(sz - STAIRS['stair-fwd'].zc) ? 'stair-aft' : 'stair-fwd';
  const engine = sy < 0;
  const points: Vec3[] = [[sx, sy, sz]];
  if (sx !== 0) points.push([0, sy, sz]);
  let stair: Stair;
  let detour = false;

  if (engine) {
    // engine spaces: the engineering stair (x 3..7, z -29..-19) is the only way up to deck 1
    const s = STAIRS['stair-aft'];
    const zIn = sz < s.zc ? s.zc - 4 : s.zc + 4;
    points.push([0, sy, zIn], [4, sy, zIn]);
    const toD1 = climb(s.zc, zIn, DECK_Y.engine, DECK_Y.d1);
    points.push(...toD1);
    steps.push({ pl: `Idź ${dirWord(sz, s.zc).pl} do schodów maszynowni (ok. ${m(Math.abs(sz - zIn))} m), w górę na pokład 1`, en: `Go ${dirWord(sz, s.zc).en} to the engine room stair (about ${m(Math.abs(sz - zIn))} m), up to deck 1` });
    const top = toD1[toD1.length - 1];
    if (blocked === 'stair-aft') {
      // detour: along vehicle deck 1 to the forward stairwell
      const f = STAIRS['stair-fwd'];
      const zF = f.zc - 4;
      points.push([0, DECK_Y.d1, top[2]], [0, DECK_Y.d1, zF], [4, DECK_Y.d1, zF], ...climb(f.zc, zF, DECK_Y.d1, d5).slice(1));
      steps.push(
        { pl: 'Schody rufowe powyżej pokładu 1 zablokowane: nie wchodź wyżej', en: 'Aft stairwell above deck 1 is blocked: do not go further up' },
        { pl: `Przejdź pokładem samochodowym 1 na dziób do schodów dziobowych (ok. ${m(Math.abs(zF - top[2]))} m)`, en: `Cross vehicle deck 1 forward to the forward stairwell (about ${m(Math.abs(zF - top[2]))} m)` },
        { pl: 'Schodami dziobowymi w górę na pokład 5 (pokład szalupowy)', en: 'Up the forward stairwell to deck 5 (boat deck)' },
      );
      stair = 'stair-fwd';
      detour = true;
    } else {
      points.push([4, DECK_Y.d1, top[2]], ...climb(s.zc, top[2], DECK_Y.d1, d5).slice(1));
      steps.push({ pl: 'Dalej schodami rufowymi w górę na pokład 5 (pokład szalupowy)', en: 'Continue up the aft stairwell to deck 5 (boat deck)' });
      stair = 'stair-aft';
    }
  } else {
    stair = nearest;
    if (blocked === nearest) { stair = other(nearest); detour = true; }
    const s = STAIRS[stair];
    const zIn = sz < s.zc ? s.zc - 4 : s.zc + 4;
    points.push([0, sy, zIn], [4, sy, zIn], ...climb(s.zc, zIn, sy, d5).slice(1));
    const walk = Math.abs(sz - zIn) + Math.abs(sx);
    const along = sy > 12 && sy < 14 ? { pl: 'korytarzem', en: 'along the corridor' } : { pl: 'osią pokładu', en: 'along the deck centreline' };
    if (detour) steps.push({ pl: `${cap(STAIRS[nearest].name.pl)} zablokowane: nie wchodź tam, użyj schodów ${stair === 'stair-fwd' ? 'dziobowych' : 'rufowych'}`, en: `${cap(STAIRS[nearest].name.en)} is blocked: keep away, use the ${s.name.en}` });
    steps.push({ pl: `Idź ${along.pl} ${dirWord(sz, s.zc).pl} do ${stair === 'stair-fwd' ? 'schodów dziobowych' : 'schodów rufowych'} (ok. ${m(walk)} m)`, en: `Walk ${along.en} ${dirWord(sz, s.zc).en} to the ${s.name.en} (about ${m(walk)} m)` });
    const n = LEVELS.filter((y) => y > sy + 0.01 && y <= d5 + 0.01).length;
    steps.push({ pl: `Klatką schodową w górę z ${deckFrom(sy).pl} na pokład 5, szalupowy (${n} ${n === 1 ? 'pokład' : 'pokłady'} wyżej)`, en: `Up the stairwell from ${deckFrom(sy).en} to deck 5, the boat deck (${n} ${n === 1 ? 'deck' : 'decks'} up)` });
  }

  // ---- boat deck: out of the stairwell, starboard walkway to the muster station ----
  const s = STAIRS[stair];
  const mu = MUSTER[s.muster];
  const top = points[points.length - 1];
  const dest = mu.points[1];
  points.push([12, d5, top[2]], dest);
  steps.push({ pl: `Wyjdź na pokład otwarty, idź prawą burtą do punktu zbiórki ${mu.id === 'muster-a' ? 'A' : 'B'}: ${mu.where.pl}`, en: `Go out on the open deck, walk along the starboard side to ${mu.name.en}, ${mu.where.en}` });
  steps.push(FINAL);
  return finish(zone, stair, s.muster, points, steps, detour, blocked);
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

function finish(zone: ZoneId, stair: Stair | null, muster: MusterId, points: Vec3[], steps: Text2[], detour: boolean, blocked: Stair | null): Route {
  // drop consecutive duplicates
  const pts = points.filter((p, i) => i === 0 || len(points[i - 1], p) > 0.01);
  let flat = 0, stairs = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = len(pts[i - 1], pts[i]);
    if (Math.abs(pts[i][1] - pts[i - 1][1]) > 0.3) stairs += d; else flat += d;
  }
  return { zone, stair, muster, points: pts, steps, distance: flat + stairs, seconds: flat / 1.2 + stairs / 0.6, detour, blocked };
}

/** "2 min 10 s" / "45 s" */
export function fmtTime(s: number): string {
  const t = Math.max(5, Math.round(s / 5) * 5);
  const mm = Math.floor(t / 60), ss = t % 60;
  return mm ? `${mm} min${ss ? ` ${ss} s` : ''}` : `${ss} s`;
}
