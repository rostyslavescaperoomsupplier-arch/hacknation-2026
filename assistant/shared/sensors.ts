// Fire detectors on the Jantar Unity model: where each one hangs, so a fire alarm can point at the detector that went
// off (map marker, alarm screen, bridge panel). Shared by the server (alarms.ts) and the client; dependency-free.
// Cabin detectors sit in the middle of each cabin box of public/models/ship.glb (ship-anchors.txt); the rest are
// spread along the spaces. Demo layout, like the wristband anchors: a real ship takes it from its fire-control plan.
// Coordinates: metres, Y up, bow +Z, port -X; the point is under the deckhead.
import type { AlarmZone } from './alarms.ts';

export type SensorType = 'smoke' | 'heat' | 'flame';
export type SensorZone = AlarmZone | 'stair-aft' | 'stair-fwd';
export interface Sensor { id: string; type: SensorType; zone: SensorZone; at: [number, number, number]; name: { pl: string; en: string } }

export const SENSOR_TYPE_NAME: Record<SensorType, { pl: string; en: string }> = {
  smoke: { pl: 'czujka dymu', en: 'smoke detector' },
  heat: { pl: 'czujka ciepła', en: 'heat detector' },
  flame: { pl: 'czujka płomienia', en: 'flame detector' },
};

type Row = [string, SensorType, SensorZone, [number, number, number], { pl: string; en: string }];
const ROWS: Row[] = [
  ['C100', 'smoke', 'cabins-aft', [-8.0, 15.2, -78.0], { pl: 'Kabina 100', en: 'Cabin 100' }],
  ['C101', 'smoke', 'cabins-aft', [-8.0, 15.2, -72.8], { pl: 'Kabina 101', en: 'Cabin 101' }],
  ['C102', 'smoke', 'cabins-aft', [-8.0, 15.2, -67.4], { pl: 'Kabina 102', en: 'Cabin 102' }],
  ['C103', 'smoke', 'cabins-aft', [-8.0, 15.2, -62.1], { pl: 'Kabina 103', en: 'Cabin 103' }],
  ['C104', 'smoke', 'cabins-aft', [-8.0, 15.2, -56.9], { pl: 'Kabina 104', en: 'Cabin 104' }],
  ['C105', 'smoke', 'cabins-aft', [-8.0, 15.2, -51.5], { pl: 'Kabina 105', en: 'Cabin 105' }],
  ['C106', 'smoke', 'cabins-aft', [-8.0, 15.2, -46.2], { pl: 'Kabina 106', en: 'Cabin 106' }],
  ['C107', 'smoke', 'cabins-aft', [-8.0, 15.2, -40.9], { pl: 'Kabina 107', en: 'Cabin 107' }],
  ['C108', 'smoke', 'cabins-aft', [-8.0, 15.2, -35.6], { pl: 'Kabina 108', en: 'Cabin 108' }],
  ['C112', 'smoke', 'cabins-mid', [-8.0, 15.2, -14.5], { pl: 'Kabina 112', en: 'Cabin 112' }],
  ['C113', 'smoke', 'cabins-mid', [-8.0, 15.2, -9.1], { pl: 'Kabina 113', en: 'Cabin 113' }],
  ['C114', 'smoke', 'cabins-mid', [-8.0, 15.2, -3.8], { pl: 'Kabina 114', en: 'Cabin 114' }],
  ['C115', 'smoke', 'cabins-mid', [-8.0, 15.2, 1.5], { pl: 'Kabina 115', en: 'Cabin 115' }],
  ['C116', 'smoke', 'cabins-mid', [-8.0, 15.2, 6.8], { pl: 'Kabina 116', en: 'Cabin 116' }],
  ['C117', 'smoke', 'cabins-mid', [-8.0, 15.2, 12.1], { pl: 'Kabina 117', en: 'Cabin 117' }],
  ['C118', 'smoke', 'cabins-mid', [-8.0, 15.2, 17.4], { pl: 'Kabina 118', en: 'Cabin 118' }],
  ['C122', 'smoke', 'cabins-fwd', [-8.0, 15.2, 38.5], { pl: 'Kabina 122', en: 'Cabin 122' }],
  ['C123', 'smoke', 'cabins-fwd', [-8.0, 15.2, 43.9], { pl: 'Kabina 123', en: 'Cabin 123' }],
  ['C124', 'smoke', 'cabins-aft', [8.0, 15.2, -78.0], { pl: 'Kabina 124', en: 'Cabin 124' }],
  ['C125', 'smoke', 'cabins-aft', [8.0, 15.2, -72.8], { pl: 'Kabina 125', en: 'Cabin 125' }],
  ['C126', 'smoke', 'cabins-aft', [8.0, 15.2, -67.4], { pl: 'Kabina 126', en: 'Cabin 126' }],
  ['C127', 'smoke', 'cabins-aft', [8.0, 15.2, -62.1], { pl: 'Kabina 127', en: 'Cabin 127' }],
  ['C128', 'smoke', 'cabins-aft', [8.0, 15.2, -56.9], { pl: 'Kabina 128', en: 'Cabin 128' }],
  ['C129', 'smoke', 'cabins-aft', [8.0, 15.2, -51.5], { pl: 'Kabina 129', en: 'Cabin 129' }],
  ['C130', 'smoke', 'cabins-aft', [8.0, 15.2, -46.2], { pl: 'Kabina 130', en: 'Cabin 130' }],
  ['C131', 'smoke', 'cabins-aft', [8.0, 15.2, -40.9], { pl: 'Kabina 131', en: 'Cabin 131' }],
  ['C132', 'smoke', 'cabins-aft', [8.0, 15.2, -35.6], { pl: 'Kabina 132', en: 'Cabin 132' }],
  ['C136', 'smoke', 'cabins-mid', [8.0, 15.2, -14.5], { pl: 'Kabina 136', en: 'Cabin 136' }],
  ['C137', 'smoke', 'cabins-mid', [8.0, 15.2, -9.1], { pl: 'Kabina 137', en: 'Cabin 137' }],
  ['C138', 'smoke', 'cabins-mid', [8.0, 15.2, -3.8], { pl: 'Kabina 138', en: 'Cabin 138' }],
  ['C139', 'smoke', 'cabins-mid', [8.0, 15.2, 1.5], { pl: 'Kabina 139', en: 'Cabin 139' }],
  ['C140', 'smoke', 'cabins-mid', [8.0, 15.2, 6.8], { pl: 'Kabina 140', en: 'Cabin 140' }],
  ['C141', 'smoke', 'cabins-mid', [8.0, 15.2, 12.1], { pl: 'Kabina 141', en: 'Cabin 141' }],
  ['C142', 'smoke', 'cabins-mid', [8.0, 15.2, 17.4], { pl: 'Kabina 142', en: 'Cabin 142' }],
  ['C146', 'smoke', 'cabins-fwd', [8.0, 15.2, 38.5], { pl: 'Kabina 146', en: 'Cabin 146' }],
  ['C147', 'smoke', 'cabins-fwd', [8.0, 15.2, 43.9], { pl: 'Kabina 147', en: 'Cabin 147' }],
  ['D3-K1', 'smoke', 'cabins-aft', [0, 15.2, -60], { pl: 'Korytarz kabin, rufa', en: 'Cabin corridor, aft' }],
  ['D3-K2', 'smoke', 'cabins-mid', [0, 15.2, 0], { pl: 'Korytarz kabin, śródokręcie', en: 'Cabin corridor, midship' }],
  ['D3-K3', 'smoke', 'cabins-fwd', [0, 15.2, 40], { pl: 'Korytarz kabin, dziób', en: 'Cabin corridor, forward' }],
  ['D4-R1', 'smoke', 'restaurant', [-5, 18.8, 42], { pl: 'Restauracja, lewa burta', en: 'Restaurant, port' }],
  ['D4-R2', 'smoke', 'restaurant', [5, 18.8, 50], { pl: 'Restauracja, prawa burta', en: 'Restaurant, starboard' }],
  ['D4-G1', 'heat', 'restaurant', [12.8, 18.8, 46], { pl: 'Kuchnia (galley)', en: 'Galley' }],
  ['D4-L1', 'smoke', 'lounge', [0, 18.8, 11], { pl: 'Salon (bar)', en: 'Lounge (bar)' }],
  ['D4-F1', 'smoke', 'reclining-lounge', [-5, 18.8, -62], { pl: 'Salon z fotelami, rufa', en: 'Reclining lounge, aft' }],
  ['D4-F2', 'smoke', 'reclining-lounge', [5, 18.8, -46], { pl: 'Salon z fotelami, dziób', en: 'Reclining lounge, forward' }],
  ['BR-1', 'smoke', 'bridge', [0, 24.6, 52], { pl: 'Mostek', en: 'Bridge' }],
  ['BR-2', 'smoke', 'bridge', [-8, 24.6, 42], { pl: 'Mostek, kabina radiowa', en: 'Bridge, radio room' }],
  ['E-M1', 'heat', 'engine-room', [-5.8, -0.4, -61], { pl: 'Maszynownia, silnik 1', en: 'Engine room, engine 1' }],
  ['E-M2', 'heat', 'engine-room', [5.8, -0.4, -61], { pl: 'Maszynownia, silnik 2', en: 'Engine room, engine 2' }],
  ['E-M3', 'heat', 'engine-room', [-5.8, -0.4, -43], { pl: 'Maszynownia, silnik 3', en: 'Engine room, engine 3' }],
  ['E-M4', 'heat', 'engine-room', [5.8, -0.4, -43], { pl: 'Maszynownia, silnik 4', en: 'Engine room, engine 4' }],
  ['E-P1', 'flame', 'engine-room', [0, -0.4, -52], { pl: 'Maszynownia, środek', en: 'Engine room, centre' }],
  ['E-C1', 'smoke', 'engine-control', [0, -1.2, -79], { pl: 'Centrum kontroli maszynowni', en: 'Engine control room' }],
  ...([-80, -50, -20, 10, 40] as const).map((z, i): Row => [`V1-${i + 1}`, 'smoke', 'vehicle-d1', [0, 6.3, z], { pl: `Pokład samochodowy 1, sekcja ${i + 1}`, en: `Vehicle deck 1, section ${i + 1}` }]),
  ...([-80, -50, -20, 10, 40] as const).map((z, i): Row => [`V2-${i + 1}`, 'smoke', 'vehicle-d2', [0, 11.6, z], { pl: `Pokład samochodowy 2, sekcja ${i + 1}`, en: `Vehicle deck 2, section ${i + 1}` }]),
  ['S-A', 'smoke', 'stair-aft', [5, 15.2, -24], { pl: 'Klatka schodowa rufowa', en: 'Aft stairwell' }],
  ['S-F', 'smoke', 'stair-fwd', [5, 15.2, 27], { pl: 'Klatka schodowa dziobowa', en: 'Forward stairwell' }],
];

export const SENSORS: Sensor[] = ROWS.map(([id, type, zone, at, name]) => ({ id, type, zone, at, name }));
export const SENSOR: Record<string, Sensor> = Object.fromEntries(SENSORS.map((s) => [s.id, s]));
export const SENSOR_ID_RE = /^[A-Z0-9]{1,4}(-[A-Z0-9]{1,3})?$/;
export const SENSORS_MAX = 8;
export const isSensorId = (v: unknown): v is string => typeof v === 'string' && SENSOR_ID_RE.test(v) && !!SENSOR[v];
/** detectors in an alarm zone (stairwells are listed with every zone, they connect them) */
export const sensorsIn = (zone: string | null): Sensor[] => (zone ? SENSORS.filter((s) => s.zone === zone) : SENSORS);
/** "czujka dymu · Kabina 104" */
export const sensorLabel = (s: Sensor, lang: 'pl' | 'en' | string) =>
  lang === 'pl' ? `${SENSOR_TYPE_NAME[s.type].pl} · ${s.name.pl}` : `${SENSOR_TYPE_NAME[s.type].en} · ${s.name.en}`;
