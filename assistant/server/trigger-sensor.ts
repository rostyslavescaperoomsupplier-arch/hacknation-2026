// Fire detector test: makes detector <id> "go off" (POST /api/alarms/sensor), like the fire panel / an ESP32 detector.
//   npm run sensor -- C104            drill (default)
//   npm run sensor -- E-P1 --real     real alarm
//   ASSISTANT_URL=https://jantar.byst.re SENSOR_KEY=... npm run sensor -- C104
// Detector ids: shared/sensors.ts (C100..C147 cabins, E-M1..E-P1 engine room, D4-G1 galley, V1-1.. vehicle decks, ...).
import { SENSOR, SENSORS } from '../shared/sensors.ts';

const id = process.argv[2];
if (!id || !SENSOR[id]) {
  console.log('Usage: npm run sensor -- <detector id> [--real]\nIds:', SENSORS.map((s) => s.id).join(' '));
  process.exit(1);
}
const BASE = (process.env.ASSISTANT_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, '');
const key = process.env.SENSOR_KEY || process.env.TERMINAL_KEY || '';
const r = await fetch(BASE + '/api/alarms/sensor', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-sensor-key': key } : {}) },
  body: JSON.stringify({ sensor: id, drill: !process.argv.includes('--real') }),
});
console.log(r.status, await r.text());
