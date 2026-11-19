// System anty-rzyg (wskazówki ruchu pojazdu, idea jak "Vehicle Motion Cues" w iOS 18).
//
// Choroba morska bierze się z konfliktu: błędnik czuje kołysanie promu, a oczy patrzą na nieruchomy ekran.
// Dajemy oczom ten sam ruch, który czuje ucho wewnętrzne, w wąskim pasie (24 px) przy krawędziach:
//  - kropki przy lewej i prawej krawędzi (na poziomym tablecie także u góry i u dołu) zachowują się jak
//    przyklejone do świata za oknem: przechył (roll) rozsuwa kolumny w przeciwne strony jak horyzont,
//    pochylenie (pitch) i nurzanie (heave) przesuwają obie kolumny razem w pionie;
//  - sztuczny horyzont: dwie krótkie kreski na lewej i prawej krawędzi, obrócone o kąt przechyłu
//    i przesunięte z pochyleniem - najsilniejsza wskazówka na statku, bo kołysanie boczne dominuje.
// Kierunek: "świat stoi" - gdy prawa burta idzie w dół, horyzont po prawej idzie w górę ekranu,
// dokładnie tak, jak w oknie mesy.
//
// Zasady:
// - zawsze włączone, bez żadnego wyłącznika (ani ustawienia, ani localStorage); zmienia się tylko
//   intensywność: krycie zależy od energii ruchu (RMS z kilku sekund), w spoczynku ~0.14, nigdy zero;
// - przy silnym morzu kropek jest trochę więcej i są odrobinę większe (dalej subtelnie);
// - nakładka nie przechwytuje dotyku ani przewijania (pointer-events: none), jest aria-hidden,
//   mieści się w bezpiecznym obszarze (env(safe-area-inset-*)) i nie zmienia układu strony;
// - z-index 40: nad treścią i nagłówkiem (30), pod alarmami i oknami modalnymi (50+);
// - kolor z --motion-dot-color (np. czerwony tryb nocny na mostku), inaczej --c-ink;
// - 60 kl./s przez requestAnimationFrame, ~20 kl./s gdy ruch jest znikomy, pauza gdy karta ukryta;
// - prefers-reduced-motion: dalej działa (to pomoc dostępności), ale mniejsza amplituda i łagodniejsze sprężyny;
// - "Skalibruj" (wycentrowanie): ukryty skrót Alt+Shift+K albo funkcja recalibrate() / skalibruj();
//   to nie jest wyłącznik, tylko nowe zero dla tabletu na stojaku / krzywo zamontowanego terminala.
// Źródło ruchu: czujniki urządzenia, ruch statku z serwera (setShipMotion) albo symulowane morze (sensors.ts).
import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../types';
import { getSeaState, lastCalibration, readMotion, recalibrate, startMotion, type SeaLevel } from './sensors';

export { setShipMotion, getSeaState, recalibrate } from './sensors';
export type { SeaState, SeaLevel } from './sensors';
/** "Skalibruj": bieżące położenie urządzenia staje się zerem (alias recalibrate). */
export const skalibruj = recalibrate;

const BAND = 24;            // szerokość pasa przy krawędzi, CSS px - nic nie wychodzi dalej
const DOT_X = 9;            // środek kolumny kropek od krawędzi
const DOT_R = 3;            // promień kropki w spokoju
const DOT_R_GAIN = 0.9;     // + przy pełnej energii
const CROSS_MAX = BAND / 2 - DOT_R - DOT_R_GAIN - 1; // poprzeczne wychylenie, dalej w pasie
const TICK_LEN = 18;        // długość kreski horyzontu
const ALPHA_REST = 0.14;
const ALPHA_MAX = 0.4;
const PX_PER_DEG_ROLL = 7;  // 5 st. przechyłu = 35 px, wyraźnie widać
const PX_PER_DEG_PITCH = 6;
const PX_PER_M_HEAVE = 22;  // nurzanie +-0.6 m = ~13 px
const MAX_OFFSET = 70;
const SLOW_FRAME_MS = 50;   // ~20 kl./s przy znikomym ruchu

interface Dot { y: number; x: number; vy: number; vx: number; resp: number }
interface Track { kind: 'col' | 'row'; side: -1 | 1; dots: Dot[] }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (v: number, m: number) => ((v % m) + m) % m;

function readColor(): string {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--motion-dot-color').trim() || cs.getPropertyValue('--c-ink').trim() || '#12303f';
}

function makeTrack(kind: Track['kind'], side: Track['side'], n: number): Track {
  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    // różne czasy odpowiedzi sprężyn = lekkie opóźnienie fazy, kropki "płyną" falą
    const resp = 0.42 + 0.22 * Math.abs(Math.sin(i * 1.7 + (side > 0 ? 0.9 : 0) + (kind === 'row' ? 2.1 : 0)));
    dots.push({ y: 0, x: 0, vy: 0, vx: 0, resp });
  }
  return { kind, side, dots };
}

const LEVEL_TEXT: Record<Lang, Record<SeaLevel, string>> = {
  pl: { spokojnie: 'Stan morza: spokojny', umiarkowanie: 'Stan morza: umiarkowany', silnie: 'Stan morza: silny' },
  en: { spokojnie: 'Sea state: calm', umiarkowanie: 'Sea state: moderate', silnie: 'Sea state: rough' },
  de: { spokojnie: 'Seegang: ruhig', umiarkowanie: 'Seegang: mäßig', silnie: 'Seegang: stark' },
  uk: { spokojnie: 'Стан моря: спокійний', umiarkowanie: 'Стан моря: помірний', silnie: 'Стан моря: сильний' },
};
const ALWAYS_ON: Record<Lang, string> = {
  pl: 'System przeciw chorobie morskiej jest zawsze włączony.',
  en: 'The anti seasickness motion cues are always on.',
  de: 'Die Hinweise gegen Seekrankheit sind immer aktiv.',
  uk: 'Система проти морської хвороби завжди увімкнена.',
};
const ANNOUNCE_MIN_MS = 60_000;

export default function MotionCues({ lang = 'pl' }: { lang?: Lang } = {}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [announced, setAnnounced] = useState<SeaLevel | null>(null);

  useEffect(() => {
    const host = wrapRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const stopSensors = startMotion();
    let W = 0, H = 0, dpr = 1;
    let tracks: Track[] = [];
    let dense = false;          // gęstsze kropki przy silnym morzu
    let color = readColor();
    let colorAt = 0;
    const rmq = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = rmq.matches;
    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let energy = 0;             // wygładzona energia 0..1 (z RMS, więc bez migania)
    let speed = 0;              // średnia prędkość kropek z poprzedniej klatki, px/s
    const horizon = { y: 0, vy: 0, a: 0, va: 0 };

    function buildTracks() {
      // przy zmianie gęstości nowe kropki startują ze średniego przesunięcia starych (bez skoku)
      const prev = new Map(tracks.map((t) => [t.kind + t.side, t.dots.reduce((s, d) => s + d.y, 0) / (t.dots.length || 1)]));
      const nCol = clamp(Math.round(H / 80), 8, 10) + (dense ? 3 : 0);
      tracks = [makeTrack('col', -1, nCol), makeTrack('col', 1, nCol)];
      // poziomy tablet: dodatkowo rzędy u góry i u dołu
      if (W > H && Math.min(W, H) >= 600) {
        const nRow = clamp(Math.round(W / 110), 8, 12) + (dense ? 3 : 0);
        tracks.push(makeTrack('row', -1, nRow), makeTrack('row', 1, nRow));
      }
      for (const t of tracks) {
        const y = prev.get(t.kind + t.side) ?? 0;
        for (const d of t.dots) d.y = y;
      }
    }

    function layout() {
      const r = host!.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildTracks();
    }

    /** sprężyna krytycznie tłumiona (bez przerzutu), rozwiązanie dokładne - stabilna przy każdym dt,
     *  także przy 20 kl./s i przy przyciętych klatkach w tle */
    function spring(pos: number, vel: number, target: number, period: number, dt: number): [number, number] {
      const w = (2 * Math.PI) / period;
      const e0 = pos - target;
      const c = vel + w * e0;
      const ex = Math.exp(-w * dt);
      return [target + (e0 + c * dt) * ex, (vel - w * c * dt) * ex];
    }

    function frame(ts: number) {
      raf = requestAnimationFrame(frame);
      const m = readMotion();
      const sea = getSeaState();
      // znikomy ruch: rysujemy co ~50 ms (oszczędza baterię tabletu)
      const calm = sea.energy < 0.12 && speed < 4;
      if (calm && lastDraw && ts - lastDraw < SLOW_FRAME_MS) return;
      const dt = last ? clamp((ts - last) / 1000, 0.001, 0.08) : 0.016;
      last = ts; lastDraw = ts;

      if (ts - colorAt > 1000) { color = readColor(); colorAt = ts; }
      energy += (sea.energy - energy) * (1 - Math.exp(-dt / 1.5));
      // gęstość z histerezą: włącz przy silnym morzu, wyłącz dopiero przy umiarkowanym/niższym
      const wantDense = dense ? sea.index > 3.4 : sea.level === 'silnie';
      if (wantDense !== dense) { dense = wantDense; buildTracks(); }

      const amp = reduced ? 0.6 : 1;
      const slow = reduced ? 1.6 : 1;
      // "świat stoi": roll+ (prawa krawędź w dół) -> prawa strona horyzontu w górę ekranu
      const rollPx = m.roll * PX_PER_DEG_ROLL;
      const commonPx = -m.pitch * PX_PER_DEG_PITCH + m.heave * PX_PER_M_HEAVE;

      ctx!.clearRect(0, 0, W, H);
      ctx!.fillStyle = color;
      ctx!.strokeStyle = color;
      const calFlash = clamp(1 - (performance.now() - lastCalibration()) / 900, 0, 1);
      const alpha = ALPHA_REST + (ALPHA_MAX - ALPHA_REST) * energy;
      const r = DOT_R + DOT_R_GAIN * energy;
      let sp = 0, count = 0;

      for (const tr of tracks) {
        const n = tr.dots.length;
        const along = tr.kind === 'col' ? H : W;
        const span = along * 0.86;             // kolumna zajmuje środkowe 86% krawędzi
        const start = (along - span) / 2;
        const gap = span / n;
        for (let i = 0; i < n; i++) {
          const d = tr.dots[i];
          // cel w CSS px: y = wzdłuż krawędzi, x = w poprzek (zostaje w pasie 24 px)
          let tAlong: number, tCross: number;
          if (tr.kind === 'col') {
            tAlong = -tr.side * rollPx + commonPx;
            // drobne "oddychanie" w poprzek z nurzaniem, żeby kolumna nie była sztywna
            tCross = clamp(-m.heaveAcc * 2, -CROSS_MAX, CROSS_MAX);
          } else {
            // rzędy: obrót świata przeciwnie do przechyłu = górny w lewo, dolny w prawo
            tAlong = tr.side * rollPx * 0.6;
            tCross = clamp(commonPx * 0.15, -CROSS_MAX, CROSS_MAX);
          }
          tAlong = clamp(tAlong * amp, -MAX_OFFSET, MAX_OFFSET);
          tCross *= amp;
          [d.y, d.vy] = spring(d.y, d.vy, tAlong, d.resp * slow, dt);
          [d.x, d.vx] = spring(d.x, d.vx, tCross, d.resp * slow, dt);
          sp += Math.abs(d.vy) + Math.abs(d.vx);
          count++;

          // pozycja wzdłuż krawędzi z zawijaniem, wygaszanie przy końcach ukrywa zawinięcie
          const p = wrap(i * gap + gap / 2 + d.y, span);
          const fade = clamp(Math.min(p, span - p) / (gap * 1.2), 0, 1);
          const a = alpha * fade;
          if (a < 0.01) continue;
          const pos = start + p;
          const off = DOT_X + d.x;
          const cx = tr.kind === 'col' ? (tr.side < 0 ? off : W - off) : pos;
          const cy = tr.kind === 'col' ? pos : (tr.side < 0 ? off : H - off);
          ctx!.globalAlpha = a;
          ctx!.beginPath();
          ctx!.arc(cx, cy, r, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      speed = count ? sp / count : 0;

      // sztuczny horyzont: kreski na lewej i prawej krawędzi, obrócone o -roll (świat stoi),
      // przesunięte razem z pochyleniem / nurzaniem; kąt wierny (5 st. = 5 st.)
      [horizon.y, horizon.vy] = spring(horizon.y, horizon.vy, clamp(commonPx * amp, -MAX_OFFSET, MAX_OFFSET), 0.5 * slow, dt);
      [horizon.a, horizon.va] = spring(horizon.a, horizon.va, -m.roll * amp * Math.PI / 180, 0.5 * slow, dt);
      const tickAlpha = Math.min(0.8, alpha + 0.2 + 0.35 * calFlash);
      const hy = H / 2 + horizon.y;
      const ca = Math.cos(horizon.a), sa = Math.sin(horizon.a);
      const rollSprPx = -horizon.a * (180 / Math.PI) * PX_PER_DEG_ROLL; // ten sam przechył co kąt kreski
      const half = TICK_LEN / 2;
      ctx!.globalAlpha = tickAlpha;
      ctx!.lineWidth = 2;
      ctx!.lineCap = 'round';
      ctx!.beginPath();
      for (const side of [-1, 1] as const) {
        const cx = side < 0 ? BAND / 2 : W - BAND / 2;
        // pionowe przesunięcie końca kreski = jak na linii przez środek ekranu, ale ograniczone pasem
        const cy = hy - clamp(side * rollSprPx, -MAX_OFFSET, MAX_OFFSET);
        ctx!.moveTo(cx - ca * half, cy - sa * half);
        ctx!.lineTo(cx + ca * half, cy + sa * half);
      }
      ctx!.stroke();
      ctx!.globalAlpha = 1;
    }

    function run() {
      if (!raf && !document.hidden) { last = 0; lastDraw = 0; raf = requestAnimationFrame(frame); }
    }
    function pause() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    const onVis = () => (document.hidden ? pause() : run());
    const onReduced = () => { reduced = rmq.matches; };
    const refreshColor = () => { color = readColor(); };
    // ukryty skrót "Skalibruj": Alt+Shift+K (tylko wycentrowanie, nic nie wyłącza)
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyK') recalibrate();
    };
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const mo = new MutationObserver(refreshColor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    addEventListener('orientationchange', layout);
    addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    rmq.addEventListener('change', onReduced);
    dark.addEventListener('change', refreshColor);

    layout();
    run();

    return () => {
      pause();
      stopSensors();
      ro.disconnect();
      mo.disconnect();
      removeEventListener('orientationchange', layout);
      removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      rmq.removeEventListener('change', onReduced);
      dark.removeEventListener('change', refreshColor);
    };
  }, []);

  // komunikat dla czytnika ekranu: tylko zmiana poziomu, najwyżej raz na minutę; pierwszy odczyt bez komunikatu
  useEffect(() => {
    let current: SeaLevel | null = null;
    let lastAt = -Infinity;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      const lvl = getSeaState().level;
      const t = performance.now();
      if (current === null) { current = lvl; lastAt = t; return; }
      if (lvl !== current && t - lastAt >= ANNOUNCE_MIN_MS) {
        current = lvl; lastAt = t; setAnnounced(lvl);
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <div ref={wrapRef} aria-hidden="true" className="ju-motion-cues"
           style={{
             position: 'fixed',
             top: 'env(safe-area-inset-top, 0px)',
             right: 'env(safe-area-inset-right, 0px)',
             bottom: 'env(safe-area-inset-bottom, 0px)',
             left: 'env(safe-area-inset-left, 0px)',
             zIndex: 40,
             pointerEvents: 'none',
             contain: 'strict',
             overflow: 'hidden',
           }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} />
      </div>
      <p className="sr-only">{ALWAYS_ON[lang] ?? ALWAYS_ON.pl}</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announced ? (LEVEL_TEXT[lang] ?? LEVEL_TEXT.pl)[announced] : ''}
      </p>
    </>
  );
}
