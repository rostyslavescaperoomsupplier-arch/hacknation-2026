// Wristband positioning (shared/positions.ts + server/positions.ts): solver accuracy on simulated scans, deck choice,
// zones, scan validation and the tracker's evacuation statuses without an alarm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORS, DECKS, DECK_FLOOR, DECK_LOSS, rssiAt, trilaterate, zoneAt, type Vec3 } from '../shared/positions.ts';

let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function scan(p: Vec3, noise = 4) {
  const di = DECKS.findIndex((d) => Math.abs(DECK_FLOOR[d] - p[1]) < 0.01);
  return ANCHORS.map((a) => ({ id: a.id, rssi: Math.round(rssiAt(Math.hypot(a.at[0] - p[0], a.at[1] - p[1] - 1.2, a.at[2] - p[2])) - Math.abs(DECKS.indexOf(a.deck) - di) * DECK_LOSS + gauss() * noise) }))
    .filter((r) => r.rssi > -92).sort((x, y) => y.rssi - x.rssi).slice(0, 40);
}

test('trilateration: right deck always, median error under 4 m', () => {
  const pts: Vec3[] = [[-7, 12.5, 1.5], [0, -4, -52], [10, 19.5, -40], [3, 16, 46], [0, 22.1, 55], [-10, 1.8, -80], [8, 7, 20]];
  const errs: number[] = [];
  for (const p of pts) for (let k = 0; k < 15; k++) {
    const f = trilaterate(scan(p));
    assert.ok(f);
    assert.equal(f.at[1], p[1], `deck for ${p}`);
    errs.push(Math.hypot(f.at[0] - p[0], f.at[2] - p[2]));
  }
  errs.sort((a, b) => a - b);
  assert.ok(errs[errs.length >> 1] < 4, `median ${errs[errs.length >> 1]}`);
});

test('zones: muster stations, engine room, cabins', () => {
  assert.equal(zoneAt([12, 19.5, -40]), 'muster-a');
  assert.equal(zoneAt([-12, 19.5, 0]), 'muster-b');
  assert.equal(zoneAt([0, -4, -52]), 'engine-room');
  assert.equal(zoneAt([-7, 12.5, 1.5]), 'cabins-mid');
});

test('scan validation and tracker without alarm', async () => {
  const { mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync((await import('node:os')).tmpdir() + '/bands-test-');
  process.env.CREW_API = 'off';
  process.env.AUTH_DIR ??= dir;
  process.env.ALARMS_FILE ??= dir + '/alarms.json';
  const { validScan, applyScan, replyFor, resetBands } = await import('../server/positions.ts');
  resetBands();
  assert.equal(validScan({ band: 'zz', anchors: [] }), null);
  assert.equal(validScan({ band: '04A31F', anchors: [{ id: 'bad id', rssi: -60 }] }), null);
  const s = validScan({ band: '04:A3:1F', anchors: scan([0, -4, -52], 0), bat: 150, sos: 'yes' });
  assert.ok(s);
  assert.equal(s.bat, 100);
  assert.equal(s.sos, false);
  const t = applyScan(s, 1000);
  assert.equal(t.deck, 'engine');
  assert.deepEqual(replyFor(t).alarm, null);
});
