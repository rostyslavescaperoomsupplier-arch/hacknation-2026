// Fire detectors (shared/sensors.ts): catalogue sanity, cabin detectors inside their cabins' zones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSORS, SENSOR, isSensorId, sensorsIn } from '../shared/sensors.ts';
import { zoneAt } from '../shared/positions.ts';

test('detector catalogue: unique ids, every cabin, ids validated', () => {
  assert.equal(new Set(SENSORS.map((s) => s.id)).size, SENSORS.length);
  assert.equal(SENSORS.filter((s) => /^C\d+$/.test(s.id)).length, 36);
  assert.ok(isSensorId('C104') && !isSensorId('C999') && !isSensorId('x'));
  assert.ok(sensorsIn('engine-room').every((s) => s.zone === 'engine-room'));
});

test('cabin detectors sit in the zone they are filed under', () => {
  for (const s of SENSORS.filter((x) => /^C\d+$/.test(x.id))) {
    assert.equal(zoneAt([s.at[0], 12.5, s.at[2]]), s.zone, s.id);
  }
  assert.equal(SENSOR['C104'].name.pl, 'Kabina 104');
});
