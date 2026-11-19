// ICE configuration sent to terminals in the crew video `welcome` message (server/crew-video.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iceConfig } from '../server/crew-video.ts';

test('default: public STUN, so terminals on different networks get server-reflexive candidates', () => {
  const c = iceConfig({});
  assert.ok(c.iceServers.length > 0);
  assert.ok(c.iceServers.flatMap(s => [s.urls].flat()).every(u => u.startsWith('stun:')));
  assert.equal(c.iceTransportPolicy, undefined);
});

test('CREW_ICE_SERVERS: "[]" disables, JSON list is filtered, invalid JSON falls back to STUN', () => {
  assert.deepEqual(iceConfig({ CREW_ICE_SERVERS: '[]' }).iceServers, []);
  const c = iceConfig({ CREW_ICE_SERVERS: JSON.stringify([
    { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' },
    { urls: ['javascript:alert(1)'] }, 'junk',
  ]) });
  assert.deepEqual(c.iceServers, [{ urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'p' }]);
  assert.ok(iceConfig({ CREW_ICE_SERVERS: '{oops' }).iceServers.length > 0);
});

test('own coturn: time-limited TURN REST credentials and optional relay-only policy', () => {
  const now = 1_700_000_000_000;
  const c = iceConfig({ CREW_ICE_SERVERS: '[]', CREW_TURN_URLS: 'turn:x.example:3478?transport=udp, turns:x.example:5349',
    CREW_TURN_SECRET: 's3cret', CREW_TURN_TTL_SEC: '60', CREW_ICE_POLICY: 'relay' }, now);
  assert.equal(c.iceTransportPolicy, 'relay');
  assert.equal(c.iceServers.length, 1);
  const turn = c.iceServers[0];
  assert.deepEqual(turn.urls, ['turn:x.example:3478?transport=udp', 'turns:x.example:5349']);
  assert.equal(turn.username, `${now / 1000 + 60}:crew`);
  assert.equal(turn.credential, createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
});
