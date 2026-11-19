// System anty-rzyg: czysta matematyka filtrów (bez DOM), żeby dało się ją testować w Node.
//
// Podstawa: choroba morska to konflikt sensoryczny - błędnik czuje ruch statku, oczy widzą nieruchomy
// ekran. Najbardziej mdlący jest ruch wolny, ok. 0.1-0.3 Hz (kołysanie boczne / wzdłużne / nurzanie
// promu, okresy 4-12 s). Dlatego sygnał ograniczamy do tego pasma:
//   - górnoprzepustowy ~0.03 Hz usuwa linię bazową: kąt, pod którym ktoś trzyma tablet, albo
//     pochylony montaż terminala; filtr 2. rzędu usuwa też powolne "dryfowanie" (rampę) do zera;
//   - dolnoprzepustowy ~0.7 Hz usuwa drżenie ręki i drgania maszynowni (>1 Hz).
// Fazy obu filtrów przy 0.15 Hz prawie się znoszą (+16 i -18 stopni), więc kropki nie spóźniają się
// względem tego, co czuje ucho.

export const RAD = 180 / Math.PI;
export const G = 9.80665;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** współczynnik filtru wykładniczego dla stałej czasowej tau [s] i kroku dt [s] */
export const lpCoef = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

// ---------- filtr 2. rzędu (SVF, topologia TPT) ----------
// Stabilny przy zmiennym kroku dt (zdarzenia czujnika i klatki nie przychodzą równo), daje naraz
// wyjście dolno- i górnoprzepustowe. Q = 0.7071 = Butterworth (bez rezonansu).
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  fc: number;
  private q: number;
  constructor(fc: number, q = Math.SQRT1_2) { this.fc = fc; this.q = q; }
  /** ustawia stan ustalony dla stałego wejścia x0 (wyjście LP = x0, HP = 0) - brak skoku po starcie */
  prime(x0: number): void { this.ic1 = 0; this.ic2 = x0; }
  step(x: number, dt: number): { lp: number; hp: number } {
    const g = Math.tan(Math.PI * Math.min(this.fc * dt, 0.45));
    const k = 1 / this.q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return { lp: v2, hp: x - k * v1 - v2 };
  }
}

/** Pasmo ruchu statku: górnoprzepustowy (linia bazowa) + dolnoprzepustowy (drżenie). */
export class ShipBand {
  readonly hp: Svf;
  readonly lp: Svf;
  /** wolna składowa usunięta przez górnoprzepustowy (= nauczona linia bazowa, np. kąt montażu) */
  baseline = 0;
  constructor(hpHz = 0.03, lpHz = 0.7) { this.hp = new Svf(hpHz); this.lp = new Svf(lpHz); }
  prime(x0: number): void { this.hp.prime(x0); this.lp.prime(0); this.baseline = x0; }
  step(x: number, dt: number): number {
    const h = this.hp.step(x, dt);
    this.baseline = h.lp;
    return this.lp.step(h.hp, dt).lp;
  }
}

// ---------- fuzja czujników (filtr komplementarny na wektorze "w górę") ----------
export type Vec3 = [number, number, number];

/**
 * Jeden krok filtru komplementarnego. Szacujemy wektor "w górę" w układzie urządzenia:
 *  - żyroskop: obracamy poprzednią estymatę o -omega*dt (du/dt = -omega x u) - szybki i gładki, ale dryfuje;
 *  - akcelerometr (z grawitacją): mówi, gdzie jest góra, ale zaszumiony i zaburzony przyspieszeniami
 *    statku; wchodzi tylko wolno, ze stałą czasową tau.
 * Przy tau = 5 s żyroskop rządzi w paśmie kołysania (>0.03 Hz), akcelerometr tylko usuwa dryf.
 * Bez żyroskopu (null) zostaje sam akcelerometr wygładzony stałą tauNoGyro.
 * @param up    poprzednia estymata (modyfikowana w miejscu), w m/s2
 * @param acc   accelerationIncludingGravity w konwencji W3C (płasko ekranem do góry = [0, 0, +9.81])
 * @param gyroDeg rotationRate [x=beta, y=gamma, z=alpha] w stopniach/s albo null
 */
export function fuseUp(up: Vec3, acc: Vec3, gyroDeg: Vec3 | null, dt: number, tau = 5, tauNoGyro = 0.15): Vec3 {
  if (gyroDeg) {
    const wx = gyroDeg[0] / RAD, wy = gyroDeg[1] / RAD, wz = gyroDeg[2] / RAD;
    const [ux, uy, uz] = up;
    // u - (omega x u) * dt
    up[0] = ux - (wy * uz - wz * uy) * dt;
    up[1] = uy - (wz * ux - wx * uz) * dt;
    up[2] = uz - (wx * uy - wy * ux) * dt;
  }
  const k = lpCoef(dt, gyroDeg ? tau : tauNoGyro);
  up[0] += (acc[0] - up[0]) * k;
  up[1] += (acc[1] - up[1]) * k;
  up[2] += (acc[2] - up[2]) * k;
  return up;
}

/** obrót wektora (x, y) z układu urządzenia do układu ekranu dla screen.orientation.angle [deg] */
export function toScreen(x: number, y: number, angleDeg: number): [number, number] {
  const a = angleDeg / RAD;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Przechył i pochylenie ekranu z wektora "w górę" (już w układzie ekranu).
 *   roll  + = prawa krawędź ekranu w dół
 *   pitch + = górna krawędź ekranu w dół (od patrzącego)
 * pitch = atan2(-uy, uz) działa i dla tabletu leżącego płasko, i dla pionowego terminala
 * (wtedy zmienia się uz, a nie uy). Stała część (np. -90 st. dla pionu) i tak znika w filtrze pasma.
 */
export function tiltFromUp(sx: number, sy: number, uz: number): { roll: number; pitch: number } {
  return {
    roll: Math.atan2(-sx, Math.hypot(sy, uz)) * RAD,
    pitch: Math.atan2(-sy, uz) * RAD,
  };
}

/** zawija kąt do (-180, 180] względem odniesienia, żeby atan2 nie skakał o 360 */
export function unwrapNear(a: number, ref: number): number {
  let d = a - ref;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return ref + d;
}

export interface TiltOut { roll: number; pitch: number; heaveAcc: number; rawRoll: number; rawPitch: number }

/**
 * Pełny tor dla jednego urządzenia: fuzja -> kąty ekranu -> pasmo statku.
 * Używany przez sensors.ts i testowany w filters.test.ts.
 */
export class TiltPipeline {
  readonly up: Vec3 = [0, 0, G];
  readonly roll = new ShipBand();
  readonly pitch = new ShipBand();
  readonly heave = new ShipBand(0.04, 0.7);
  private primed = false;
  private lastPitchRaw = 0;
  /** czas od ostatniej kalibracji [s]; przez pierwsze LEARN_S linia bazowa uczy się szybciej */
  sinceCal = 0;
  /** jak długo sygnał po filtrze jest nienaturalnie duży (ktoś przełożył tablet) [s] */
  private bigFor = 0;
  out: TiltOut = { roll: 0, pitch: 0, heaveAcc: 0, rawRoll: 0, rawPitch: 0 };

  static readonly LEARN_S = 30;
  static readonly HP_LEARN_HZ = 0.12;
  static readonly HP_HZ = 0.03;

  /** ponowne wycentrowanie: aktualna pozycja staje się nową linią bazową, nauka od zera */
  recenter(): void { this.primed = false; }

  step(acc: Vec3, gyroDeg: Vec3 | null, dt: number, screenAngleDeg = 0): TiltOut {
    if (!this.primed) { this.up[0] = acc[0]; this.up[1] = acc[1]; this.up[2] = acc[2]; }
    fuseUp(this.up, acc, gyroDeg, dt);
    const [sx, sy] = toScreen(this.up[0], this.up[1], screenAngleDeg);
    const t = tiltFromUp(sx, sy, this.up[2]);
    const rawPitch = this.primed ? unwrapNear(t.pitch, this.lastPitchRaw) : t.pitch;
    this.lastPitchRaw = rawPitch;
    // pionowe przyspieszenie: rzut pomiaru na kierunek "w górę" (stała g znika w filtrze)
    const n = Math.hypot(this.up[0], this.up[1], this.up[2]) || G;
    const vert = (acc[0] * this.up[0] + acc[1] * this.up[1] + acc[2] * this.up[2]) / n;

    if (!this.primed) {
      this.roll.prime(t.roll); this.pitch.prime(rawPitch); this.heave.prime(vert);
      this.primed = true; this.sinceCal = 0; this.bigFor = 0;
    }
    // nauka montażu: górnoprzepustowy startuje szybki (0.12 Hz) i przez 30 s zwalnia do 0.03 Hz
    this.sinceCal += dt;
    const p = clamp(this.sinceCal / TiltPipeline.LEARN_S, 0, 1);
    const hpHz = TiltPipeline.HP_LEARN_HZ + (TiltPipeline.HP_HZ - TiltPipeline.HP_LEARN_HZ) * p;
    this.roll.hp.fc = hpHz; this.pitch.hp.fc = hpHz;

    const r = this.roll.step(t.roll, dt);
    const q = this.pitch.step(rawPitch, dt);
    const h = this.heave.step(vert, dt);
    // ponad 20 st. przez 2 s to nie fala, tylko zmiana chwytu / położenia: samo-wycentrowanie
    this.bigFor = Math.abs(r) > 20 || Math.abs(q) > 20 ? this.bigFor + dt : 0;
    if (this.bigFor > 2) this.recenter();

    this.out.roll = r; this.out.pitch = q; this.out.heaveAcc = h;
    this.out.rawRoll = t.roll; this.out.rawPitch = rawPitch;
    return this.out;
  }
}

// ---------- nurzanie (heave): przyspieszenie pionowe całkowane z upływem ----------
/** podwójne całkowanie z "przeciekiem" (bez przecieku dryf rośnie bez końca): a -> v -> przemieszczenie */
export class LeakyHeave {
  v = 0;
  z = 0;
  private tau: number;
  constructor(tau = 4) { this.tau = tau; }
  reset(): void { this.v = 0; this.z = 0; }
  step(a: number, dt: number): number {
    const leak = Math.exp(-dt / this.tau);
    this.v = this.v * leak + a * dt;
    this.z = this.z * leak + this.v * dt;
    return this.z;
  }
}

// ---------- energia ruchu (RMS) i stan morza ----------
/** RMS z okna wykładniczego ~tau s (średnia kwadratów) */
export class Rms {
  ms = 0;
  private tau: number;
  constructor(tau = 5) { this.tau = tau; }
  step(x: number, dt: number): number {
    this.ms += (x * x - this.ms) * lpCoef(dt, this.tau);
    return Math.sqrt(this.ms);
  }
  get value(): number { return Math.sqrt(this.ms); }
}

export type SeaLevel = 'spokojnie' | 'umiarkowanie' | 'silnie';

/**
 * Indeks energii w "równoważnych stopniach przechyłu" (RMS): roll waży najwięcej (najsilniejszy bodziec
 * na promie), pitch 0.8, nurzanie 4 st. na 1 m/s2. Zwraca też wersję 0..1 do sterowania kryciem.
 * Kołysanie +-5 st. (RMS ~3.5) to już wyraźnie "umiarkowanie".
 */
export function seaEnergy(rollRms: number, pitchRms: number, heaveRms: number): { index: number; energy: number } {
  const index = Math.sqrt(rollRms * rollRms + 0.64 * pitchRms * pitchRms + 16 * heaveRms * heaveRms);
  return { index, energy: clamp(index / 6, 0, 1) };
}

/** poziom z histerezą, żeby nie migał na granicy */
export function classifySea(index: number, prev: SeaLevel): SeaLevel {
  const h = 0.25;
  if (prev === 'spokojnie') return index > 4 + h ? 'silnie' : index > 1.2 + h ? 'umiarkowanie' : 'spokojnie';
  if (prev === 'silnie') return index < 1.2 - h ? 'spokojnie' : index < 4 - h ? 'umiarkowanie' : 'silnie';
  return index > 4 + h ? 'silnie' : index < 1.2 - h ? 'spokojnie' : 'umiarkowanie';
}

// ---------- symulowane morze (terminale bez czujników) ----------
/**
 * Fala martwa jako suma 2-3 sinusów o okresach 7-12 s (niewspółmierne = nie powtarza się),
 * z powoli pływającą amplitudą (grupy fal co ~1-2 min). Wartości typowe dla promu ro-pax przy
 * umiarkowanym morzu: roll ~+-4 st., pitch ~+-1.5 st., nurzanie ~+-0.6 m.
 */
export function simulateSea(tSec: number, seed = 0): { roll: number; pitch: number; heaveZ: number; heaveAcc: number } {
  const t = tSec + seed;
  const env = 0.78 + 0.16 * Math.sin(2 * Math.PI * t / 97) + 0.08 * Math.sin(2 * Math.PI * t / 41 + 1.3);
  const w = (T: number) => 2 * Math.PI / T;
  const roll = env * (3.1 * Math.sin(w(9.4) * t) + 1.3 * Math.sin(w(11.7) * t + 0.8) + 0.6 * Math.sin(w(7.3) * t + 2.1));
  const pitch = (0.9 + 0.1 * Math.sin(2 * Math.PI * t / 63)) * (1.0 * Math.sin(w(7.1) * t + 0.4) + 0.55 * Math.sin(w(8.9) * t + 1.9));
  const h1 = 0.45 * Math.sin(w(8.3) * t + 1.1), h2 = 0.2 * Math.sin(w(10.6) * t + 2.6);
  const heaveZ = env * (h1 + h2);
  const heaveAcc = -env * (h1 * w(8.3) ** 2 + h2 * w(10.6) ** 2);
  return { roll, pitch, heaveZ, heaveAcc };
}
