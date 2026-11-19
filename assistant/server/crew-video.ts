/**
 * Mewka Crew Video — minimal signaling for 1:1 WebRTC calls.
 * Uses only Node built-ins: the existing assistant server owns the WebSocket endpoint.
 * Deliberately keeps NO media, recordings, passwords, or chat history on the server.
 *
 * Protocol (JSON text frames, unknown fields are ignored, unknown types answered with an error):
 *   -> join { name, room, terminal?, place? }       <- welcome { id, room, peers: PeerInfo[], iceServers, iceTransportPolicy? }
 *   <- peer:joined { peer } | peer:left { id } | peer:status { id, busy }
 *   -> call:invite { to, media?: 'audio'|'video' }  <- call:invite { from, name, terminal?, place?, media }
 *   -> call:accept | call:reject | call:cancel | call:hangup { to }
 *   -> rtc:offer | rtc:answer { to, sdp } | rtc:ice { to, candidate }
 *   <- error { code, message }
 * Abuse limits: Origin check (guard.ts), connections per IP, peers per room, number of rooms (global and created
 * per IP), message size, per-connection token bucket for every frame (junk included) and a stricter one for call
 * invitations. A display name / terminal code is unique in a room ('name-taken' / 'terminal-taken'). Empty rooms are
 * removed at once; rooms with no traffic and no call for 30 min are closed (clients reconnect and re-create them).
 *
 * HACKATHON DEMO ONLY. A room code is not authentication. For use on an actual
 * vessel add crew authentication, TLS, authorization, monitoring, and audit controls.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { clientIp, originAllowed } from './guard.ts';

type Side = 'caller' | 'callee';
type Media = 'audio' | 'video';
type Call = { with: string; side: Side; accepted: boolean };
type Bucket = { tokens: number; last: number };
type Room = { members: Set<Peer>; creatorIp: string; lastActive: number };
type Peer = {
  id: string;
  socket: Socket;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentLength: number;
  joined: boolean;
  alive: boolean;
  name: string;
  room: string;
  /** terminal code from the crew database (e.g. T-D4-01-A) and its room code (D4-01); empty for free-text names */
  terminal: string;
  place: string;
  ip: string;
  call: Call | null;
  joinedTimeout: NodeJS.Timeout;
  msgBucket: Bucket;
  inviteBucket: Bucket;
  strikes: number;
};

type Payload = Record<string, unknown>;
const PATH = '/crew-video-ws';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 32_768;
const envNum = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};
const MAX_CONNECTIONS = envNum('CREW_VIDEO_MAX_CONNECTIONS', 100);
const MAX_PER_IP = envNum('CREW_VIDEO_MAX_PER_IP', 20);
const MAX_ROOMS = envNum('CREW_VIDEO_MAX_ROOMS', 32);
const MAX_ROOM_PEERS = envNum('CREW_VIDEO_MAX_ROOM_PEERS', 40);
/** rooms one IP may have created (and that still exist): one attacker cannot use up MAX_ROOMS */
const MAX_ROOMS_PER_IP = envNum('CREW_VIDEO_MAX_ROOMS_PER_IP', 4);
/** a room with no message and no call for this long is closed */
const ROOM_IDLE_MS = envNum('CREW_VIDEO_ROOM_IDLE_SEC', 30 * 60) * 1000;
/** all messages: burst of 60, 20 per second sustained (ICE candidates come in bursts) */
const MSG_RATE = { cap: envNum('CREW_VIDEO_MSG_BURST', 60), perSec: 20 };
/** call invitations: 6 in a burst, then one per 5 s (stops ring spam) */
const INVITE_RATE = { cap: envNum('CREW_VIDEO_INVITE_BURST', 6), perSec: 0.2 };
/** dropped messages before the connection is closed (1008 policy violation) */
const MAX_STRIKES = 40;
const TYPES = new Set(['join', 'call:invite', 'call:accept', 'call:reject', 'call:cancel', 'call:hangup',
  'rtc:offer', 'rtc:answer', 'rtc:ice']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_RE = /^[A-Z0-9_-]{3,24}$/;
const TERMINAL_RE = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;
const PLACE_RE = /^[A-Z0-9][A-Z0-9_-]{0,11}$/;
// control characters, zero-width and bidi overrides: not allowed in a display name
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const peers = new Map<string, Peer>();
const rooms = new Map<string, Room>();

type IceServer = { urls: string | string[]; username?: string; credential?: string };
/** Public STUN used when CREW_ICE_SERVERS is not set: lets browsers behind ordinary NAT find their public address.
 *  Without any ICE server only "host" candidates exist and a call connects only inside one LAN (no client isolation). */
const DEFAULT_ICE: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const ICE_URL_RE = /^(stun|stuns|turn|turns):[^\s]{1,200}$/;

/**
 * ICE servers sent to every terminal in `welcome` (no rebuild needed to change them). Env:
 *   CREW_ICE_SERVERS   JSON array of RTCIceServer (static STUN/TURN, e.g. a hosted TURN with fixed credentials);
 *                      unset = public STUN (DEFAULT_ICE), "[]" = none (offline ship LAN).
 *   CREW_TURN_URLS     comma-separated turn:/turns: URLs of an own coturn with `use-auth-secret`, together with
 *   CREW_TURN_SECRET   its static-auth-secret: short-lived credentials (TURN REST API) are minted per join.
 *   CREW_TURN_TTL_SEC  lifetime of those credentials (default 12 h).
 *   CREW_ICE_POLICY    "relay" forces TURN only (testing the TURN server).
 * Exported for tests.
 */
export function iceConfig(env: Record<string, string | undefined> = process.env, now = Date.now()):
  { iceServers: IceServer[]; iceTransportPolicy?: 'relay' } {
  let servers: IceServer[] = DEFAULT_ICE;
  const raw = env.CREW_ICE_SERVERS?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) servers = parsed.flatMap((s): IceServer[] => {
        if (!s || typeof s !== 'object') return [];
        const { urls, username, credential } = s as Record<string, unknown>;
        const list = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === 'string' && ICE_URL_RE.test(u));
        if (!list.length) return [];
        return [{ urls: list, ...(typeof username === 'string' ? { username } : {}), ...(typeof credential === 'string' ? { credential } : {}) }];
      });
      else console.warn('[crew-video] CREW_ICE_SERVERS is not a JSON array, using public STUN');
    } catch { console.warn('[crew-video] CREW_ICE_SERVERS is not valid JSON, using public STUN'); }
  }
  const turnUrls = (env.CREW_TURN_URLS ?? '').split(',').map(u => u.trim()).filter(u => /^turns?:/.test(u) && ICE_URL_RE.test(u));
  const secret = env.CREW_TURN_SECRET?.trim();
  if (turnUrls.length && secret) {
    const ttl = Number(env.CREW_TURN_TTL_SEC) > 0 ? Math.floor(Number(env.CREW_TURN_TTL_SEC)) : 12 * 3600;
    const username = `${Math.floor(now / 1000) + ttl}:crew`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    servers = [...servers, { urls: turnUrls, username, credential }];
  }
  return env.CREW_ICE_POLICY?.trim() === 'relay' ? { iceServers: servers, iceTransportPolicy: 'relay' } : { iceServers: servers };
}

/** Write one unfragmented server-to-browser WebSocket frame. */
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
function send(peer: Peer, payload: object) {
  if (peer.socket.writable && !peer.socket.destroyed) {
    peer.socket.write(frame(1, Buffer.from(JSON.stringify(payload))));
  }
}
function close(peer: Peer, code = 1000) {
  if (peer.socket.destroyed) return;
  try { peer.socket.write(frame(8, Buffer.from([code >> 8, code & 255]))); } catch { /* disconnected */ }
  peer.socket.end();
  setTimeout(() => peer.socket.destroy(), 800).unref();
}
function take(b: Bucket, rate: { cap: number; perSec: number }, now = Date.now()): boolean {
  b.tokens = Math.min(rate.cap, b.tokens + ((now - b.last) / 1000) * rate.perSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.normalize('NFC').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim() : '';
}
/** Comparison key for display names: no case, compatibility forms folded ("KAPITAN" = "kapitan" = fullwidth). */
function nameKey(name: string): string {
  return name.normalize('NFKC').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pl');
}
function cleanCode(v: unknown, re: RegExp): string {
  if (typeof v !== 'string') return '';
  const code = v.trim().toUpperCase();
  return re.test(code) ? code : '';
}
function info(p: Peer) {
  return { id: p.id, name: p.name, terminal: p.terminal || undefined, place: p.place || undefined, busy: Boolean(p.call) };
}
function status(...list: Peer[]) {
  for (const p of list) if (p.joined) broadcast(p.room, { type: 'peer:status', id: p.id, busy: Boolean(p.call) }, p.id);
}
function other(peer: Peer): Peer | undefined {
  const target = peer.call && peers.get(peer.call.with);
  return target?.call?.with === peer.id ? target : undefined;
}
function endCall(peer: Peer, messageType: 'call:reject' | 'call:cancel' | 'call:hangup', reason?: string) {
  const target = other(peer);
  if (target) {
    target.call = null;
    send(target, { type: messageType, from: peer.id, reason });
  }
  peer.call = null;
  if (target) status(target);
  if (peers.has(peer.id)) status(peer);
}
function roomPeers(room: string) {
  return [...(rooms.get(room)?.members ?? [])].map(info);
}
function broadcast(room: string, data: object, exclude?: string) {
  for (const peer of rooms.get(room)?.members ?? []) if (peer.id !== exclude) send(peer, data);
}
function leave(peer: Peer) {
  clearTimeout(peer.joinedTimeout);
  peers.delete(peer.id);
  if (peer.call) endCall(peer, 'call:hangup');
  if (!peer.joined) return;
  const room = rooms.get(peer.room);
  room?.members.delete(peer);
  if (room?.members.size === 0) rooms.delete(peer.room); // empty rooms go at once
  broadcast(peer.room, { type: 'peer:left', id: peer.id });
}
/** `code` is stable (the client translates it), `message` is the English fallback. */
function error(peer: Peer, code: string, message: string) { send(peer, { type: 'error', code, message }); }
function targetInRoom(peer: Peer, id: unknown): Peer | undefined {
  if (typeof id !== 'string' || !ID_RE.test(id) || id === peer.id) return;
  const target = peers.get(id);
  return target?.joined && target.room === peer.room ? target : undefined;
}
/** Every incoming text frame (valid, unknown type or invalid JSON) pays one token; false = dropped. */
function admit(peer: Peer): boolean {
  if (take(peer.msgBucket, MSG_RATE)) return true;
  if (++peer.strikes > MAX_STRIKES) close(peer, 1008);
  else error(peer, 'rate', 'Too many messages, slow down.');
  return false;
}
function handle(peer: Peer, data: Payload) {
  if (typeof data.type !== 'string' || !TYPES.has(data.type)) return error(peer, 'unknown', 'Unknown command.');
  if (data.type === 'join') {
    if (peer.joined) return error(peer, 'joined', 'Already joined.');
    const name = cleanName(data.name);
    const room = typeof data.room === 'string' ? data.room.trim().toUpperCase() : '';
    if ([...name].length < 2 || [...name].length > 40 || !ROOM_RE.test(room))
      return error(peer, 'invalid', 'Use a name of 2-40 characters and a room code of 3-24 letters/numbers.');
    const terminal = cleanCode(data.terminal, TERMINAL_RE);
    const place = cleanCode(data.place, PLACE_RE);
    let entry = rooms.get(room);
    if (!entry) {
      if (rooms.size >= MAX_ROOMS) return error(peer, 'rooms-full', 'Too many channels on this server.');
      let own = 0;
      for (const r of rooms.values()) if (r.creatorIp === peer.ip) own++;
      if (own >= MAX_ROOMS_PER_IP) return error(peer, 'rooms-ip', 'Too many channels opened from this address.');
    } else {
      if (entry.members.size >= MAX_ROOM_PEERS) return error(peer, 'full', 'This channel is full.');
      const key = nameKey(name);
      for (const p of entry.members) {
        if (terminal && p.terminal === terminal) return error(peer, 'terminal-taken', 'This terminal is already online in this channel.');
        // two terminals of one room (T-D4-01-A / -B) both carry the room name: distinct codes, same place
        const sameRoomTerminals = terminal && p.terminal && place && p.place === place;
        if (nameKey(p.name) === key && !sameRoomTerminals)
          return error(peer, 'name-taken', 'This name is already used in this channel.');
      }
    }
    peer.name = name;
    peer.room = room;
    peer.terminal = terminal;
    peer.place = place;
    peer.joined = true;
    clearTimeout(peer.joinedTimeout);
    const existing = roomPeers(room);
    if (!entry) rooms.set(room, entry = { members: new Set(), creatorIp: peer.ip, lastActive: Date.now() });
    entry.members.add(peer);
    entry.lastActive = Date.now();
    send(peer, { type: 'welcome', id: peer.id, room, peers: existing, ...iceConfig() });
    broadcast(room, { type: 'peer:joined', peer: info(peer) }, peer.id);
    return;
  }
  if (!peer.joined) return error(peer, 'not-joined', 'Join a channel first.');
  const entry = rooms.get(peer.room);
  if (entry) entry.lastActive = Date.now();

  if (data.type === 'call:invite') {
    if (!take(peer.inviteBucket, INVITE_RATE)) return error(peer, 'rate', 'Too many calls, wait a moment.');
    const target = targetInRoom(peer, data.to);
    if (!target) return error(peer, 'offline', 'Crew member is no longer online.');
    if (peer.call) return error(peer, 'in-call', 'You are already in a call.');
    if (target.call) return send(peer, { type: 'call:reject', from: target.id, reason: 'busy' });
    const media: Media = data.media === 'audio' ? 'audio' : 'video';
    peer.call = { with: target.id, side: 'caller', accepted: false };
    target.call = { with: peer.id, side: 'callee', accepted: false };
    send(target, { type: 'call:invite', from: peer.id, name: peer.name,
      terminal: peer.terminal || undefined, place: peer.place || undefined, media });
    status(peer, target);
    return;
  }

  if (data.type === 'call:accept') {
    const target = other(peer);
    if (!target || peer.call?.side !== 'callee' || target.id !== data.to || peer.call.accepted)
      return error(peer, 'no-call', 'There is no incoming call to accept.');
    peer.call.accepted = true;
    target.call!.accepted = true;
    send(target, { type: 'call:accept', from: peer.id });
    return;
  }

  if (data.type === 'call:reject' || data.type === 'call:cancel' || data.type === 'call:hangup') {
    const target = other(peer);
    if (!target || target.id !== data.to) return;
    if (data.type === 'call:reject' && peer.call?.side !== 'callee') return;
    if (data.type === 'call:cancel' && peer.call?.side !== 'caller') return;
    const reason = data.type === 'call:reject' ? 'declined' : undefined;
    endCall(peer, data.type, reason);
    return;
  }

  if (data.type === 'rtc:offer' || data.type === 'rtc:answer' || data.type === 'rtc:ice') {
    const target = other(peer);
    if (!target || target.id !== data.to || !peer.call?.accepted || !target.call?.accepted) return;
    if (data.type === 'rtc:offer' || data.type === 'rtc:answer') {
      if ((data.type === 'rtc:offer' && peer.call.side !== 'caller') ||
          (data.type === 'rtc:answer' && peer.call.side !== 'callee')) return;
      if (typeof data.sdp !== 'string' || data.sdp.length < 1 || data.sdp.length > 24_000) return;
      send(target, { type: data.type, from: peer.id, sdp: data.sdp });
    } else {
      const c = data.candidate;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return;
      const candidate = c as Payload;
      if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) return;
      send(target, { type: 'rtc:ice', from: peer.id, candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 100) : null,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 100) : undefined,
      } });
    }
    return;
  }
}

function processText(peer: Peer, bytes: Buffer) {
  if (!admit(peer)) return; // before decoding: junk counts against the limit like any other message
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return close(peer, 1007); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return error(peer, 'json', 'Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error(peer, 'json', 'Invalid event.');
  handle(peer, parsed as Payload);
}

/** Browser frames are masked; supports control frames and fragmented text messages. */
function read(peer: Peer, data: Buffer) {
  peer.buffer = Buffer.concat([peer.buffer, data]);
  if (peer.buffer.length > MAX_MESSAGE_BYTES + 64) return close(peer, 1009);
  while (peer.buffer.length >= 2 && !peer.socket.destroyed) {
    const b0 = peer.buffer[0];
    const b1 = peer.buffer[1];
    const opcode = b0 & 0x0f;
    const fin = Boolean(b0 & 0x80);
    const masked = Boolean(b1 & 0x80);
    const control = opcode >= 8;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (peer.buffer.length < 4) return;
      length = peer.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (peer.buffer.length < 10) return;
      const n = peer.buffer.readBigUInt64BE(2);
      if (n > BigInt(MAX_MESSAGE_BYTES)) return close(peer, 1009);
      length = Number(n);
      offset = 10;
    }
    if (!masked || b0 & 0x70 || length > MAX_MESSAGE_BYTES || (control && (!fin || length > 125)))
      return close(peer, 1002);
    if (peer.buffer.length < offset + 4 + length) return;
    const mask = peer.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(peer.buffer.subarray(offset + 4, offset + 4 + length));
    peer.buffer = peer.buffer.subarray(offset + 4 + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 8) { close(peer); return; }
    if (opcode === 9) { peer.socket.write(frame(10, payload)); continue; }
    if (opcode === 10) { peer.alive = true; continue; }
    if (opcode === 1) {
      if (peer.fragments.length) return close(peer, 1002);
      if (fin) processText(peer, payload);
      else { peer.fragments = [payload]; peer.fragmentLength = payload.length; }
    } else if (opcode === 0) {
      if (!peer.fragments.length) return close(peer, 1002);
      peer.fragments.push(payload);
      peer.fragmentLength += payload.length;
      if (peer.fragmentLength > MAX_MESSAGE_BYTES) return close(peer, 1009);
      if (fin) {
        processText(peer, Buffer.concat(peer.fragments));
        peer.fragments = [];
        peer.fragmentLength = 0;
      }
    } else return close(peer, 1003);
  }
}

/** Close rooms with no message for ROOM_IDLE_MS and nobody in a call. Exported for tests. */
export function sweepIdleRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    if (now - room.lastActive < ROOM_IDLE_MS) continue;
    if ([...room.members].some(p => p.call)) continue;
    rooms.delete(code);
    for (const p of room.members) {
      p.joined = false; // leave() must not touch the (possibly re-created) room again
      close(p, 4000);
    }
  }
}

export function attachCrewVideoWebSocket(server: Server) {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let path = '';
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* bad path */ }
    if (path !== PATH) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    // same rule as the chat API: no Origin (non-browser), this host, localhost or ALLOWED_ORIGINS
    const acceptableOrigin = originAllowed(req);
    const ip = clientIp(req);
    let fromIp = 0;
    for (const p of peers.values()) if (p.ip === ip) fromIp++;
    if (peers.size >= MAX_CONNECTIONS || fromIp >= MAX_PER_IP) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 10\r\n\r\n');
      return;
    }
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' ||
        typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
        Buffer.from(key, 'base64').length !== 16 || !acceptableOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const id = randomUUID();
    const peer: Peer = {
      id, socket, buffer: Buffer.alloc(0), fragments: [], fragmentLength: 0,
      joined: false, alive: true, name: '', room: '', terminal: '', place: '', ip, call: null,
      joinedTimeout: setTimeout(() => close(peer, 1008), 10_000),
      msgBucket: { tokens: MSG_RATE.cap, last: Date.now() },
      inviteBucket: { tokens: INVITE_RATE.cap, last: Date.now() },
      strikes: 0,
    };
    peer.joinedTimeout.unref();
    peers.set(id, peer);
    socket.on('data', (chunk: Buffer) => read(peer, chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => leave(peer));
    if (head.length) read(peer, head);
  });
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) { peer.socket.destroy(); continue; }
      peer.alive = false;
      if (peer.socket.writable) peer.socket.write(frame(9, Buffer.alloc(0)));
    }
    sweepIdleRooms();
  }, 30_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
}
