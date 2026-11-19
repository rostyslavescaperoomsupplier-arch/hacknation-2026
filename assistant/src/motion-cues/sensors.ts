// System anty-rzyg: źródło ruchu statku dla wskazówek przeciw chorobie morskiej.
//
// Kolejność źródeł (najlepsze wygrywa):
//   1. 'sensor' - żyroskop + akcelerometr urządzenia (telefon, tablet), fuzja filtrem komplementarnym
//      (filters.ts: fuseUp), potem pasmo statku 0.02-0.7 Hz. Gdy przeglądarka daje tylko
//      deviceorientation, wektor "w górę" liczymy z kątów beta/gamma i dalej tak samo.
//   2. 'ship'   - ruch podany z zewnątrz przez setShipMotion() (np. przyszły serwer centralny statku);
//      też przepuszczany przez pasmo statku (stały przechył od ładunku nie jest kołysaniem).
//   3. 'sim'    - symulowane morze, gdy przez 2 s nie przyszły żadne dane (terminale na mostku,
//      laptopy). Dzięki temu efekt jest zawsze widoczny.
//
// Wszystko w układzie EKRANU (uwzględnia screen.orientation.angle):
//   roll     [deg]  + = prawa krawędź ekranu w dół
//   pitch    [deg]  + = górna krawędź ekranu w dół (od patrzącego)
//   heave    [m]    nurzanie, + = statek w górę (przyspieszenie pionowe całkowane z przeciekiem)
//   heaveAcc [m/s2] przyspieszenie pionowe w paśmie statku
//
// Kalibracja: przez pierwsze ~30 s po starcie (i po każdym obrocie ekranu) linia bazowa uczy się szybciej,
// więc tablet na stojaku albo terminal zamontowany pod kątem sam się "wypoziomuje". recalibrate()
// (oraz ukryty skrót Alt+Shift+K w MotionCues) robi to od razu: bieżąca pozycja = nowe zero.
// Kalibracja niczego nie wyłącza. Nie ma wyłącznika: system jest zawsze aktywny, zmienia się tylko intensywność.

import {
  G, LeakyHeave, Rms, ShipBand, TiltPipeline, clamp, classifySea, lpCoef, seaEnergy, simulateSea,
  type SeaLevel, type Vec3,
} from './filters';

export type { SeaLevel } from './filters';
export type MotionSource = 'sensor' | 'ship' | 'sim';
export interface MotionSample { roll: number; pitch: number; heave: number; heaveAcc: number; source: MotionSource }
export interface SeaState {
  /** RMS z ostatnich kilku sekund: roll/pitch w stopniach, heave w m/s2 */
  roll: number; pitch: number; heave: number;
  /** 0..1, steruje kryciem i gęstością kropek */
  energy: number;
  /** indeks w "równoważnych stopniach przechyłu" (RMS) */
  index: number;
  level: SeaLevel;
  source: MotionSource;
}

interface JuMotionDebug {
  roll: number; pitch: number; heave: number; energy: number; level: SeaLevel; source: MotionSource;
  calibrate: () => void;
}
declare global {
  interface Window { __juMotion?: JuMotionDebug }
}

const SENSOR_TIMEOUT_MS = 2000;
const SHIP_TIMEOUT_MS = 3000;
const MAX_TILT = 15;

const now = () => performance.now();

function screenAngle(): number {
  const a = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.angle
    : (typeof window !== 'undefined' && typeof (window as unknown as { orientation?: number }).orientation === 'number'
      ? (window as unknown as { orientation: number }).orientation : 0);
  return ((a % 360) + 360) % 360;
}

// Safari na iOS/iPadOS podaje accelerationIncludingGravity z odwrotnym znakiem niż specyfikacja W3C
// (płasko ekranem do góry: z = -9.81 zamiast +9.81). Odwracamy, żeby kierunek kropek był ten sam.
const IOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1));
const ACC_SIGN = IOS ? -1 : 1;

// ---------- stan czujnika ----------
const pipe = new TiltPipeline();
const heaveInt = new LeakyHeave(5);
const sensor = {
  last: -Infinity,          // ostatnie poprawne devicemotion
  oriLast: -Infinity,       // ostatnie deviceorientation użyte jako zapas
  angle: -1,                // kąt ekranu przy ostatnim kroku
  roll: 0, pitch: 0, heave: 0, heaveAcc: 0,
};
const acc: Vec3 = [0, 0, G];
const gyro: Vec3 = [0, 0, 0];

function feed(dt: number, withGyro: boolean) {
  const ang = screenAngle();
  // obrót ekranu: inne osie = inna linia bazowa, zaczynamy naukę od nowa (bez skoku)
  if (ang !== sensor.angle) { sensor.angle = ang; pipe.recenter(); heaveInt.reset(); }
  const o = pipe.step(acc, withGyro ? gyro : null, dt, ang);
  sensor.roll = clamp(o.roll, -MAX_TILT, MAX_TILT);
  sensor.pitch = clamp(o.pitch, -MAX_TILT, MAX_TILT);
  sensor.heaveAcc = clamp(o.heaveAcc, -5, 5);
  sensor.heave = clamp(heaveInt.step(sensor.heaveAcc, dt), -3, 3);
}

function onMotion(e: DeviceMotionEvent) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null || g.z == null) return;
  const t = now();
  const dt = sensor.last === -Infinity ? 0.016 : clamp((t - sensor.last) / 1000, 0.001, 0.2);
  sensor.last = t;
  acc[0] = g.x * ACC_SIGN; acc[1] = g.y * ACC_SIGN; acc[2] = g.z * ACC_SIGN;
  const r = e.rotationRate;
  const hasGyro = !!r && r.alpha != null && r.beta != null && r.gamma != null;
  if (hasGyro) { gyro[0] = r!.beta as number; gyro[1] = r!.gamma as number; gyro[2] = r!.alpha as number; }
  feed(dt, hasGyro);
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  const t = now();
  // tylko zapas, gdy devicemotion milczy (niektóre przeglądarki / ustawienia prywatności)
  if (t - sensor.last < SENSOR_TIMEOUT_MS) return;
  const dt = sensor.oriLast === -Infinity ? 0.016 : clamp((t - sensor.oriLast) / 1000, 0.001, 0.2);
  sensor.oriLast = t;
  // wektor "w górę" w układzie urządzenia z kątów W3C: Ry(-gamma) * Rx(-beta) * [0, 0, 1]
  const b = e.beta / 57.29577951308232, c = e.gamma / 57.29577951308232;
  acc[0] = -Math.sin(c) * Math.cos(b) * G;
  acc[1] = Math.sin(b) * G;
  acc[2] = Math.cos(c) * Math.cos(b) * G;
  feed(dt, false);
}

function sensorAlive(t: number) {
  return t - sensor.last < SENSOR_TIMEOUT_MS || t - sensor.oriLast < SENSOR_TIMEOUT_MS;
}

// ---------- uprawnienia iOS 13+ ----------
type PermissionCtor = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

function needsPermission(): boolean {
  const M = (typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : undefined) as unknown as PermissionCtor | undefined;
  const O = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined) as unknown as PermissionCtor | undefined;
  return typeof M?.requestPermission === 'function' || typeof O?.requestPermission === 'function';
}

let gestureHooked = false;
/** Jednorazowy nasłuch na pierwszy gest; prosi system o dostęp po cichu (bez naszego okna).
 *  Odmowa = zostaje symulacja / ruch statku. Musi być wywołane synchronicznie w obsłudze gestu. */
function hookPermissionGesture() {
  if (gestureHooked || !needsPermission()) return;
  gestureHooked = true;
  const ask = () => {
    removeEventListener('pointerdown', ask, true);
    removeEventListener('keydown', ask, true);
    const M = DeviceMotionEvent as unknown as PermissionCtor;
    const O = DeviceOrientationEvent as unknown as PermissionCtor;
    try { M.requestPermission?.().catch(() => undefined); } catch { /* brak gestu / odmowa */ }
    try { O.requestPermission?.().catch(() => undefined); } catch { /* j.w. */ }
  };
  addEventListener('pointerdown', ask, { capture: true, passive: true });
  addEventListener('keydown', ask, { capture: true, passive: true });
}

// ---------- zewnętrzny ruch statku (furtka dla serwera centralnego) ----------
const ship = {
  last: -Infinity, primed: false,
  roll: 0, pitch: 0, heaveAcc: 0,
  bRoll: new ShipBand(), bPitch: new ShipBand(), bHeave: new ShipBand(0.04, 0.7),
  heave: new LeakyHeave(5),
};

/** Podaj rzeczywisty ruch statku: roll/pitch w stopniach (układ statku: roll + = prawa burta w dół,
 *  pitch + = dziób w dół), heave = przyspieszenie pionowe w m/s2 (opcjonalnie). Wołać np. z WebSocketu
 *  serwera, 1-20 Hz. Dane przechodzą przez to samo pasmo co czujnik i są ważne 3 s; czujnik urządzenia
 *  (jeśli działa) ma pierwszeństwo, bo zna też orientację samego ekranu. */
export function setShipMotion(m: { roll: number; pitch: number; heave?: number }): void {
  if (!Number.isFinite(m.roll) || !Number.isFinite(m.pitch)) return;
  ship.roll = clamp(m.roll, -45, 45);
  ship.pitch = clamp(m.pitch, -30, 30);
  ship.heaveAcc = Number.isFinite(m.heave) ? clamp(m.heave as number, -20, 20) : 0;
  if (!ship.primed) {
    ship.bRoll.prime(ship.roll); ship.bPitch.prime(ship.pitch); ship.bHeave.prime(ship.heaveAcc);
    ship.heave.reset(); ship.primed = true;
  }
  ship.last = now();
}

// ---------- start / odczyt ----------
let refs = 0;
let started = -Infinity;
const seed = Math.random() * 1000;
const out: MotionSample = { roll: 0, pitch: 0, heave: 0, heaveAcc: 0, source: 'sim' };
let lastSample = -Infinity;
// płynne przejście między źródłami (np. czujnik zgasł -> symulacja)
const blend = { roll: 0, pitch: 0, heave: 0, heaveAcc: 0 };
let transitionUntil = 0;
// energia ruchu (RMS ~6 s) i poziom morza
const rms = { roll: new Rms(6), pitch: new Rms(6), heave: new Rms(6) };
const sea: SeaState = { roll: 0, pitch: 0, heave: 0, energy: 0, index: 0, level: 'spokojnie', source: 'sim' };
let calibratedAt = -Infinity;

/** Ponowne wycentrowanie ("Skalibruj"): bieżące położenie urządzenia staje się zerem, linia bazowa
 *  uczy się od nowa przez ~30 s. Nie wyłącza wskazówek. */
export function recalibrate(): void {
  pipe.recenter();
  heaveInt.reset();
  ship.primed = false;
  calibratedAt = now();
}

/** czas (performance.now) ostatniej ręcznej kalibracji - do krótkiego potwierdzenia na ekranie */
export function lastCalibration(): number { return calibratedAt; }

/** Bieżący stan morza (RMS z kilku sekund), np. dla innych modułów albo panelu mostka. */
export function getSeaState(): SeaState { return { ...sea }; }

/** Uruchamia nasłuch czujników (zliczanie referencji). Zwraca funkcję zatrzymującą. */
export function startMotion(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (refs++ === 0) {
    started = now();
    addEventListener('devicemotion', onMotion, { passive: true });
    addEventListener('deviceorientation', onOrientation, { passive: true });
    hookPermissionGesture();
  }
  return () => {
    if (--refs === 0) {
      removeEventListener('devicemotion', onMotion);
      removeEventListener('deviceorientation', onOrientation);
    }
  };
}

/** Bieżący ruch w układzie ekranu. Wołać raz na klatkę (także przy klatkach co 50 ms). */
export function readMotion(): MotionSample {
  const t = now();
  const dt = lastSample === -Infinity ? 0.016 : clamp((t - lastSample) / 1000, 0.001, 0.1);
  lastSample = t;

  let target: { roll: number; pitch: number; heave: number; heaveAcc: number };
  let source: MotionSource;
  if (sensorAlive(t)) {
    source = 'sensor';
    target = { roll: sensor.roll, pitch: sensor.pitch, heave: sensor.heave, heaveAcc: sensor.heaveAcc };
  } else if (t - ship.last < SHIP_TIMEOUT_MS && ship.primed) {
    source = 'ship';
    // dane z serwera przychodzą rzadko (schodki): pasmo statku wygładza je i usuwa stały przechył
    const ha = ship.bHeave.step(ship.heaveAcc, dt);
    target = {
      roll: clamp(ship.bRoll.step(ship.roll, dt), -MAX_TILT, MAX_TILT),
      pitch: clamp(ship.bPitch.step(ship.pitch, dt), -MAX_TILT, MAX_TILT),
      heaveAcc: ha,
      heave: clamp(ship.heave.step(ha, dt), -3, 3),
    };
  } else {
    source = 'sim';
    // po starcie symulacja narasta przez 3 s, żeby nic nie skakało
    const ramp = clamp((t - started) / 3000, 0, 1);
    const s = simulateSea(t / 1000, seed);
    target = { roll: s.roll * ramp, pitch: s.pitch * ramp, heave: s.heaveZ * ramp, heaveAcc: s.heaveAcc * ramp };
  }

  // zmiana źródła: przez 1.5 s wolniejsze wygładzanie, bez skoku
  if (source !== out.source) { transitionUntil = t + 1500; out.source = source; }
  const kb = lpCoef(dt, t < transitionUntil ? 0.6 : 0.03);
  blend.roll += (target.roll - blend.roll) * kb;
  blend.pitch += (target.pitch - blend.pitch) * kb;
  blend.heave += (target.heave - blend.heave) * kb;
  blend.heaveAcc += (target.heaveAcc - blend.heaveAcc) * kb;
  out.roll = blend.roll; out.pitch = blend.pitch; out.heave = blend.heave; out.heaveAcc = blend.heaveAcc;

  // stan morza z RMS, a nie z wartości chwilowej (inaczej krycie migałoby co pół fali)
  sea.roll = rms.roll.step(out.roll, dt);
  sea.pitch = rms.pitch.step(out.pitch, dt);
  sea.heave = rms.heave.step(out.heaveAcc, dt);
  const e = seaEnergy(sea.roll, sea.pitch, sea.heave);
  sea.index = e.index; sea.energy = e.energy; sea.source = source;
  sea.level = classifySea(e.index, sea.level);

  const dbg = window.__juMotion ?? (window.__juMotion = {
    roll: 0, pitch: 0, heave: 0, energy: 0, level: 'spokojnie', source: 'sim', calibrate: recalibrate,
  });
  dbg.roll = Math.round(out.roll * 100) / 100;
  dbg.pitch = Math.round(out.pitch * 100) / 100;
  dbg.heave = Math.round(out.heave * 100) / 100;
  dbg.energy = Math.round(sea.energy * 100) / 100;
  dbg.level = sea.level;
  dbg.source = source;
  return out;
}
