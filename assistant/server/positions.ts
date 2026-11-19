// Crew wristband positioning (centrala side). Model, anchors and solver: shared/positions.ts; docs/WRISTBANDS.md.
//
//   POST /api/bands/scan   from a wristband (ESP32) over the ship Wi-Fi. Header x-band-key must equal BAND_KEY.
//                          Without BAND_KEY set, only loopback callers are accepted (dev + simulator on the server).
//                          Body BandScan -> BandReply (the active alarm, so the band vibrates; scan interval).
//   GET  /api/bands        BandsState for the map: everyone's last position + evacuation status during an alarm.
//                          Personal data (where a person is): logged-in crew only (ju_session, server/auth.ts).
//
// Tracker per band: RSSI readings of the last scan -> trilaterate on the deck (deck change needs 2 scans in a row),
// position smoothed (EMA), "still" timer reset when the person moves more than STILL_M. State lives in memory only:
// positions are safety data with a short life, nothing is written to disk.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  BAND_RE, FRESH_S, LOST_S, SCAN_MAX_ANCHORS, STATUS_ORDER, STILL_M, STILL_S, ANCHOR, ANCHOR_ID_RE,
  trilaterate, zoneAt,
  type BandPerson, type BandReply, type BandScan, type BandsState, type BandStatus, type DeckId, type PosZone, type Vec3,
} from '../shared/positions.ts';
import { isAlarmZone, isStair, musterFor, type MusterStation } from '../shared/alarms.ts';
import { activeAlarm } from './alarms.ts';
import { crewEnabled, crewGet } from './crew.ts';
import { getSession } from './auth.ts';
import { clientIp, originAllowed, tokenOk } from './guard.ts';

const BAND_KEY = (process.env.BAND_KEY || '').trim();
const MAX_BANDS = 2000;
const EMA = 0.55;

interface Track {
  uid: string;
  at: Vec3 | null;
  deck: DeckId | null;
  acc: number | null;
  /** deck candidate waiting for a 2nd scan */
  pendingDeck: DeckId | null;
  seen: number;
  fixAt: number;
  /** recent fixes (last ~2 min) for the "not moving" test: noise is 2-4 m, so one jump must not reset it */
  hist: { t: number; at: Vec3 }[];
  stillSince: number;
  bat: number | null;
  sos: boolean;
  /** alarm id the wearer acknowledged on the band */
  ackedAlarm: string | null;
  /** zone at the first fix after the alarm was raised: decides the muster station */
  alarmZone: { alarmId: string; zone: PosZone | null } | null;
}
const tracks = new Map<string, Track>();

export const normBand = (s: string) => s.toUpperCase().replace(/[^0-9A-F]/g, '');

/** test hook */
export function resetBands() { tracks.clear(); roster = null; rosterAt = 0; }

// ---------- crew roster (band UID -> person) ----------
interface RosterEntry { name: string; rank: string; department: string }
let roster: Map<string, RosterEntry> | null = null;
let rosterAt = 0;
async function loadRoster(): Promise<Map<string, RosterEntry> | null> {
  if (roster && Date.now() - rosterAt < 60_000) return roster;
  if (!crewEnabled) return roster;
  try {
    const list = await crewGet<any[]>('/api/crew');
    const m = new Map<string, RosterEntry>();
    for (const c of list) {
      if (!c?.rfid_uid) continue;
      m.set(normBand(String(c.rfid_uid)), { name: `${c.first_name} ${c.last_name}`, rank: String(c.rank ?? ''), department: String(c.department ?? '') });
    }
    roster = m; rosterAt = Date.now();
  } catch { /* crew DB down: keep the old roster */ }
  return roster;
}

// ---------- scans ----------
export function validScan(b: any): BandScan | null {
  if (!b || typeof b !== 'object' || typeof b.band !== 'string' || !BAND_RE.test(b.band)) return null;
  if (!Array.isArray(b.anchors) || b.anchors.length > SCAN_MAX_ANCHORS) return null;
  const anchors: BandScan['anchors'] = [];
  for (const a of b.anchors) {
    if (!a || typeof a.id !== 'string' || !ANCHOR_ID_RE.test(a.id) || typeof a.rssi !== 'number' || !Number.isFinite(a.rssi)) return null;
    if (ANCHOR[a.id]) anchors.push({ id: a.id, rssi: Math.max(-120, Math.min(0, a.rssi)) });
  }
  const bat = typeof b.bat === 'number' && Number.isFinite(b.bat) ? Math.max(0, Math.min(100, Math.round(b.bat))) : undefined;
  return { band: b.band, anchors, bat, sos: b.sos === true, ack: b.ack === true, fw: typeof b.fw === 'string' ? b.fw.slice(0, 24) : undefined };
}

/** zone -> muster station (same rule as the evacuation routes; stairs / boat deck go to the station they lead to) */
function stationFor(zone: PosZone | null, blocked: string | null, at: Vec3 | null): MusterStation | null {
  const bl = isStair(blocked) ? blocked : null;
  if (!zone) return null;
  if (zone === 'muster-a' || zone === 'muster-b') return zone;
  if (zone === 'stair-aft') return bl === 'stair-aft' ? 'muster-b' : 'muster-a';
  if (zone === 'stair-fwd') return bl === 'stair-fwd' ? 'muster-a' : 'muster-b';
  if (zone === 'boat-deck') return at && at[2] < -20 ? 'muster-a' : 'muster-b';
  return isAlarmZone(zone) ? musterFor(zone, bl) : null;
}

/** Since when all fixes stayed within STILL_M of where the person is now (walking 1.2 m/s leaves it in seconds). */
function stillSince(hist: { t: number; at: Vec3 }[], cur: Vec3, now: number): number {
  let since = now;
  for (let i = hist.length - 1; i >= 0; i--) {
    const p = hist[i].at;
    if (Math.abs(p[1] - cur[1]) > 1 || Math.hypot(p[0] - cur[0], p[2] - cur[2]) > STILL_M) break;
    since = hist[i].t;
  }
  return since;
}

/** Apply one scan to the tracker. Exported for tests (now = ms). */
export function applyScan(scan: BandScan, now = Date.now()): Track {
  const uid = normBand(scan.band);
  let t = tracks.get(uid);
  if (!t) {
    if (tracks.size >= MAX_BANDS) { // forget the longest-silent band
      let old: string | null = null, oldT = Infinity;
      for (const [k, v] of tracks) if (v.seen < oldT) { oldT = v.seen; old = k; }
      if (old) tracks.delete(old);
    }
    t = { uid, at: null, deck: null, acc: null, pendingDeck: null, seen: now, fixAt: 0, hist: [], stillSince: now, bat: null, sos: false, ackedAlarm: null, alarmZone: null };
    tracks.set(uid, t);
  }
  t.seen = now;
  if (scan.bat !== undefined) t.bat = scan.bat;
  t.sos = !!scan.sos;
  const alarm = activeAlarm();
  if (scan.ack && alarm) t.ackedAlarm = alarm.id;

  // deck hysteresis: stay on the current deck unless another one wins two scans in a row
  const free = trilaterate(scan.anchors);
  if (free) {
    let fix = free;
    if (t.deck && free.deck !== t.deck) {
      if (t.pendingDeck === free.deck) t.pendingDeck = null; // confirmed: switch
      else { t.pendingDeck = free.deck; fix = trilaterate(scan.anchors, t.deck) ?? free; }
    } else t.pendingDeck = null;
    if (t.at && t.deck === fix.deck && now - t.fixAt < 15_000) {
      t.at = [Math.round((t.at[0] + EMA * (fix.at[0] - t.at[0])) * 10) / 10, fix.at[1], Math.round((t.at[2] + EMA * (fix.at[2] - t.at[2])) * 10) / 10];
    } else t.at = fix.at;
    t.deck = fix.deck;
    t.acc = fix.acc;
    t.fixAt = now;
    t.hist.push({ t: now, at: t.at });
    while (t.hist.length && now - t.hist[0].t > 120_000) t.hist.shift();
    t.stillSince = stillSince(t.hist, t.at, now);
  }
  if (alarm && t.at && (!t.alarmZone || t.alarmZone.alarmId !== alarm.id)) t.alarmZone = { alarmId: alarm.id, zone: zoneAt(t.at) };
  return t;
}

export function replyFor(t: Track): BandReply {
  const a = activeAlarm();
  if (!a) return { ok: true, alarm: null, next: 3 };
  const zone = t.alarmZone?.alarmId === a.id ? t.alarmZone.zone : (t.at ? zoneAt(t.at) : null);
  return { ok: true, alarm: { id: a.id, kind: a.kind, drill: a.drill, muster: stationFor(zone, a.blocked, t.at), acked: t.ackedAlarm === a.id }, next: 1 };
}

// ---------- state for the map ----------
function statusOf(t: Track, now: number, alarmOn: boolean, alarmAt: number): BandStatus {
  if (now - t.seen > LOST_S * 1000) return 'lost';
  if (t.sos) return 'sos';
  if (!alarmOn) return 'ok';
  const z = t.at ? zoneAt(t.at) : null;
  if (z === 'muster-a' || z === 'muster-b') return 'safe';
  if (!t.at || now - t.fixAt > FRESH_S * 1000) return 'lost';
  // "still" only counts time inside this alarm
  if (now - Math.max(t.stillSince, alarmAt) > STILL_S * 1000) return 'still';
  return 'moving';
}

export async function bandsState(now = Date.now()): Promise<BandsState> {
  const r = await loadRoster();
  const a = activeAlarm();
  const alarmAt = a ? Date.parse(a.at) : 0;
  const people: BandPerson[] = [];
  let unknown = 0;
  for (const t of tracks.values()) {
    const who = r?.get(t.uid);
    if (!who) { unknown++; continue; }
    const status = statusOf(t, now, !!a, alarmAt);
    const zone = t.at ? zoneAt(t.at) : null;
    const startZone = a && t.alarmZone?.alarmId === a.id ? t.alarmZone.zone : zone;
    people.push({
      key: createHash('sha256').update('band:' + t.uid).digest('hex').slice(0, 12),
      name: who.name, rank: who.rank, department: who.department,
      at: t.at, deck: t.deck, zone, acc: t.acc,
      seen: new Date(t.seen).toISOString(),
      status,
      muster: a ? stationFor(startZone, a.blocked, t.at) : null,
      stillFor: t.at ? Math.round((now - (a ? Math.max(t.stillSince, alarmAt) : t.stillSince)) / 1000) : null,
      bat: t.bat,
      acked: !!a && t.ackedAlarm === a.id,
    });
  }
  people.sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.name.localeCompare(y.name, 'pl'));
  const counts = { total: people.length, safe: 0, moving: 0, still: 0, sos: 0, lost: 0, ok: 0 } as BandsState['counts'];
  for (const p of people) counts[p.status]++;
  return {
    now: new Date(now).toISOString(),
    alarm: a ? { id: a.id, kind: a.kind, drill: a.drill, at: a.at, zone: a.zone, blocked: a.blocked } : null,
    people, counts, unknownBands: unknown,
  };
}

// ---------- HTTP ----------
function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage, max = 4096): Promise<string | null> {
  return new Promise((resolve) => {
    let n = 0; const parts: Buffer[] = []; let done = false;
    req.on('data', (c: Buffer) => { if (done) return; n += c.length; if (n > max) { done = true; resolve(null); req.resume(); return; } parts.push(c); });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function bandAllowed(req: IncomingMessage): boolean {
  if (BAND_KEY) return req.headers['x-band-key'] === BAND_KEY;
  return isLoopback(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
}

// rate limit per band and per IP (a band scans every 1-3 s)
const buckets = new Map<string, { n: number; t: number }>();
function allow(key: string, perMin: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60_000) { if (buckets.size > 20_000) buckets.clear(); buckets.set(key, b = { n: 0, t: now }); }
  return ++b.n <= perMin;
}

export async function handleBandsHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const p = (req.url || '/').split('?')[0];
  if (p !== '/api/bands' && p !== '/api/bands/scan') return false;
  if (p === '/api/bands/scan') {
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }, { allow: 'POST' }); return true; }
    if (!bandAllowed(req)) { send(res, 403, { error: 'forbidden' }); return true; }
    // the simulator sends all bands from one IP; real bands are one IP each
    if (!allow('ip:' + clientIp(req), BAND_KEY ? 6000 : 60_000)) { send(res, 429, { error: 'rate limited' }); return true; }
    const raw = await readBody(req);
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* below */ }
    const scan = validScan(body);
    if (!scan) { send(res, 400, { error: 'bad scan' }); return true; }
    if (!allow('band:' + normBand(scan.band), 150)) { send(res, 429, { error: 'rate limited' }); return true; }
    send(res, 200, replyFor(applyScan(scan)));
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'GET only' }, { allow: 'GET' }); return true; }
  if (!originAllowed(req) || !tokenOk(req)) { send(res, 403, { error: 'forbidden' }); return true; }
  if (!getSession(req)) { send(res, 401, { error: 'login required' }); return true; }
  if (!allow('get:' + clientIp(req), 120)) { send(res, 429, { error: 'rate limited' }, { 'retry-after': '5' }); return true; }
  send(res, 200, await bandsState());
  return true;
}

/** Compact answer for Mewka's tools: who still has to be found during the alarm (or where one person is). */
export async function bandsForTool(query?: string): Promise<unknown> {
  const s = await bandsState();
  const q = (query || '').toLowerCase().trim();
  const pick = q ? s.people.filter((p) => p.name.toLowerCase().includes(q)) : s.people.filter((p) => p.status !== 'safe' && p.status !== 'ok');
  return {
    alarm: s.alarm ? { kind: s.alarm.kind, drill: s.alarm.drill, since: s.alarm.at } : null,
    counts: s.counts,
    people: pick.slice(0, 25).map((p) => ({
      name: p.name, rank: p.rank, status: p.status, zone: p.zone, deck: p.deck,
      lastSeenSecondsAgo: p.seen ? Math.round((Date.parse(s.now) - Date.parse(p.seen)) / 1000) : null,
      stillForSeconds: p.stillFor, muster: p.muster, acked: p.acked, accuracyM: p.acc,
    })),
  };
}
