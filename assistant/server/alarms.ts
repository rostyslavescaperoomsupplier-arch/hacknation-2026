/**
 * Ship alarm system ("System alarmowy", centrala): the bridge raises an alarm, every terminal on board shows it at once
 * and the crew acknowledge. Node built-ins only (raw WebSocket like crew-video.ts, no `ws` package).
 *
 *   WebSocket /api/alarms/ws (JSON text frames, types in shared/alarms.ts, full protocol in docs/ALARMS.md)
 *     -> hello { terminalId, name, role: 'bridge'|'crew', zone?, place? }   <- welcome { terminalId, role, state }
 *     -> raise { kind, zone, blocked, message, drill, confirm? }  (role 'bridge' only; a real alarm needs confirm: true)
 *     -> ack { alarmId, user?, headcount? }                       (any terminal)
 *     -> end { alarmId }                                          (role 'bridge' only)
 *     -> ping                                                     <- pong { now }
 *     <- state { state, reason } after every change (snapshot: active alarm, muster accountability, terminals online)
 *     <- error { code, message }
 *   GET /api/alarms/state            -> AlarmState
 *   GET /api/alarms/log?limit=1..1000 -> { alarms: Alarm[] } newest first (the active one included)
 *
 * One active alarm at a time: a new one ends the previous one with endReason 'replaced'. The log is kept in
 * server/data/alarms.json (ALARMS_FILE), debounced writes, capped at 1000; an alarm still active survives a restart.
 * Muster accountability: people checked in per zone (crew DB via crew.ts) vs terminals online / acknowledged per zone,
 * grouped by muster station (shared/alarms.ts musterFor, same rule as the evacuation routes).
 * Limits: origin check (guard.ts), connections total / per IP, 4 KB frames, hello within 10 s, per-connection token
 * buckets (all frames, and a stricter one for raise), heartbeats (ping every 25 s, dead sockets dropped).
 *
 * HACKATHON DEMO: the role is chosen on the terminal, so it is NOT authentication. Before real use put the bridge role
 * behind per-terminal credentials / the ship network and keep the ship's real alarm system as the primary signal.
 *
 * The 'upgrade' event is shared with crew-video.ts, whose listener destroys every socket that is not its own path.
 * attachAlarms() therefore takes over 'upgrade': it serves /api/alarms/ws and passes every other upgrade to the
 * listeners that were (or later get) registered, so the call order in index.ts does not matter.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, corsOrigin, originAllowed, tokenOk } from './guard.ts';
import { crewEnabled, crewGet } from './crew.ts';
import { CREW_ROOM_PLACES } from '../shared/crew-map.ts';
import {
  ALARM_ZONES, HEADCOUNT_MAX, MESSAGE_MAX, NAME_MAX, PLACE_RE, TERMINAL_ID_RE, USER_MAX,
  isAlarmKind, isAlarmZone, isStair, isTerminalZone, musterFor,
  type Alarm, type AlarmAck, type AlarmErrorCode, type AlarmState, type Muster, type MusterRow, type MusterStation, type MusterZoneRow,
  type ServerMsg, type TerminalInfo, type TerminalRole, type TerminalZone,
} from '../shared/alarms.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const envNum = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const WS_PATH = '/api/alarms/ws';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 4096;
const MAX_CONNECTIONS = envNum('ALARMS_MAX_CONNECTIONS', 200);
const MAX_PER_IP = envNum('ALARMS_MAX_PER_IP', 40);
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = envNum('ALARMS_HEARTBEAT_MS', 25_000);
const MUSTER_REFRESH_MS = envNum('ALARMS_MUSTER_MS', 10_000);
/** every frame: burst 20, 5 / s sustained */
const MSG_RATE = { cap: envNum('ALARMS_MSG_BURST', 20), perSec: envNum('ALARMS_MSG_PER_SEC', 5) };
/** raise: burst 4, then one per 5 s */
const RAISE_RATE = { cap: envNum('ALARMS_RAISE_BURST', 4), perSec: 0.2 };
const MAX_STRIKES = 30;
const LOG_CAP = 1000;
const SAVE_DEBOUNCE_MS = envNum('ALARMS_SAVE_MS', 500);
/** HTTP: per-IP bucket, 60 / min */
const HTTP_RATE = { cap: envNum('ALARMS_HTTP_PER_MIN', 60), perSec: envNum('ALARMS_HTTP_PER_MIN', 60) / 60 };
const FILE = process.env.ALARMS_FILE || path.join(here, 'data', 'alarms.json');
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Bucket = { tokens: number; last: number };
type Rate = { cap: number; perSec: number };
interface Conn {
  socket: Socket;
  ip: string;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentLength: number;
  alive: boolean;
  term: TerminalInfo | null;
  helloTimer: NodeJS.Timeout;
  msg: Bucket;
  raise: Bucket;
  strikes: number;
}
type Payload = Record<string, unknown>;

const conns = new Set<Conn>();
let active: Alarm | null = null;
/** newest first; the active alarm (if any) is log[0] */
let log: Alarm[] = [];
let muster: Muster | null = null;

// ---------- persistence ----------
function validStored(a: any): a is Alarm {
  return a && typeof a === 'object' && typeof a.id === 'string' && isAlarmKind(a.kind) && typeof a.at === 'string'
    && typeof a.drill === 'boolean' && a.acks && typeof a.acks === 'object' && (a.zone === null || isAlarmZone(a.zone));
}
function load() {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as { log?: unknown };
    log = Array.isArray(data.log) ? data.log.filter(validStored).slice(0, LOG_CAP) : [];
  } catch { log = []; }
  active = log[0] && !log[0].endedAt ? log[0] : null;
  for (const a of log.slice(1)) if (!a.endedAt) a.endedAt = a.at; // only one can be active
}
load();

let saveTimer: NodeJS.Timeout | null = null;
function writeNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, log }, null, 1));
    renameSync(tmp, FILE);
  } catch (e) { console.error('[alarms] save failed:', e instanceof Error ? e.message : e); }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}
/** Write pending changes now (tests, shutdown). */
export function flushAlarms() { if (saveTimer) writeNow(); }
process.once('beforeExit', flushAlarms);

// ---------- helpers ----------
function take(b: Bucket, rate: Rate, now = Date.now()): boolean {
  b.tokens = Math.min(rate.cap, b.tokens + ((now - b.last) / 1000) * rate.perSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const clean = (v: string) => v.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
const len = (s: string) => [...s].length;

function terminals(): TerminalInfo[] {
  const byId = new Map<string, TerminalInfo>();
  for (const c of conns) if (c.term) byId.set(c.term.terminalId, c.term);
  return [...byId.values()].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, 'pl') : a.role === 'bridge' ? -1 : 1));
}
function snapshot(): AlarmState {
  return { active, muster: active ? muster : null, terminals: terminals(), now: new Date().toISOString() };
}

// ---------- muster accountability ----------
const ZONE_ORDER: TerminalZone[] = [...ALARM_ZONES, 'boat-deck'];

/** People checked in per zone from the crew DB, or null when it is down / switched off. */
async function expectedByZone(): Promise<Map<TerminalZone, number> | null> {
  if (!crewEnabled) return null;
  try {
    const rooms = await crewGet<unknown>('/api/rooms');
    if (!Array.isArray(rooms)) return null;
    const out = new Map<TerminalZone, number>();
    for (const r of rooms as { code?: unknown; people?: unknown }[]) {
      const place = typeof r?.code === 'string' ? CREW_ROOM_PLACES[r.code] : undefined;
      const n = Number(r?.people);
      if (!place || !Number.isFinite(n) || n < 0) continue;
      out.set(place.zone, (out.get(place.zone) ?? 0) + Math.floor(n));
    }
    return out;
  } catch { return null; }
}

export function computeMuster(alarm: Alarm, terms: TerminalInfo[], expected: Map<TerminalZone, number> | null): Muster {
  const zoneOfTerminal = new Map<string, TerminalZone | null>();
  for (const t of terms) zoneOfTerminal.set(t.terminalId, t.zone);
  const rows = new Map<TerminalZone, MusterZoneRow>();
  const row = (z: TerminalZone) => {
    let r = rows.get(z);
    if (!r) rows.set(z, r = { zone: z, expected: expected ? expected.get(z) ?? 0 : null, terminals: 0, acked: 0, reported: 0 });
    return r;
  };
  if (expected) for (const [z, n] of expected) if (n > 0) row(z);
  for (const t of terms) if (t.zone) row(t.zone).terminals++;
  let unzonedAcks = 0;
  for (const [id, ack] of Object.entries(alarm.acks)) {
    const z = zoneOfTerminal.get(id) ?? ack.zone ?? null;
    if (!z) { unzonedAcks++; continue; }
    const r = row(z);
    r.acked++;
    r.reported += ack.headcount ?? 0;
  }
  const stations: MusterStation[] = ['muster-a', 'muster-b'];
  const out: MusterRow[] = stations.map((station) => {
    const zones = ZONE_ORDER.filter((z) => rows.has(z) && musterFor(z, alarm.blocked) === station).map((z) => rows.get(z)!);
    return {
      station, zones,
      expected: expected ? zones.reduce((s, z) => s + (z.expected ?? 0), 0) : null,
      terminals: zones.reduce((s, z) => s + z.terminals, 0),
      acked: zones.reduce((s, z) => s + z.acked, 0),
      reported: zones.reduce((s, z) => s + z.reported, 0),
    };
  });
  return { rows: out, crewOnline: !!expected, unzonedAcks, at: new Date().toISOString() };
}

let musterSeq = 0;
/** Recompute the accountability table; broadcasts when it changed (or always with `reason`). */
async function refreshMuster(reason?: 'raised' | 'ack' | 'ended' | 'terminals') {
  const seq = ++musterSeq;
  if (!active) {
    muster = null;
    if (reason) broadcast(reason);
    return;
  }
  // a quick synchronous table first (previous crew numbers), so the change is broadcast without waiting for the DB
  const prevExpected = muster?.crewOnline
    ? new Map(muster.rows.flatMap((r) => r.zones.map((z) => [z.zone, z.expected ?? 0] as [TerminalZone, number])))
    : null;
  muster = computeMuster(active, terminals(), prevExpected);
  if (reason) broadcast(reason);
  const expected = await expectedByZone();
  if (seq !== musterSeq || !active) return;
  const before = JSON.stringify(muster.rows) + muster.crewOnline + muster.unzonedAcks;
  muster = computeMuster(active, terminals(), expected);
  if (JSON.stringify(muster.rows) + muster.crewOnline + muster.unzonedAcks !== before) broadcast('muster');
}

// ---------- WebSocket plumbing (same framing as crew-video.ts) ----------
function frame(opcode: number, data: Buffer): Buffer {
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length <= 65_535) header = Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}
function send(c: Conn, msg: ServerMsg) {
  if (c.socket.writable && !c.socket.destroyed) c.socket.write(frame(1, Buffer.from(JSON.stringify(msg))));
}
function broadcast(reason: 'raised' | 'ack' | 'ended' | 'terminals' | 'muster') {
  const data = frame(1, Buffer.from(JSON.stringify({ type: 'state', state: snapshot(), reason } satisfies ServerMsg)));
  for (const c of conns) if (c.term && c.socket.writable && !c.socket.destroyed) c.socket.write(data);
}
function close(c: Conn, code = 1000) {
  if (c.socket.destroyed) return;
  try { c.socket.write(frame(8, Buffer.from([code >> 8, code & 255]))); } catch { /* gone */ }
  c.socket.end();
  setTimeout(() => c.socket.destroy(), 800).unref();
}
function error(c: Conn, code: AlarmErrorCode, message: string) { send(c, { type: 'error', code, message }); }

function drop(c: Conn) {
  if (!conns.delete(c)) return;
  clearTimeout(c.helloTimer);
  if (c.term && ![...conns].some((o) => o.term?.terminalId === c.term!.terminalId)) void refreshMuster('terminals');
}

// ---------- commands ----------
function hello(c: Conn, d: Payload) {
  if (c.term) return error(c, 'hello-twice', 'Already introduced; reconnect to change the terminal.');
  const terminalId = typeof d.terminalId === 'string' ? d.terminalId.trim() : '';
  const name = typeof d.name === 'string' ? clean(d.name) : '';
  const role: TerminalRole | null = d.role === 'bridge' || d.role === 'crew' ? d.role : null;
  const place = typeof d.place === 'string' && PLACE_RE.test(d.place.trim().toUpperCase()) ? d.place.trim().toUpperCase() : null;
  let zone: TerminalZone | null = d.zone == null ? null : isTerminalZone(d.zone) ? d.zone : null;
  if (!TERMINAL_ID_RE.test(terminalId) || len(name) < 2 || len(name) > NAME_MAX || !role || (d.zone != null && !zone))
    return error(c, 'invalid', 'hello needs terminalId (3-40 of A-Z 0-9 _ -), name (2-40 characters), role bridge|crew, zone or null.');
  if (!zone && place && CREW_ROOM_PLACES[place]) zone = CREW_ROOM_PLACES[place].zone;
  c.term = { terminalId, name, role, zone, place };
  clearTimeout(c.helloTimer);
  send(c, { type: 'welcome', terminalId, role, state: snapshot() });
  void refreshMuster('terminals');
}

function raise(c: Conn, d: Payload) {
  const t = c.term!;
  if (t.role !== 'bridge') return error(c, 'forbidden', 'Only a bridge terminal may raise an alarm.');
  if (!take(c.raise, RAISE_RATE)) return error(c, 'rate', 'Too many alarms raised, wait a moment.');
  const message = typeof d.message === 'string' ? clean(d.message) : d.message == null ? '' : null;
  if (!isAlarmKind(d.kind) || typeof d.drill !== 'boolean' || message === null ||
      !(d.zone == null || isAlarmZone(d.zone)) || !(d.blocked == null || isStair(d.blocked)))
    return error(c, 'invalid', 'raise needs kind, drill (boolean), zone|null, blocked|null, message.');
  if (len(message) > MESSAGE_MAX) return error(c, 'too-long', `Message longer than ${MESSAGE_MAX} characters.`);
  if (!d.drill && d.confirm !== true) return error(c, 'confirm', 'A real alarm needs confirm: true.');
  const now = new Date().toISOString();
  if (active) {
    active.endedAt = now;
    active.endedBy = t.name;
    active.endReason = 'replaced';
  }
  const alarm: Alarm = {
    id: randomUUID(), kind: d.kind, zone: (d.zone as Alarm['zone']) ?? null, blocked: (d.blocked as Alarm['blocked']) ?? null,
    message, drill: d.drill, raisedBy: t.name, raisedById: t.terminalId, at: now, endedAt: null,
    // the bridge terminal that raised it has seen it: acknowledged at once (reaction time 0)
    acks: { [t.terminalId]: { at: now, name: t.name, zone: t.zone } },
  };
  active = alarm;
  log.unshift(alarm);
  if (log.length > LOG_CAP) log.length = LOG_CAP;
  scheduleSave();
  console.log(`[alarms] RAISE ${alarm.drill ? 'drill' : 'REAL'} ${alarm.kind} zone=${alarm.zone ?? '-'} by ${t.name} (${t.terminalId})`);
  void refreshMuster('raised');
}

function ack(c: Conn, d: Payload) {
  const t = c.term!;
  if (typeof d.alarmId !== 'string' || !UUID_RE.test(d.alarmId)) return error(c, 'invalid', 'ack needs alarmId.');
  if (!active || active.id !== d.alarmId) return error(c, 'no-alarm', 'This alarm is not active any more.');
  let user: string | undefined;
  if (d.user != null) {
    if (typeof d.user !== 'string') return error(c, 'invalid', 'user must be text.');
    user = clean(d.user);
    if (len(user) > USER_MAX) return error(c, 'invalid', `user: at most ${USER_MAX} characters.`);
    if (!user) user = undefined;
  }
  let headcount: number | undefined;
  if (d.headcount != null) {
    if (typeof d.headcount !== 'number' || !Number.isInteger(d.headcount) || d.headcount < 0 || d.headcount > HEADCOUNT_MAX)
      return error(c, 'invalid', `headcount: whole number 0-${HEADCOUNT_MAX}.`);
    headcount = d.headcount;
  }
  const prev = active.acks[t.terminalId];
  // first ack keeps its time (reaction time); a later one may only add the user / headcount
  const entry: AlarmAck = { at: prev?.at ?? new Date().toISOString(), name: t.name, zone: t.zone };
  if (user ?? prev?.user) entry.user = user ?? prev?.user;
  if ((headcount ?? prev?.headcount) != null) entry.headcount = headcount ?? prev?.headcount;
  active.acks[t.terminalId] = entry;
  scheduleSave();
  void refreshMuster('ack');
}

function end(c: Conn, d: Payload) {
  const t = c.term!;
  if (t.role !== 'bridge') return error(c, 'forbidden', 'Only a bridge terminal may end an alarm.');
  if (typeof d.alarmId !== 'string' || !active || active.id !== d.alarmId) return error(c, 'no-alarm', 'This alarm is not active any more.');
  active.endedAt = new Date().toISOString();
  active.endedBy = t.name;
  active.endReason = 'ended';
  console.log(`[alarms] END ${active.kind} by ${t.name}`);
  active = null;
  scheduleSave();
  void refreshMuster('ended');
}

function handle(c: Conn, d: Payload) {
  switch (d.type) {
    case 'hello': return hello(c, d);
    case 'ping': return send(c, { type: 'pong', now: new Date().toISOString() });
    case 'raise': case 'ack': case 'end':
      if (!c.term) return error(c, 'not-hello', 'Send hello first.');
      return d.type === 'raise' ? raise(c, d) : d.type === 'ack' ? ack(c, d) : end(c, d);
    default: return error(c, 'unknown', 'Unknown command.');
  }
}

function processText(c: Conn, bytes: Buffer) {
  if (!take(c.msg, MSG_RATE)) {
    if (++c.strikes > MAX_STRIKES) close(c, 1008);
    else error(c, 'rate', 'Too many messages, slow down.');
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return error(c, 'json', 'Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error(c, 'json', 'Invalid event.');
  handle(c, parsed as Payload);
}

function read(c: Conn, data: Buffer) {
  c.buffer = c.buffer.length ? Buffer.concat([c.buffer, data]) : data;
  if (c.buffer.length > MAX_MESSAGE_BYTES + 64) return close(c, 1009);
  while (c.buffer.length >= 2 && !c.socket.destroyed) {
    const b0 = c.buffer[0], b1 = c.buffer[1];
    const opcode = b0 & 0x0f;
    const fin = Boolean(b0 & 0x80);
    const masked = Boolean(b1 & 0x80);
    const control = opcode >= 8;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (c.buffer.length < 4) return;
      length = c.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (c.buffer.length < 10) return;
      const n = c.buffer.readBigUInt64BE(2);
      if (n > BigInt(MAX_MESSAGE_BYTES)) return close(c, 1009);
      length = Number(n);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) return close(c, 1009);
    if (!masked || b0 & 0x70 || (control && (!fin || length > 125))) return close(c, 1002);
    if (c.buffer.length < offset + 4 + length) return;
    const mask = c.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(c.buffer.subarray(offset + 4, offset + 4 + length));
    c.buffer = c.buffer.subarray(offset + 4 + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    c.alive = true;
    if (opcode === 8) { close(c); return; }
    if (opcode === 9) { c.socket.write(frame(10, payload)); continue; }
    if (opcode === 10) continue;
    if (opcode === 1) {
      if (c.fragments.length) return close(c, 1002);
      if (fin) processText(c, payload);
      else { c.fragments = [payload]; c.fragmentLength = payload.length; }
    } else if (opcode === 0) {
      if (!c.fragments.length) return close(c, 1002);
      c.fragments.push(payload);
      c.fragmentLength += payload.length;
      if (c.fragmentLength > MAX_MESSAGE_BYTES) return close(c, 1009);
      if (fin) {
        const all = Buffer.concat(c.fragments);
        c.fragments = []; c.fragmentLength = 0;
        processText(c, all);
      }
    } else return close(c, 1003);
  }
}

function accept(req: IncomingMessage, socket: Socket, head: Buffer) {
  const key = req.headers['sec-websocket-key'];
  const ip = clientIp(req);
  let fromIp = 0;
  for (const c of conns) if (c.ip === ip) fromIp++;
  if (conns.size >= MAX_CONNECTIONS || fromIp >= MAX_PER_IP) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 10\r\n\r\n');
    return;
  }
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16 ||
      !originAllowed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const acceptKey = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  socket.setNoDelay(true);
  const now = Date.now();
  const c: Conn = {
    socket, ip, buffer: Buffer.alloc(0), fragments: [], fragmentLength: 0, alive: true, term: null,
    helloTimer: setTimeout(() => close(c, 1008), HELLO_TIMEOUT_MS),
    msg: { tokens: MSG_RATE.cap, last: now }, raise: { tokens: RAISE_RATE.cap, last: now }, strikes: 0,
  };
  c.helloTimer.unref();
  conns.add(c);
  socket.on('data', (chunk: Buffer) => read(c, chunk));
  socket.on('error', () => socket.destroy());
  socket.on('close', () => drop(c));
  if (head.length) read(c, head);
}

type UpgradeListener = (req: IncomingMessage, socket: Socket, head: Buffer) => void;
const attached = new WeakSet<Server>();

export function attachAlarms(server: Server): void {
  if (attached.has(server)) return;
  attached.add(server);
  const others: UpgradeListener[] = [];
  const router: UpgradeListener = (req, socket, head) => {
    let p = '';
    try { p = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* bad path */ }
    if (p === WS_PATH) return accept(req, socket, head);
    if (!others.length) { socket.destroy(); return; }
    for (const l of others) l.call(server, req, socket, head);
  };
  for (const l of server.listeners('upgrade') as UpgradeListener[]) { server.removeListener('upgrade', l); others.push(l); }
  server.on('upgrade', router);
  // listeners added later (e.g. attachCrewVideoWebSocket after us) go behind the router too
  server.on('newListener', (event: string | symbol, l: UpgradeListener) => {
    if (event !== 'upgrade' || l === router) return;
    queueMicrotask(() => { server.removeListener('upgrade', l); if (!others.includes(l)) others.push(l); });
  });
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.socket.destroy(); continue; }
      c.alive = false;
      if (c.socket.writable) c.socket.write(frame(9, Buffer.alloc(0)));
    }
  }, HEARTBEAT_MS);
  beat.unref();
  const musterTick = setInterval(() => { if (active) void refreshMuster(); }, MUSTER_REFRESH_MS);
  musterTick.unref();
  server.on('close', () => { clearInterval(beat); clearInterval(musterTick); flushAlarms(); });
}

// ---------- HTTP ----------
const httpBuckets = new Map<string, Bucket>();
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

/** GET /api/alarms/state and /api/alarms/log?limit=; false for any other URL. */
export async function handleAlarmHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let u: URL;
  try { u = new URL(req.url || '/', 'http://x'); } catch { return false; }
  const p = u.pathname;
  if (p !== '/api/alarms' && !p.startsWith('/api/alarms/')) return false;
  if (p === WS_PATH) { sendJson(res, 426, { error: 'websocket only' }, { upgrade: 'websocket' }); return true; }
  const cors = corsOrigin(req);
  if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('vary', 'origin'); }
  if (req.method === 'OPTIONS') {
    if (!cors) { sendJson(res, 403, { error: 'forbidden' }); return true; }
    res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'x-assistant-token', 'access-control-max-age': '600' });
    res.end();
    return true;
  }
  if (p !== '/api/alarms/state' && p !== '/api/alarms/log') { sendJson(res, 404, { error: 'not found' }); return true; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return true; }
  if (!originAllowed(req) || !tokenOk(req)) { sendJson(res, 403, { error: 'forbidden' }); return true; }
  const ip = clientIp(req);
  let b = httpBuckets.get(ip);
  if (!b) {
    if (httpBuckets.size > 10_000) httpBuckets.clear();
    httpBuckets.set(ip, b = { tokens: HTTP_RATE.cap, last: Date.now() });
  }
  if (!take(b, HTTP_RATE)) { sendJson(res, 429, { error: 'rate limited' }, { 'retry-after': '5' }); return true; }
  if (p === '/api/alarms/state') { sendJson(res, 200, snapshot()); return true; }
  const raw = u.searchParams.get('limit');
  const n = raw == null ? 100 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > LOG_CAP) { sendJson(res, 400, { error: `limit: 1-${LOG_CAP}` }); return true; }
  sendJson(res, 200, { alarms: log.slice(0, n) });
  return true;
}
