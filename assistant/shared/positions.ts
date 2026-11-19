// Crew wristband positioning ("opaski z ESP32"): anchors, the radio model, trilateration and evacuation status.
// Shared by the assistant server (server/positions.ts), the band simulator (server/simulate-bands.ts), the client
// (src/ship/**) and tests. Dependency-free, like shared/alarms.ts. Protocol + hardware: docs/WRISTBANDS.md.
//
// How it works:
//  - fixed ESP32 anchors (BLE beacons) hang under the deckhead every ~12 m on every deck; each advertises the BLE name
//    `JU-A-<anchor id>` (e.g. "JU-A-D3-05") at a calibrated power;
//  - the ESP32 in a crew wristband scans BLE for ~1 s, keeps the anchors it heard and POSTs their RSSI over the ship
//    Wi-Fi to the centrala: POST /api/bands/scan;
//  - the centrala turns RSSI into distance (log-distance path loss), picks the deck (steel decks block the signal, so
//    the strongest anchors are on the person's deck), trilaterates x/z on that deck and smooths the track;
//  - during an alarm every person gets a status: at the muster station, on the way, not moving, SOS or no signal.
// Coordinates: the ship model (public/models/ship.glb): metres, Y up, bow +Z, port -X.

export type Vec3 = [number, number, number];

// ---------- decks ----------
export const DECKS = ['engine', 'd1', 'd2', 'd3', 'd4', 'd5', 'bridge'] as const;
export type DeckId = (typeof DECKS)[number];
/** floor height of each deck (same as DECK_Y in src/ship/routes.ts) */
export const DECK_FLOOR: Record<DeckId, number> = { engine: -4, d1: 1.8, d2: 7.0, d3: 12.5, d4: 16.0, d5: 19.5, bridge: 22.1 };
export const DECK_NAME: Record<DeckId, { pl: string; en: string }> = {
  engine: { pl: 'Pod pokładem 1 (maszynownia)', en: 'Below deck 1 (engine)' },
  d1: { pl: 'Pokład 1', en: 'Deck 1' }, d2: { pl: 'Pokład 2', en: 'Deck 2' }, d3: { pl: 'Pokład 3', en: 'Deck 3' },
  d4: { pl: 'Pokład 4', en: 'Deck 4' }, d5: { pl: 'Pokład 5 (szalupowy)', en: 'Deck 5 (boat deck)' },
  bridge: { pl: 'Mostek', en: 'Bridge' },
};
/** walkable x/z extent of each deck (clamp for the solver) */
export const DECK_BOUNDS: Record<DeckId, { x: [number, number]; z: [number, number] }> = {
  engine: { x: [-9, 9], z: [-84, -36] },
  d1: { x: [-14.5, 14.5], z: [-97, 63] },
  d2: { x: [-14.5, 14.5], z: [-94, 63] },
  d3: { x: [-14.3, 14.3], z: [-81, 47] },
  d4: { x: [-12.4, 12.4], z: [-71, 57] },
  d5: { x: [-14, 14], z: [-52, 12] },
  bridge: { x: [-15, 15], z: [35, 62.5] },
};

// ---------- anchors ----------
export interface Anchor {
  /** "D3-05": deck code + number; the BLE name is ANCHOR_PREFIX + id */
  id: string;
  deck: DeckId;
  /** mounting point (under the deckhead) */
  at: Vec3;
  /** measured RSSI at 1 m (calibration, dBm); default TX_1M */
  tx?: number;
}
export const ANCHOR_PREFIX = 'JU-A-';
export const TX_1M = -59;
/** path-loss exponent inside a steel hull with people and furniture (2 = free space) */
export const PATH_N = 2.7;
/** extra loss through one steel deck (dB); used by the simulator, the solver just ignores other decks */
export const DECK_LOSS = 28;

const DECK_CODE: Record<DeckId, string> = { engine: 'E', d1: 'D1', d2: 'D2', d3: 'D3', d4: 'D4', d5: 'D5', bridge: 'BR' };
const CEILING = 2.4;
/** two rows (port / starboard) every `step` metres along the deck */
function grid(deck: DeckId, xs: number[], step: number): Anchor[] {
  const b = DECK_BOUNDS[deck];
  const out: Anchor[] = [];
  const from = b.z[0] + step / 2, to = b.z[1];
  let n = 1;
  for (let z = from; z <= to; z += step) {
    for (const x of xs) {
      out.push({ id: `${DECK_CODE[deck]}-${String(n++).padStart(2, '0')}`, deck, at: [x, DECK_FLOOR[deck] + CEILING, Math.round(z * 10) / 10] });
    }
  }
  return out;
}
/** The installation plan (demo): ~130 anchors. A real ship replaces this list with surveyed positions. */
export const ANCHORS: Anchor[] = [
  ...grid('engine', [-5, 5], 10),
  ...grid('d1', [-8, 8], 14),
  ...grid('d2', [-8, 8], 14),
  ...grid('d3', [-7, 7], 11),
  ...grid('d4', [-7, 7], 11),
  ...grid('d5', [-10, 10], 10),
  ...grid('bridge', [-8, 8], 10),
];
export const ANCHOR: Record<string, Anchor> = Object.fromEntries(ANCHORS.map((a) => [a.id, a]));
export const ANCHOR_ID_RE = /^[A-Z0-9]{1,3}-\d{2}$/;

/** expected RSSI at distance d (m) from an anchor on the same deck */
export const rssiAt = (d: number, tx = TX_1M) => tx - 10 * PATH_N * Math.log10(Math.max(d, 0.3));
/** distance (m) estimated from RSSI */
export const distanceFor = (rssi: number, tx = TX_1M) => Math.pow(10, (tx - rssi) / (10 * PATH_N));

// ---------- wire protocol ----------
/** POST /api/bands/scan (header x-band-key). One reading per anchor heard in the last scan window (~1 s). */
export interface BandScan {
  /** the wristband's RFID tag UID (hex, any separators) = crew.rfid_uid in the crew database */
  band: string;
  anchors: { id: string; rssi: number }[];
  /** battery 0-100 */
  bat?: number;
  /** SOS: button held 3 s */
  sos?: boolean;
  /** the wearer acknowledged the alarm with a short press */
  ack?: boolean;
  /** firmware version, free text */
  fw?: string;
}
/** reply to a scan: what the band should do (vibration pattern = alarm kind, LED colour) */
export interface BandReply {
  ok: true;
  alarm: null | { id: string; kind: string; drill: boolean; muster: 'muster-a' | 'muster-b' | null; acked: boolean };
  /** seconds until the next scan the centrala wants (faster during an alarm) */
  next: number;
}
export const SCAN_MAX_ANCHORS = 40;
export const BAND_RE = /^[0-9A-Fa-f:\- ]{4,40}$/;

// ---------- positions ----------
export interface Fix {
  at: Vec3;
  deck: DeckId;
  /** estimated error radius (m) */
  acc: number;
  /** anchors used */
  n: number;
}

/** Deck of a scan: the one whose 3 strongest anchors carry the most power. null = nothing usable. */
export function pickDeck(readings: { a: Anchor; rssi: number }[]): DeckId | null {
  const by = new Map<DeckId, number[]>();
  for (const r of readings) { const l = by.get(r.a.deck) ?? []; l.push(r.rssi); by.set(r.a.deck, l); }
  let best: DeckId | null = null, bestP = -Infinity;
  for (const [deck, l] of by) {
    const p = l.sort((x, y) => y - x).slice(0, 3).reduce((s, v) => s + Math.pow(10, v / 10), 0);
    if (p > bestP) { bestP = p; best = deck; }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Position from RSSI readings. `deck` forces the deck (hysteresis in the tracker); otherwise pickDeck. */
export function trilaterate(raw: { id: string; rssi: number }[], deck?: DeckId | null): Fix | null {
  const all = raw.map((r) => ({ a: ANCHOR[r.id], rssi: r.rssi })).filter((r) => r.a && Number.isFinite(r.rssi) && r.rssi < 0 && r.rssi > -105);
  const d = deck && all.some((r) => r.a.deck === deck) ? deck : pickDeck(all);
  if (!d) return null;
  const rs = all.filter((r) => r.a.deck === d).sort((x, y) => y.rssi - x.rssi).slice(0, 8)
    .map((r) => ({ x: r.a.at[0], z: r.a.at[2], h: r.a.at[1] - (DECK_FLOOR[d] + 1.2), dist: distanceFor(r.rssi, r.a.tx) }))
    // horizontal distance (the anchor is ~1.2 m above a wrist)
    .map((r) => ({ ...r, dh: Math.sqrt(Math.max(r.dist * r.dist - r.h * r.h, 0.25)) }));
  const b = DECK_BOUNDS[d];
  // start: weighted centroid (near anchors count more)
  let wx = 0, wz = 0, ws = 0;
  for (const r of rs) { const w = 1 / (r.dh * r.dh); wx += w * r.x; wz += w * r.z; ws += w; }
  let x = wx / ws, z = wz / ws;
  let acc = rs[0].dh;
  if (rs.length >= 3) {
    // weighted Gauss-Newton on the circle equations; weights fall with distance (RSSI error grows with it)
    for (let it = 0; it < 20; it++) {
      let a11 = 0, a12 = 0, a22 = 0, g1 = 0, g2 = 0;
      for (const r of rs) {
        const dx = x - r.x, dz = z - r.z;
        const est = Math.max(Math.hypot(dx, dz), 0.1);
        const res = est - r.dh;
        const w = 1 / (r.dh * r.dh + 1);
        const jx = dx / est, jz = dz / est;
        a11 += w * jx * jx; a12 += w * jx * jz; a22 += w * jz * jz; g1 += w * jx * res; g2 += w * jz * res;
      }
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-9) break;
      const sx = (a22 * g1 - a12 * g2) / det, sz = (a11 * g2 - a12 * g1) / det;
      // damped step, never more than 5 m at once
      const k = Math.min(1, 5 / Math.max(Math.hypot(sx, sz), 1e-9));
      x -= sx * k; z -= sz * k;
      if (Math.hypot(sx, sz) < 0.05) break;
    }
    let s = 0;
    for (const r of rs) s += (Math.hypot(x - r.x, z - r.z) - r.dh) ** 2;
    acc = Math.sqrt(s / rs.length) + 1;
  }
  x = clamp(x, b.x[0], b.x[1]);
  z = clamp(z, b.z[0], b.z[1]);
  return { at: [Math.round(x * 10) / 10, DECK_FLOOR[d], Math.round(z * 10) / 10], deck: d, acc: Math.round(Math.min(acc, 25) * 10) / 10, n: rs.length };
}

// ---------- zones and muster stations ----------
export type PosZone =
  | 'bridge' | 'cabins-fwd' | 'cabins-mid' | 'cabins-aft' | 'restaurant' | 'lounge' | 'reclining-lounge'
  | 'vehicle-d1' | 'vehicle-d2' | 'engine-room' | 'engine-control' | 'stair-aft' | 'stair-fwd' | 'muster-a' | 'muster-b' | 'boat-deck';
/** zone boxes (same as ZONES / STAIRS in src/ship/routes.ts) + the muster stations on the boat deck; first match wins */
export const POS_ZONES: { zone: PosZone; min: Vec3; max: Vec3 }[] = [
  { zone: 'muster-a', min: [-14, 19, -48], max: [14, 23, -32] },
  { zone: 'muster-b', min: [-14, 19, -8], max: [14, 23, 8] },
  { zone: 'stair-aft', min: [2, 1.5, -30], max: [8, 21, -18] },
  { zone: 'stair-fwd', min: [2, 1.5, 21], max: [8, 21, 33] },
  { zone: 'bridge', min: [-15, 21.5, 35.5], max: [15, 25.5, 62.5] },
  { zone: 'cabins-fwd', min: [-14.3, 12.5, 33], max: [14.3, 15.7, 47] },
  { zone: 'cabins-mid', min: [-14.3, 12.5, -18], max: [14.3, 15.7, 33] },
  { zone: 'cabins-aft', min: [-14.3, 12.5, -81], max: [14.3, 15.7, -18] },
  { zone: 'restaurant', min: [-12.4, 16, 30], max: [12.4, 19.4, 57] },
  { zone: 'lounge', min: [-12.4, 16, -20], max: [12.4, 19.4, 30] },
  { zone: 'reclining-lounge', min: [-12.4, 16, -71], max: [12.4, 19.4, -20] },
  { zone: 'vehicle-d1', min: [-14.5, 1.8, -97.5], max: [14.5, 6.9, 63] },
  { zone: 'vehicle-d2', min: [-14.5, 7, -94], max: [14.5, 12.4, 63] },
  { zone: 'engine-control', min: [-9.1, -4.5, -84], max: [9.1, 1.7, -72] },
  { zone: 'engine-room', min: [-9.1, -4.5, -72], max: [9.1, 1.7, -36] },
  { zone: 'boat-deck', min: [-14, 19, -52], max: [14, 21.5, 12] },
];
export function zoneAt(p: Vec3): PosZone | null {
  // the fix sits on the floor; test a point 1 m above it
  const q: Vec3 = [p[0], p[1] + 1, p[2]];
  for (const z of POS_ZONES) {
    if (q[0] >= z.min[0] && q[0] <= z.max[0] && q[1] >= z.min[1] && q[1] <= z.max[1] && q[2] >= z.min[2] && q[2] <= z.max[2]) return z.zone;
  }
  return null;
}

// ---------- evacuation status ----------
export type BandStatus =
  /** at a muster station */
  | 'safe'
  /** fresh fix, moving, not at the muster station yet */
  | 'moving'
  /** fresh fix but has not moved for STILL_S during the alarm: trapped, injured, unconscious? */
  | 'still'
  /** SOS pressed */
  | 'sos'
  /** no scan for LOST_S: band dead, out of coverage, overboard? (last known position shown) */
  | 'lost'
  /** no alarm: normal tracking */
  | 'ok';
export const FRESH_S = 12;
export const LOST_S = 30;
export const STILL_S = 60;
/** radius (m) a smoothed track stays in while the person stands still (BLE noise after smoothing: 2-4 m) */
export const STILL_M = 5;
/** rescue priority: lower = look first */
export const STATUS_ORDER: Record<BandStatus, number> = { sos: 0, still: 1, lost: 2, moving: 3, ok: 4, safe: 5 };

/** One person on the map (GET /api/bands). Name/rank only: no RFID, cabin, phone or health data. */
export interface BandPerson {
  /** stable key for the UI (hash of the band, not the UID) */
  key: string;
  name: string;
  rank: string;
  department: string;
  /** last fix (null: never located) */
  at: Vec3 | null;
  deck: DeckId | null;
  zone: PosZone | null;
  acc: number | null;
  /** ISO time of the last scan / last fix */
  seen: string | null;
  status: BandStatus;
  /** muster station this person should go to during the active alarm */
  muster: 'muster-a' | 'muster-b' | null;
  /** seconds without moving more than STILL_M (null: unknown) */
  stillFor: number | null;
  bat: number | null;
  acked: boolean;
}
export interface BandsState {
  now: string;
  alarm: null | { id: string; kind: string; drill: boolean; at: string; zone: string | null; blocked: string | null };
  people: BandPerson[];
  counts: Record<BandStatus, number> & { total: number };
  /** bands that scanned but are not in the crew database (count only) */
  unknownBands: number;
}
