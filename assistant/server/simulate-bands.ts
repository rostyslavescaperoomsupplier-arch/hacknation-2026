// Demo stand-in for the crew ESP32 wristbands: every crew member with an RFID tag on board gets a virtual band that
// walks around the ship and POSTs BLE scans (RSSI generated from the same radio model + noise + steel decks) to the
// centrala exactly like the real firmware (firmware/wristband). When the reply carries an alarm, everyone walks the
// evacuation route to their muster station, except three scripted cases for the rescue demo:
//   - STUCK:  the first person in the engine room never moves      -> "bez ruchu" after 60 s
//   - SILENT: one person in the aft cabins goes quiet after 10 s   -> "brak sygnału", last known position
//   - SOS:    one person on the vehicle deck stops half way, SOS    -> "SOS"
//
//   npm run bands                                  (assistant server + crew server must run)
//   ASSISTANT_URL=http://127.0.0.1:3003 CREW_API=http://127.0.0.1:8790 BAND_KEY=... npm run bands
//   SIM_SCENARIO=0  everyone evacuates normally;  SIM_SPEED=2  walk twice as fast (shorter demo)
import { ANCHORS, DECKS, DECK_BOUNDS, DECK_FLOOR, DECK_LOSS, SCAN_MAX_ANCHORS, rssiAt, type BandReply, type DeckId, type Vec3 } from '../shared/positions.ts';
import { CREW_ROOM_PLACES, type CrewZone } from '../shared/crew-map.ts';
import { MUSTER, isZoneId, route, type Stair } from '../src/ship/routes.ts';

const BASE = (process.env.ASSISTANT_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, '');
const CREW = (process.env.CREW_API || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const KEY = process.env.BAND_KEY || '';
const SCENARIO = process.env.SIM_SCENARIO !== '0';
const TICK_MS = 1000;
/** walking speed multiplier for a shorter demo (1 = real pace) */
const SPEED = Number(process.env.SIM_SPEED) || 1;
let alarmActive = false;

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const jit = (m: number) => (rnd() - 0.5) * 2 * m;

/** deck a 3D point is on (highest floor not above it) */
function deckOf(y: number): DeckId {
  let best: DeckId = 'engine';
  for (const d of DECKS) if (DECK_FLOOR[d] <= y + 0.6) best = d;
  return best;
}
function clampTo(deck: DeckId, p: Vec3): Vec3 {
  const b = DECK_BOUNDS[deck];
  return [Math.min(b.x[1], Math.max(b.x[0], p[0])), p[1], Math.min(b.z[1], Math.max(b.z[0], p[2]))];
}

function scanAt(p: Vec3): { id: string; rssi: number }[] {
  const di = DECKS.indexOf(deckOf(p[1]));
  const out: { id: string; rssi: number }[] = [];
  for (const a of ANCHORS) {
    const d = Math.hypot(a.at[0] - p[0], a.at[1] - (p[1] + 1.2), a.at[2] - p[2]);
    if (d > 45) continue;
    const r = Math.round(rssiAt(d, a.tx) - Math.abs(DECKS.indexOf(a.deck) - di) * DECK_LOSS + gauss() * 4);
    if (r > -95) out.push({ id: a.id, rssi: r });
  }
  return out.sort((x, y) => y.rssi - x.rssi).slice(0, SCAN_MAX_ANCHORS);
}

type Role = 'normal' | 'stuck' | 'silent' | 'sos';
interface Band {
  uid: string;
  name: string;
  zone: CrewZone;
  pos: Vec3;
  home: Vec3;
  role: Role;
  path: Vec3[];
  speed: number;
  startIn: number;
  alarmId: string | null;
  nextScan: number;
  bat: number;
  sos: boolean;
}

const crew = (await (await fetch(CREW + '/api/crew')).json()) as { rfid_uid: string | null; first_name: string; last_name: string; room_code: string | null }[];
const bands: Band[] = [];
for (const c of crew) {
  if (!c.rfid_uid || !c.room_code || !CREW_ROOM_PLACES[c.room_code]) continue;
  const pl = CREW_ROOM_PLACES[c.room_code];
  const deck = deckOf(pl.at[1]);
  const home = clampTo(deck, [pl.at[0] + jit(3), DECK_FLOOR[deck], pl.at[2] + jit(3)]);
  bands.push({ uid: c.rfid_uid, name: `${c.first_name} ${c.last_name}`, zone: pl.zone, pos: home, home, role: 'normal', path: [], speed: 1.2, startIn: 0, alarmId: null, nextScan: 0, bat: 40 + Math.floor(rnd() * 60), sos: false });
}
if (SCENARIO) {
  const take = (zones: CrewZone[], role: Role) => { const b = bands.find((x) => x.role === 'normal' && zones.includes(x.zone)); if (b) b.role = role; return b; };
  for (const [zones, role] of [[['engine-room', 'engine-control'], 'stuck'], [['cabins-aft', 'cabins-mid'], 'silent'], [['vehicle-d1', 'vehicle-d2'], 'sos']] as [CrewZone[], Role][]) {
    const b = take(zones, role) ?? take(['engine-room', 'engine-control', 'cabins-aft', 'cabins-mid', 'cabins-fwd', 'vehicle-d1', 'vehicle-d2', 'lounge', 'restaurant'], role);
    if (b) console.log(`[bands] scenariusz: ${role.padEnd(6)} ${b.name} (${b.zone})`);
  }
}
console.log(`[bands] ${bands.length} opasek, ${ANCHORS.length} kotwic → ${BASE}/api/bands/scan`);

function planEvacuation(b: Band, blocked: Stair | null) {
  let pts: Vec3[];
  if (isZoneId(b.zone)) pts = route(b.zone, blocked).points.slice(1);
  else pts = [MUSTER['muster-a'].points[b.pos[0] < 0 ? 0 : 1]]; // boat deck
  const end = pts[pts.length - 1];
  pts[pts.length - 1] = [end[0] + jit(1.5), end[1], end[2] + jit(3)];
  b.path = pts;
  b.speed = 1.0 + rnd() * 0.5;
  b.startIn = 2 + rnd() * 15;
  if (b.role === 'sos') b.path = pts.slice(0, Math.max(1, Math.floor(pts.length / 2)));
}

function step(b: Band, dt: number) {
  if (b.startIn > 0) { b.startIn -= dt; return; }
  let left = b.speed * SPEED * dt;
  while (left > 0 && b.path.length) {
    const t = b.path[0];
    const dx = t[0] - b.pos[0], dy = t[1] - b.pos[1], dz = t[2] - b.pos[2];
    const d = Math.hypot(dx, dy, dz);
    const slow = Math.abs(dy) > 0.3 ? 0.5 : 1; // stairs
    const can = left * slow;
    if (d <= can) { b.pos = t; b.path.shift(); left -= d / slow; }
    else { b.pos = [b.pos[0] + (dx / d) * can, b.pos[1] + (dy / d) * can, b.pos[2] + (dz / d) * can]; left = 0; }
  }
}

let alarmSince = 0;
async function tick() {
  const now = Date.now();
  await Promise.all(bands.map(async (b) => {
    // movement
    if (b.alarmId) {
      if (b.role !== 'stuck') step(b, TICK_MS / 1000);
      if (b.role === 'sos' && b.startIn <= 0 && (!b.path.length || Date.now() - alarmSince > 25_000)) { b.sos = true; b.path = []; }
    } else if (rnd() < 0.15) {
      const deck = deckOf(b.pos[1]);
      b.pos = clampTo(deck, [b.home[0] + jit(2.5), DECK_FLOOR[deck], b.home[2] + jit(2.5)]);
    }
    if (now < b.nextScan) return;
    if (b.role === 'silent' && alarmActive && now - alarmSince > 10_000) return; // band dead / out of coverage
    try {
      const res = await fetch(BASE + '/api/bands/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(KEY ? { 'x-band-key': KEY } : {}) },
        body: JSON.stringify({ band: b.uid, anchors: scanAt(b.pos), bat: b.bat, sos: b.sos, ack: !!b.alarmId && b.role === 'normal', fw: 'sim-1' }),
      });
      if (!res.ok) { if (res.status !== 429) console.error(`[bands] ${b.name}: HTTP ${res.status}`); b.nextScan = now + 3000; return; }
      const r = (await res.json()) as BandReply;
      b.nextScan = now + r.next * 1000 - 100;
      const id = r.alarm?.id ?? null;
      alarmActive = !!id;
      if (id && id !== b.alarmId) {
        if (!alarmSince || now - alarmSince > 60_000) { alarmSince = now; console.log(`[bands] ALARM ${r.alarm!.kind}${r.alarm!.drill ? ' (ćwiczenie)' : ''}: ewakuacja`); }
        const st = await fetch(BASE + '/api/alarms/state').then((x) => x.json()).catch(() => null) as { active?: { blocked?: Stair | null } } | null;
        b.alarmId = id;
        planEvacuation(b, st?.active?.blocked ?? null);
      } else if (!id && b.alarmId) {
        b.alarmId = null; b.sos = false; b.path = []; alarmSince = 0;
        b.home = b.pos; // stay where the alarm ended
      }
    } catch (e) {
      console.error('[bands] błąd:', (e as Error).message);
      b.nextScan = now + 3000;
    }
  }));
}
setInterval(() => { tick().catch((e) => console.error('[bands]', e)); }, TICK_MS);
