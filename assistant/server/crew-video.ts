/**
 * Mewka Crew Video — minimal signaling for 1:1 WebRTC calls.
 * Uses only Node built-ins: the existing assistant server owns the WebSocket endpoint.
 * Deliberately keeps NO media, recordings, passwords, or chat history on the server.
 *
 * HACKATHON DEMO ONLY. A room code is not authentication. For use on an actual
 * vessel add crew authentication, TLS, authorization, monitoring, and audit controls.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

type Side = 'caller' | 'callee';
type Call = { with: string; side: Side; accepted: boolean };
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
  call: Call | null;
  joinedTimeout: NodeJS.Timeout;
};

type Payload = Record<string, unknown>;
const PATH = '/crew-video-ws';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 32_768;
const MAX_CONNECTIONS = 100;
const MAX_ROOM_PEERS = 24;
const peers = new Map<string, Peer>();
const rooms = new Map<string, Set<Peer>>();

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
}
function roomPeers(room: string) {
  return [...(rooms.get(room) ?? [])].map(p => ({ id: p.id, name: p.name }));
}
function broadcast(room: string, data: object, exclude?: string) {
  for (const peer of rooms.get(room) ?? []) if (peer.id !== exclude) send(peer, data);
}
function leave(peer: Peer) {
  clearTimeout(peer.joinedTimeout);
  peers.delete(peer.id);
  if (peer.call) endCall(peer, 'call:hangup');
  if (!peer.joined) return;
  const room = rooms.get(peer.room);
  room?.delete(peer);
  if (room?.size === 0) rooms.delete(peer.room);
  broadcast(peer.room, { type: 'peer:left', id: peer.id });
}
function error(peer: Peer, message: string) { send(peer, { type: 'error', message }); }
function targetInRoom(peer: Peer, id: unknown): Peer | undefined {
  if (typeof id !== 'string' || id === peer.id) return;
  const target = peers.get(id);
  return target?.joined && target.room === peer.room ? target : undefined;
}
function handle(peer: Peer, data: Payload) {
  if (data.type === 'join') {
    if (peer.joined) return error(peer, 'Already joined.');
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const room = typeof data.room === 'string' ? data.room.trim().toUpperCase() : '';
    if (name.length < 2 || name.length > 40 || !/^[A-Z0-9_-]{3,24}$/.test(room))
      return error(peer, 'Use a name of 2-40 characters and a room code of 3-24 letters/numbers.');
    const members = rooms.get(room) ?? new Set<Peer>();
    if (members.size >= MAX_ROOM_PEERS) return error(peer, 'This channel is full.');
    peer.name = name;
    peer.room = room;
    peer.joined = true;
    clearTimeout(peer.joinedTimeout);
    const existing = roomPeers(room);
    members.add(peer);
    rooms.set(room, members);
    send(peer, { type: 'welcome', id: peer.id, room, peers: existing });
    broadcast(room, { type: 'peer:joined', peer: { id: peer.id, name } }, peer.id);
    return;
  }
  if (!peer.joined) return error(peer, 'Join a channel first.');

  if (data.type === 'call:invite') {
    const target = targetInRoom(peer, data.to);
    if (!target) return error(peer, 'Crew member is no longer online.');
    if (peer.call) return error(peer, 'You are already in a call.');
    if (target.call) return send(peer, { type: 'call:reject', from: target.id, reason: 'busy' });
    peer.call = { with: target.id, side: 'caller', accepted: false };
    target.call = { with: peer.id, side: 'callee', accepted: false };
    send(target, { type: 'call:invite', from: peer.id, name: peer.name });
    return;
  }

  if (data.type === 'call:accept') {
    const target = other(peer);
    if (!target || peer.call?.side !== 'callee' || target.id !== data.to || peer.call.accepted)
      return error(peer, 'There is no incoming call to accept.');
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
  error(peer, 'Unknown command.');
}

function processText(peer: Peer, bytes: Buffer) {
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return close(peer, 1007); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return error(peer, 'Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error(peer, 'Invalid event.');
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

export function attachCrewVideoWebSocket(server: Server) {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let path = '';
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* bad path */ }
    if (path !== PATH) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    let acceptableOrigin = !origin;
    if (origin) {
      try {
        const from = new URL(origin);
        const requestedHost = new URL(`http://${host}`);
        acceptableOrigin = from.host === host ||
          (['localhost', '127.0.0.1', '[::1]'].includes(from.hostname) && from.hostname === requestedHost.hostname);
      } catch { acceptableOrigin = false; }
    }
    if (peers.size >= MAX_CONNECTIONS ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
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
      joined: false, alive: true, name: '', room: '', call: null,
      joinedTimeout: setTimeout(() => close(peer, 1008), 10_000),
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
  }, 30_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
}
