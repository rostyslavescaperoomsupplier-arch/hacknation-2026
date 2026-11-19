// Test matematyki systemu anty-rzyg.
// Uruchom: node --experimental-strip-types --test assistant/src/motion-cues/filters.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, LeakyHeave, Rms, ShipBand, TiltPipeline, classifySea, seaEnergy, simulateSea, type Vec3 } from './filters.ts';

const FS = 60;
const DT = 1 / FS;
const D2R = Math.PI / 180;

/** deterministyczny szum (LCG), żeby test był powtarzalny */
function noise(seed = 1) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
}

/** tablet leżący płasko, przechył theta(t) [deg] wokół osi y; zwraca odzyskany roll */
function runRoll(theta: (t: number) => number, opts: { gyro?: boolean; seconds?: number; pitchOffset?: number } = {}) {
  const { gyro = true, seconds = 120, pitchOffset = 0 } = opts;
  const p = new TiltPipeline();
  const rnd = noise(7);
  const out: { t: number; roll: number; pitch: number }[] = [];
  for (let i = 0; i < seconds * FS; i++) {
    const t = i * DT;
    const th = theta(t) * D2R;
    const dth = (theta(t + 1e-4) - theta(t - 1e-4)) / 2e-4; // deg/s
    const ph = pitchOffset * D2R;
    // wektor "w górę" (W3C): przechył w prawo w dół -> ujemne x; stałe pochylenie montażu wokół x
    const acc: Vec3 = [
      -G * Math.sin(th) + 0.05 * rnd(),
      G * Math.cos(th) * Math.sin(ph) + 0.05 * rnd(),
      G * Math.cos(th) * Math.cos(ph) + 0.05 * rnd(),
    ];
    const gy: Vec3 | null = gyro ? [0.2 * rnd(), dth + 0.2 * rnd(), 0] : null;
    const r = p.step(acc, gy, DT, 0);
    out.push({ t, roll: r.roll, pitch: r.pitch });
  }
  return out;
}

const ship = (t: number) => 5 * Math.sin(2 * Math.PI * 0.15 * t);
const jitter = (t: number) => 1.5 * Math.sin(2 * Math.PI * 2 * t + 0.3);
/** ktoś powoli przechyla tablet o 12 st. między 20 a 50 s i tak już trzyma */
const slowTilt = (t: number) => 12 * Math.min(1, Math.max(0, (t - 20) / 30));

function stats(rows: { t: number; roll: number }[], ref: (t: number) => number, from: number) {
  let se = 0, sr = 0, sxy = 0, sxx = 0, syy = 0, n = 0;
  for (const r of rows) {
    if (r.t < from) continue;
    const y = ref(r.t);
    se += (r.roll - y) ** 2; sr += y * y;
    sxy += r.roll * y; sxx += r.roll * r.roll; syy += y * y; n++;
  }
  return { rmsErr: Math.sqrt(se / n), rmsRef: Math.sqrt(sr / n), rmsOut: Math.sqrt(sxx / n), corr: sxy / Math.sqrt(sxx * syy) };
}

test('0.15 Hz roll + 2 Hz jitter + slow tilt -> odzyskany roll ~ składowa 0.15 Hz (z żyroskopem)', () => {
  const rows = runRoll((t) => ship(t) + jitter(t) + slowTilt(t));
  const s = stats(rows, ship, 70);
  console.log('  gyro:', s);
  assert.ok(s.corr > 0.97, `korelacja ${s.corr}`);
  assert.ok(s.rmsErr < 0.25 * s.rmsRef, `błąd RMS ${s.rmsErr} vs ${s.rmsRef}`);
  assert.ok(s.rmsOut / s.rmsRef > 0.85 && s.rmsOut / s.rmsRef < 1.15, `amplituda ${s.rmsOut / s.rmsRef}`);
});

test('to samo bez żyroskopu (tylko akcelerometr)', () => {
  const rows = runRoll((t) => ship(t) + jitter(t) + slowTilt(t), { gyro: false });
  const s = stats(rows, ship, 70);
  console.log('  accel:', s);
  assert.ok(s.corr > 0.95, `korelacja ${s.corr}`);
  assert.ok(s.rmsErr < 0.35 * s.rmsRef, `błąd RMS ${s.rmsErr}`);
});

test('drżenie 2 Hz jest tłumione', () => {
  const s = stats(runRoll(jitter), () => 0, 40);
  const rmsIn = 1.5 / Math.SQRT2;
  console.log('  jitter out/in:', s.rmsOut / rmsIn);
  assert.ok(s.rmsOut < 0.2 * rmsIn, `drżenie przeszło: ${s.rmsOut}`);
});

test('powolne przechylenie tabletu i krzywy montaż nie dają wskazania', () => {
  const s = stats(runRoll(slowTilt, { pitchOffset: 35 }), () => 0, 75);
  console.log('  slow tilt residual:', s.rmsOut);
  assert.ok(s.rmsOut < 0.3, `resztka ${s.rmsOut} st.`);
});

test('pochylony montaż (35 st.) nie psuje odczytu kołysania', () => {
  const s = stats(runRoll(ship, { pitchOffset: 35 }), ship, 50);
  assert.ok(s.corr > 0.97, `korelacja ${s.corr}`);
});

test('ponowne wycentrowanie: po recenter() wyjście zaczyna od zera bez skoku', () => {
  const p = new TiltPipeline();
  const acc: Vec3 = [-G * Math.sin(0.3), 0, G * Math.cos(0.3)];
  for (let i = 0; i < 600; i++) p.step(acc, [0, 0, 0], DT);
  p.recenter();
  const tilted: Vec3 = [-G * Math.sin(0.6), 0, G * Math.cos(0.6)];
  const r = p.step(tilted, [0, 0, 0], DT);
  assert.ok(Math.abs(r.roll) < 1e-6, `po kalibracji ${r.roll}`);
});

test('nurzanie: pasmo + podwójne całkowanie z przeciekiem odtwarza przemieszczenie bez dryfu', () => {
  const h = new LeakyHeave(6);
  const band = new ShipBand(0.04, 0.7);
  band.prime(G + 0.02);
  const f = 0.12, A = 0.5, w = 2 * Math.PI * f;
  let maxZ = 0;
  for (let i = 0; i < 200 * FS; i++) {
    const t = i * DT;
    const z = h.step(band.step(G - A * w * w * Math.sin(w * t) + 0.02, DT), DT); // g + stały błąd czujnika usuwa pasmo
    if (t > 150) maxZ = Math.max(maxZ, Math.abs(z));
  }
  assert.ok(maxZ > 0.3 && maxZ < 0.8, `amplituda ${maxZ}`);
});

test('energia i poziom morza z histerezą', () => {
  const r = new Rms(5);
  for (let i = 0; i < 30 * FS; i++) r.step(5 * Math.sin(2 * Math.PI * 0.12 * i * DT), DT);
  assert.ok(Math.abs(r.value - 5 / Math.SQRT2) < 0.4, `RMS ${r.value}`);
  assert.equal(classifySea(seaEnergy(0.3, 0.2, 0.02).index, 'spokojnie'), 'spokojnie');
  assert.equal(classifySea(seaEnergy(3.5, 1, 0.1).index, 'spokojnie'), 'umiarkowanie');
  assert.equal(classifySea(seaEnergy(6, 2, 0.3).index, 'umiarkowanie'), 'silnie');
  // na samej granicy nie przeskakuje
  assert.equal(classifySea(1.3, 'spokojnie'), 'spokojnie');
  assert.equal(classifySea(1.1, 'umiarkowanie'), 'umiarkowanie');
});

test('symulowane morze: okresy 7-12 s, roll kilka stopni', () => {
  let max = 0, cross = 0, prev = 0;
  for (let i = 0; i < 600 * 10; i++) {
    const s = simulateSea(i / 10, 3);
    max = Math.max(max, Math.abs(s.roll));
    if (prev < 0 && s.roll >= 0) cross++;
    prev = s.roll;
  }
  const period = 600 / cross;
  assert.ok(max > 3 && max < 7, `max roll ${max}`);
  assert.ok(period > 7 && period < 12, `okres ${period}`);
});
