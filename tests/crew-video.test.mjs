import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { attachCrewVideoWebSocket } from '../assistant/server/crew-video.ts';

const http = createServer((_req, res) => res.end('ok'));
attachCrewVideoWebSocket(http);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const port = http.address().port;
const clients = [];
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/crew-video-ws`);
  clients.push(ws);
  const events = [];
  const callbacks = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    events.push(m);
    for (const f of [...callbacks]) f();
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  function wait(type, matches = () => true, ms = 1500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { callbacks.splice(callbacks.indexOf(check), 1); reject(Error(`Timeout ${type}, events ${JSON.stringify(events)}`)); }, ms);
      function check() {
        const found = events.find(e => e.type === type && matches(e));
        if (found) { clearTimeout(timer); callbacks.splice(callbacks.indexOf(check), 1); resolve(found); }
      }
      callbacks.push(check);
      check();
    });
  }
  const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));
  return { ws, ready, wait, send, events };
}
try {
  const alice = connect(), bob = connect(), carol = connect(), stranger = connect();
  await Promise.all(clients.map((_, i) => [alice, bob, carol, stranger][i].ready));
  alice.send('join', { name: 'Alice', room: 'SHIP-01' });
  bob.send('join', { name: 'Bob', room: 'SHIP-01' });
  carol.send('join', { name: 'Carol', room: 'SHIP-01' });
  stranger.send('join', { name: 'Stranger', room: 'SHIP-02' });
  const a = await alice.wait('welcome');
  const b = await bob.wait('welcome');
  const c = await carol.wait('welcome');
  const s = await stranger.wait('welcome');
  assert.equal(a.room, 'SHIP-01');
  assert.equal(s.room, 'SHIP-02');
  assert.ok(!s.peers.some(x => x.name === 'Alice'));
  await alice.wait('peer:joined', v => v.peer.id === b.id);
  // Cross-room calls may not be delivered.
  alice.send('call:invite', { to: s.id });
  await alice.wait('error', e => e.message.includes('no longer online'));
  alice.send('call:invite', { to: b.id });
  await bob.wait('call:invite', x => x.from === a.id && x.name === 'Alice');
  carol.send('call:invite', { to: b.id });
  await carol.wait('call:reject', x => x.from === b.id && x.reason === 'busy');
  bob.send('call:accept', { to: a.id });
  await alice.wait('call:accept', x => x.from === b.id);
  alice.send('rtc:offer', { to: b.id, sdp: 'example-sdp-offer' });
  await bob.wait('rtc:offer', x => x.sdp === 'example-sdp-offer');
  bob.send('rtc:answer', { to: a.id, sdp: 'example-sdp-answer' });
  await alice.wait('rtc:answer', x => x.sdp === 'example-sdp-answer');
  alice.send('rtc:ice', { to: b.id, candidate: { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 } });
  await bob.wait('rtc:ice', x => x.candidate.candidate === 'candidate:123');
  // Test a payload larger than the original 4 kB text-frame limit.
  alice.send('rtc:offer', { to: b.id, sdp: 'v='.padEnd(10_000, 'a') });
  await bob.wait('rtc:offer', x => x.sdp.length === 10_000);
  assert.equal(stranger.events.some(x => x.type === 'rtc:offer' || x.type === 'call:invite'), false);
  // Hangup makes both ends available again.
  alice.send('call:hangup', { to: b.id });
  await bob.wait('call:hangup', x => x.from === a.id);
  carol.send('call:invite', { to: b.id });
  await bob.wait('call:invite', x => x.from === c.id);
  bob.send('call:reject', { to: c.id });
  await carol.wait('call:reject', x => x.reason === 'declined');
  // Disconnect while ringing notifies caller immediately.
  alice.send('call:invite', { to: b.id });
  await bob.wait('call:invite', x => x.from === a.id);
  bob.ws.close();
  await alice.wait('call:hangup', x => x.from === b.id);
  await alice.wait('peer:left', x => x.id === b.id);
  console.log('PASS: presence, isolated rooms, invitations, busy, acceptance, SDP, ICE, 10 KB SDP, hangup, decline, disconnect');
} finally {
  for (const ws of clients) try { ws.close(); } catch { /* ignore */ }
  await Promise.all(clients.map(ws => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener('close', resolve, { once: true });
    setTimeout(resolve, 1500).unref();
  })));
  await new Promise(resolve => http.close(resolve));
}
