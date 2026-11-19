// System anty-rzyg: źródło ruchu statku dla wskazówek przeciw chorobie morskiej.
//
// Kolejność źródeł (najlepsze wygrywa):
//   1. 'sensor' - akcelerometr / żyroskop urządzenia (telefon, tablet). Odczyty są filtrowane
//      dolnoprzepustowo, a od kąta przechyłu odejmowana jest bardzo wolna linia bazowa, więc liczy się
//      kołysanie statku, a nie to, jak ktoś trzyma tablet.
//   2. 'ship'   - ruch podany z zewnątrz przez setShipMotion() (np. przyszły serwer centralny statku).
//   3. 'sim'    - symulowany stan morza, gdy przez 2 s nie przyszły żadne dane (terminale na mostku,
//      laptopy). Dzięki temu efekt jest zawsze widoczny.
//
// Wszystko w układzie EKRANU (uwzględnia screen.orientation.angle):
//   roll  [deg]  + = prawa krawędź ekranu w dół
//   pitch [deg]  + = górna krawędź ekranu w dół (od użytkownika)
//   ax    [m/s2] przyspieszenie liniowe, + = w prawo
//   ay    [m/s2] przyspieszenie liniowe, + = w górę ekranu
//   heave [m/s2] przyspieszenie pionowe (przód/tył ekranu), + = do góry
// Nie ma wyłącznika: system jest zawsze aktywny, zmienia się tylko intensywność.

export type MotionSource = 'sensor' | 'ship' | 'sim';
export interface MotionSample { roll: number; pitch: number; ax: number; ay: number; heave: number; source: MotionSource }

declare global {
  interface Window { __juMotion?: { roll: number; pitch: number; source: MotionSource } }
}

const SENSOR_TIMEOUT_MS = 2000;
const SHIP_TIMEOUT_MS = 3000;
const MAX_TILT = 15;
const RAD = 180 / Math.PI;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const now = () => performance.now();
/** współczynnik filtru wykładniczego dla stałej czasowej tau [s] i kroku dt [s] */
const lp = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

function screenAngle(): number {
  const a = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.angle
    : (typeof window !== 'undefined' && typeof (window as unknown as { orientation?: number }).orientation === 'number'
      ? (window as unknown as { orientation: number }).orientation : 0);
  return ((a % 360) + 360) % 360;
}
/** wektor (x, y) w układzie urządzenia (x w prawo, y w górę w pozycji naturalnej) -> układ ekranu */
function toScreen(x: number, y: number): [number, number] {
  const a = screenAngle() / RAD;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

// ---------- stan czujnika ----------
const sensor = {
  last: -Infinity,          // czas ostatniego poprawnego zdarzenia
  t: 0,
  gx: 0, gy: 0, gz: 9.81,   // grawitacja (filtrowana) w układzie urządzenia
  lx: 0, ly: 0, lz: 0,      // przyspieszenie liniowe (filtrowane)
  baseRoll: 0, basePitch: 0, hasBase: false,
  roll: 0, pitch: 0,
  oriLast: -Infinity, oriRoll: 0, oriPitch: 0,
};

function updateTilt(rawRoll: number, rawPitch: number, dt: number) {
  if (!sensor.hasBase) { sensor.baseRoll = rawRoll; sensor.basePitch = rawPitch; sensor.hasBase = true; }
  // linia bazowa ~25 s: kołysanie (okres 6-12 s) przechodzi, trzymanie tabletu pod kątem nie
  const kb = lp(dt, 25);
  sensor.baseRoll += (rawRoll - sensor.baseRoll) * kb;
  sensor.basePitch += (rawPitch - sensor.basePitch) * kb;
  const ks = lp(dt, 0.25);
  sensor.roll += (clamp(rawRoll - sensor.baseRoll, -MAX_TILT, MAX_TILT) - sensor.roll) * ks;
  sensor.pitch += (clamp(rawPitch - sensor.basePitch, -MAX_TILT, MAX_TILT) - sensor.pitch) * ks;
}

function onMotion(e: DeviceMotionEvent) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null || g.z == null) return;
  const t = now();
  const dt = sensor.last === -Infinity ? 0.016 : clamp((t - sensor.last) / 1000, 0.001, 0.2);
  sensor.last = t;
  // grawitacja = wolny filtr (0.4 s); liniowe = z e.acceleration, a jeśli brak - różnica
  const kg = lp(dt, 0.4);
  sensor.gx += (g.x - sensor.gx) * kg;
  sensor.gy += (g.y - sensor.gy) * kg;
  sensor.gz += (g.z - sensor.gz) * kg;
  const a = e.acceleration;
  const lx = a && a.x != null ? a.x : g.x - sensor.gx;
  const ly = a && a.y != null ? a.y : g.y - sensor.gy;
  const lz = a && a.z != null ? a.z : g.z - sensor.gz;
  const kl = lp(dt, 0.15);
  sensor.lx += (lx - sensor.lx) * kl;
  sensor.ly += (ly - sensor.ly) * kl;
  sensor.lz += (lz - sensor.lz) * kl;

  // przechył z wektora grawitacji w układzie ekranu (znak grawitacji zależy od platformy,
  // ale linia bazowa i tak usuwa stałą część, a liczy się tylko kierunek zmian)
  const [sx, sy] = toScreen(sensor.gx, sensor.gy);
  const gz = sensor.gz;
  const rawRoll = Math.atan2(sx, Math.hypot(sy, gz)) * RAD;
  const rawPitch = Math.atan2(sy, Math.hypot(sx, gz)) * RAD;
  updateTilt(rawRoll, rawPitch, dt);
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  const t = now();
  // używane tylko, gdy devicemotion nie daje danych (niektóre przeglądarki / ustawienia prywatności)
  if (t - sensor.last < SENSOR_TIMEOUT_MS && sensor.oriLast !== -Infinity) { sensor.oriLast = t; return; }
  const dt = sensor.oriLast === -Infinity ? 0.016 : clamp((t - sensor.oriLast) / 1000, 0.001, 0.2);
  sensor.oriLast = t;
  const [r, p] = toScreen(e.gamma, -e.beta);
  updateTilt(r, p, dt);
  sensor.lx *= 0.9; sensor.ly *= 0.9; sensor.lz *= 0.9;
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
const ship = { last: -Infinity, roll: 0, pitch: 0, heave: 0, sroll: 0, spitch: 0, sheave: 0, vroll: 0, vpitch: 0 };

/** Podaj rzeczywisty ruch statku (stopnie; heave w m/s2, opcjonalnie). Wołać np. z WebSocketu serwera,
 *  1-20 Hz. Dane są wygładzane i ważne 3 s; czujnik urządzenia (jeśli działa) ma pierwszeństwo. */
export function setShipMotion(m: { roll: number; pitch: number; heave?: number }): void {
  if (!Number.isFinite(m.roll) || !Number.isFinite(m.pitch)) return;
  ship.roll = clamp(m.roll, -45, 45);
  ship.pitch = clamp(m.pitch, -30, 30);
  ship.heave = Number.isFinite(m.heave) ? clamp(m.heave as number, -20, 20) : 0;
  ship.last = now();
}

// ---------- symulowany stan morza ----------
// roll ±4 deg / ~9 s, pitch ±1.5 deg / ~6 s, amplituda i okres pływają wolno (niewspółmierne sinusy = brak powtarzalności)
const seed = Math.random() * 1000;
function simulate(tSec: number): { roll: number; pitch: number; heave: number; ax: number; ay: number } {
  const t = tSec + seed;
  const swell = 0.75 + 0.18 * Math.sin(t * 0.037) + 0.07 * Math.sin(t * 0.091 + 1.3);       // 0.5..1.0
  const ph = 2 * Math.PI * t / 9 + 0.35 * Math.sin(t * 0.05);                                // okres ~8.5-9.5 s
  const roll = 4 * swell * (Math.sin(ph) + 0.12 * Math.sin(2.7 * ph + 0.4));
  const pp = 2 * Math.PI * t / 6 + 0.25 * Math.sin(t * 0.071 + 2);
  const pitch = 1.5 * (0.8 + 0.2 * Math.sin(t * 0.043 + 0.7)) * Math.sin(pp);
  // przyspieszenia z kinematyki: d2(roll)/dt2 przeskalowane do poziomu kołysania
  // poprzeczne ~0.35 m/s2 (ramię ~10 m przy 4 deg / 9 s), w przeciwfazie do przechyłu
  const ax = -0.35 * swell * Math.sin(ph);
  const heave = 0.35 * Math.sin(2 * Math.PI * t / 7 + 1.1);
  const ay = 0.15 * Math.sin(pp + 0.6);
  return { roll, pitch, heave, ax, ay };
}

// ---------- start / odczyt ----------
let refs = 0;
let started = -Infinity;
const out: MotionSample = { roll: 0, pitch: 0, ax: 0, ay: 0, heave: 0, source: 'sim' };
let lastSample = -Infinity;
// płynne przejście między źródłami (np. czujnik zgasł -> symulacja)
const blend = { roll: 0, pitch: 0, ax: 0, ay: 0, heave: 0 };
let transitionUntil = 0;

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

/** Bieżący ruch w układzie ekranu. Wołać raz na klatkę. */
export function readMotion(): MotionSample {
  const t = now();
  const dt = lastSample === -Infinity ? 0.016 : clamp((t - lastSample) / 1000, 0.001, 0.1);
  lastSample = t;

  let target: { roll: number; pitch: number; ax: number; ay: number; heave: number };
  let source: MotionSource;
  if (sensorAlive(t)) {
    source = 'sensor';
    const [lx, ly] = toScreen(sensor.lx, sensor.ly);
    target = { roll: sensor.roll, pitch: sensor.pitch, ax: lx, ay: ly, heave: sensor.lz };
  } else if (t - ship.last < SHIP_TIMEOUT_MS) {
    source = 'ship';
    const k = lp(dt, 0.4);
    const pr = ship.sroll, pp = ship.spitch;
    ship.sroll += (ship.roll - ship.sroll) * k;
    ship.spitch += (ship.pitch - ship.spitch) * k;
    ship.sheave += (ship.heave - ship.sheave) * k;
    // poprzeczne przyspieszenie z prędkości zmiany przechyłu (przybliżenie)
    const vr = (ship.sroll - pr) / dt, vp = (ship.spitch - pp) / dt;
    const ar = (vr - ship.vroll) / dt, ap = (vp - ship.vpitch) / dt;
    ship.vroll = vr; ship.vpitch = vp;
    target = { roll: ship.sroll, pitch: ship.spitch, ax: clamp(-ar * 0.06, -3, 3), ay: clamp(-ap * 0.06, -3, 3), heave: ship.sheave };
  } else {
    source = 'sim';
    // pierwsze 2 s po starcie: symulacja też działa (narasta od zera), żeby nic nie skakało
    const ramp = clamp((t - started) / 3000, 0, 1);
    const s = simulate(t / 1000);
    target = { roll: s.roll * ramp, pitch: s.pitch * ramp, ax: s.ax * ramp, ay: s.ay * ramp, heave: s.heave * ramp };
  }

  // zmiana źródła (np. czujnik zgasł -> symulacja): przez 1.5 s wolniejsze wygładzanie, bez skoku
  if (source !== out.source) { transitionUntil = t + 1500; out.source = source; }
  const kb = lp(dt, t < transitionUntil ? 0.6 : 0.05);
  blend.roll += (target.roll - blend.roll) * kb;
  blend.pitch += (target.pitch - blend.pitch) * kb;
  blend.ax += (target.ax - blend.ax) * kb;
  blend.ay += (target.ay - blend.ay) * kb;
  blend.heave += (target.heave - blend.heave) * kb;
  out.roll = blend.roll; out.pitch = blend.pitch; out.ax = blend.ax; out.ay = blend.ay; out.heave = blend.heave;
  const dbg = window.__juMotion ?? (window.__juMotion = { roll: 0, pitch: 0, source: 'sim' });
  dbg.roll = Math.round(out.roll * 100) / 100;
  dbg.pitch = Math.round(out.pitch * 100) / 100;
  dbg.source = source;
  return out;
}
