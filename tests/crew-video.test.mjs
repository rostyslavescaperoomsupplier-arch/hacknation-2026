import { createServer, request } from 'node:http';
import assert from 'node:assert/strict';
// small caps so the limits can be exercised quickly (read once when the module loads)
process.env.CREW_VIDEO_MAX_ROOMS = '3';
process.env.CREW_VIDEO_MAX_PER_IP = '14';
const { attachCrewVideoWebSocket } = await import('../assistant/server/crew-video.ts');

const http = createServer((_req, res) => res.end('ok'));
attachCrewVideoWebSocket(http);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const port = http.address().port;
const clients = [];
/** Raw upgrade request with a chosen Origin header -> HTTP status of the answer (101 = accepted). */
function upgradeStatus(origin) {
  return new Promise((resolve, reject) => {
    const headers = {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
    };
    if (origin) headers.origin = origin;
    const req = request({ host: '127.0.0.1', port, path: '/crew-video-ws', headers });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}
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

  // ---- validation and abuse limits ----
  // Origin: same rule as the chat API (guard.ts originAllowed)
  assert.equal(await upgradeStatus('https://evil.example'), 403);
  assert.equal(await upgradeStatus('http://localhost:5174'), 101);
  assert.equal(await upgradeStatus(undefined), 101);

  // terminal identity is validated, normalised and shared; unknown fields are not echoed
  const bridge = connect(), deck = connect();
  await Promise.all([bridge.ready, deck.ready]);
  bridge.send('join', { name: 'Mostek\u202e\u0007  nawigacyjny', room: 'SHIP-01', terminal: 't-d4-01-a', place: 'd4-01', admin: true });
  const bw = await bridge.wait('welcome');
  const joinedEvt = await carol.wait('peer:joined', x => x.peer.id === bw.id);
  assert.equal(joinedEvt.peer.name, 'Mostek nawigacyjny');
  assert.equal(joinedEvt.peer.terminal, 'T-D4-01-A');
  assert.equal(joinedEvt.peer.place, 'D4-01');
  assert.equal(joinedEvt.peer.busy, false);
  assert.equal('admin' in joinedEvt.peer, false);
  deck.send('join', { name: 'Pokład', room: 'SHIP-01', terminal: 'T-D2-01-A; DROP', place: '<script>' });
  const dw = await deck.wait('welcome');
  const listed = dw.peers.find(x => x.id === bw.id);
  assert.equal(listed.terminal, 'T-D4-01-A');
  const deckSeen = await bridge.wait('peer:joined', x => x.peer.id === dw.id);
  assert.equal(deckSeen.peer.terminal, undefined);
  assert.equal(deckSeen.peer.place, undefined);

  // invalid join, unknown command, missing type, bad target id
  const junk = connect();
  await junk.ready;
  junk.send('join', { name: 'x'.repeat(41), room: 'SHIP-01' });
  await junk.wait('error', e => e.code === 'invalid');
  junk.send('join', { name: '\u0000\u0001', room: 'SHIP-01' });
  await junk.wait('error', e => e.code === 'invalid' && junk.events.filter(x => x.code === 'invalid').length === 2);
  junk.send('nope');
  await junk.wait('error', e => e.code === 'unknown');
  junk.ws.send(JSON.stringify({ to: 'x' }));
  await junk.wait('error', e => e.code === 'unknown' && junk.events.filter(x => x.code === 'unknown').length === 2);
  junk.send('call:invite', { to: bw.id });
  await junk.wait('error', e => e.code === 'not-joined');
  deck.send('call:invite', { to: '../' + bw.id });
  await deck.wait('error', e => e.code === 'offline');

  // media type is forwarded, busy state is broadcast to the rest of the channel
  deck.send('call:invite', { to: bw.id, media: 'audio' });
  const inv = await bridge.wait('call:invite', x => x.from === dw.id);
  assert.equal(inv.media, 'audio');
  assert.equal(inv.name, 'Pokład');
  await carol.wait('peer:status', x => x.id === bw.id && x.busy === true);
  await carol.wait('peer:status', x => x.id === dw.id && x.busy === true);
  deck.send('call:cancel', { to: bw.id });
  await bridge.wait('call:cancel', x => x.from === dw.id);
  await carol.wait('peer:status', x => x.id === bw.id && x.busy === false);
  deck.send('call:invite', { to: bw.id, media: 'hologram' });
  await bridge.wait('call:invite', () => bridge.events.filter(e => e.type === 'call:invite').length === 2);
  assert.equal(bridge.events.filter(e => e.type === 'call:invite')[1].media, 'video');
  bridge.send('call:reject', { to: dw.id });
  await deck.wait('call:reject', x => x.reason === 'declined');

  // invitation rate limit: 6 in a burst (deck already used 3)
  for (let i = 0; i < 6; i++) deck.send('call:invite', { to: '00000000-0000-0000-0000-000000000000' });
  await deck.wait('error', e => e.code === 'rate');

  // message rate limit: a flood is answered with `rate` errors and then the connection is closed (1008)
  const flood = connect();
  await flood.ready;
  flood.send('join', { name: 'Flood', room: 'SHIP-01' });
  await flood.wait('welcome');
  const closed = new Promise(resolve => flood.ws.addEventListener('close', e => resolve(e.code), { once: true }));
  for (let i = 0; i < 150; i++) flood.send('rtc:ice', { to: bw.id, candidate: { candidate: 'x' } });
  assert.equal(await closed, 1008);
  assert.ok(flood.events.some(e => e.code === 'rate'));

  // oversized message closes the connection (1009)
  const big = connect();
  await big.ready;
  const bigClosed = new Promise(resolve => big.ws.addEventListener('close', e => resolve(e.code), { once: true }));
  big.ws.send(JSON.stringify({ type: 'join', name: 'x'.repeat(40_000), room: 'SHIP-01' }));
  assert.equal(await bigClosed, 1009);

  // channel cap: SHIP-01 and SHIP-02 exist, one more fits, the next is refused
  const r3 = connect(), r4 = connect();
  await Promise.all([r3.ready, r4.ready]);
  r3.send('join', { name: 'Room three', room: 'SHIP-03' });
  await r3.wait('welcome');
  r4.send('join', { name: 'Room four', room: 'SHIP-04' });
  await r4.wait('error', e => e.code === 'rooms-full');

  // connections per IP: further upgrades get 503 once the cap is reached
  const extra = [];
  let refused = 0;
  for (let i = 0; i < 16 && !refused; i++) {
    const c = connect();
    extra.push(c);
    await c.ready.catch(() => { refused++; });
  }
  assert.equal(refused, 1);
  console.log('PASS: origin check, terminal identity, name sanitising, unknown/invalid messages, media type, busy status, invite + message rate limits, size limit, channel cap, per-IP cap');
} catch (e) {
  process.exitCode = 1;
  console.error(e);
} finally {
  for (const ws of clients) try { ws.close(); } catch { /* ignore */ }
  await Promise.all(clients.map(ws => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener('close', resolve, { once: true });
    setTimeout(resolve, 1500).unref();
  })));
  http.closeAllConnections?.();
  await new Promise(resolve => { http.close(resolve); setTimeout(resolve, 300); });
}
