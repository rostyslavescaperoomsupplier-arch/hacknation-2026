// System anty-rzyg (wskazówki ruchu pojazdu, idea jak "Vehicle Motion Cues" w iOS 18).
//
// Choroba morska bierze się z konfliktu: błędnik czuje kołysanie promu, a oczy patrzą na nieruchomy ekran.
// Wzdłuż lewej i prawej krawędzi ekranu (na tabletach poziomo także u góry i u dołu) rysujemy małe,
// półprzezroczyste kropki, które poruszają się razem z ruchem statku: przechył przesuwa kolumny jak
// linię horyzontu, przyspieszenie przesuwa je w przeciwną stronę jak bezwładną ciecz. Oczy widzą ruch,
// który czuje ucho wewnętrzne, i konflikt słabnie.
//
// Zasady:
// - zawsze włączone, bez żadnego wyłącznika (ani ustawienia, ani localStorage); zmienia się tylko
//   intensywność: w spoczynku kropki gasną do ~0.15 krycia, nigdy do zera;
// - nakładka nie przechwytuje dotyku ani przewijania (pointer-events: none), jest aria-hidden,
//   mieści się w bezpiecznym obszarze (env(safe-area-inset-*)) i nie zmienia układu strony;
// - z-index 40: nad treścią i nagłówkiem (30), pod alarmami i oknami modalnymi (50+);
// - prefers-reduced-motion: dalej działa (to pomoc dostępności), ale mniejsza amplituda i łagodniejsze sprężyny;
// - pauza, gdy karta jest ukryta (document.hidden).
// Źródło ruchu: czujniki urządzenia, ruch statku z serwera (setShipMotion) albo symulowane morze (sensors.ts).
import { useEffect, useRef } from 'react';
import type { Lang } from '../types';
import { readMotion, startMotion } from './sensors';

export { setShipMotion } from './sensors';

const INSET = 11;          // CSS px od krawędzi
const DOT = 7;             // średnica kropki, CSS px
const ALPHA_REST = 0.15;
const ALPHA_MAX = 0.38;
const PX_PER_DEG_ROLL = 7;
const PX_PER_DEG_PITCH = 9;
const PX_PER_MS2 = 12;     // przesunięcie na 1 m/s2 przyspieszenia
const MAX_OFFSET = 60;

interface Dot { x: number; y: number; vx: number; vy: number; resp: number }
interface Track { kind: 'col' | 'row'; side: -1 | 1; dots: Dot[] }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (v: number, m: number) => ((v % m) + m) % m;

function readInk(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--c-ink').trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = raw.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return [18, 48, 63];
}

function makeTrack(kind: Track['kind'], side: Track['side'], n: number): Track {
  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    // różne czasy odpowiedzi sprężyn = lekkie opóźnienie fazy, kropki "płyną" falą
    const resp = 0.42 + 0.22 * Math.abs(Math.sin(i * 1.7 + (side > 0 ? 0.9 : 0) + (kind === 'row' ? 2.1 : 0)));
    dots.push({ x: 0, y: 0, vx: 0, vy: 0, resp });
  }
  return { kind, side, dots };
}

export default function MotionCues({ lang = 'pl' }: { lang?: Lang } = {}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrapRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const stopSensors = startMotion();
    let W = 0, H = 0, dpr = 1;
    let tracks: Track[] = [];
    let ink = readInk();
    const rmq = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = rmq.matches;
    let raf = 0;
    let last = 0;
    let level = 0; // wygładzona intensywność ruchu 0..1

    function layout() {
      const r = host!.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const nCol = clamp(Math.round(H / 80), 8, 10);
      tracks = [makeTrack('col', -1, nCol), makeTrack('col', 1, nCol)];
      // poziomy tablet: dodatkowo rzędy u góry i u dołu
      if (W > H && Math.min(W, H) >= 600) {
        const nRow = clamp(Math.round(W / 110), 8, 12);
        tracks.push(makeTrack('row', -1, nRow), makeTrack('row', 1, nRow));
      }
    }

    function frame(ts: number) {
      raf = requestAnimationFrame(frame);
      const dt = last ? clamp((ts - last) / 1000, 0.001, 0.05) : 0.016;
      last = ts;
      const m = readMotion();
      const amp = reduced ? 0.5 : 1;
      const slow = reduced ? 1.6 : 1;

      const ax = clamp(m.ax, -4, 4), ay = clamp(m.ay, -4, 4);
      let speed = 0, count = 0;

      ctx!.clearRect(0, 0, W, H);
      const [r, g, b] = ink;

      for (const tr of tracks) {
        const n = tr.dots.length;
        const along = tr.kind === 'col' ? H : W;
        const span = along * 0.86;             // kolumna zajmuje środkowe 86% krawędzi
        const start = (along - span) / 2;
        const gap = span / n;
        for (let i = 0; i < n; i++) {
          const d = tr.dots[i];
          // cel w CSS px: tx = poprzecznie do krawędzi, ty = wzdłuż krawędzi
          let tAlong: number, tCross: number;
          if (tr.kind === 'col') {
            // przechył: kolumny jak horyzont (prawa w dół przy roll+), pochylenie: obie razem;
            // przyspieszenie: w przeciwną stronę (bezwładność)
            tAlong = tr.side * m.roll * PX_PER_DEG_ROLL + m.pitch * PX_PER_DEG_PITCH + ay * PX_PER_MS2;
            tCross = clamp(-ax * PX_PER_MS2 * 0.4, -5, 5);
          } else {
            const u = (i + 0.5) / n * 2 - 1; // -1..1 wzdłuż rzędu
            tAlong = -ax * PX_PER_MS2;
            tCross = clamp(u * m.roll * PX_PER_DEG_ROLL * 0.6 + m.pitch * PX_PER_DEG_PITCH * 0.5 + ay * PX_PER_MS2 * 0.4, -18, 18);
          }
          tAlong = clamp(tAlong * amp, -MAX_OFFSET, MAX_OFFSET);
          tCross *= amp;

          // sprężyna krytycznie tłumiona (bez przerzutu), osobno dla każdej osi
          const w = (2 * Math.PI) / (d.resp * slow);
          d.vy += (w * w * (tAlong - d.y) - 2 * w * d.vy) * dt;
          d.vx += (w * w * (tCross - d.x) - 2 * w * d.vx) * dt;
          d.y += d.vy * dt;
          d.x += d.vx * dt;
          speed += Math.abs(d.vy) + Math.abs(d.vx);
          count++;

          // pozycja wzdłuż krawędzi z zawijaniem, wygaszanie przy końcach ukrywa zawinięcie
          const p = wrap(i * gap + gap / 2 + d.y, span);
          const edge = Math.min(p, span - p) / (gap * 1.2);
          const fade = clamp(edge, 0, 1);
          const pos = start + p;
          let cx: number, cy: number;
          if (tr.kind === 'col') {
            cx = tr.side < 0 ? INSET + DOT / 2 + d.x : W - INSET - DOT / 2 + d.x;
            cy = pos;
          } else {
            cx = pos;
            cy = tr.side < 0 ? INSET + DOT / 2 + d.x : H - INSET - DOT / 2 + d.x;
          }
          const alpha = (ALPHA_REST + (ALPHA_MAX - ALPHA_REST) * level) * fade;
          if (alpha < 0.01) continue;
          ctx!.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(cx, cy, DOT / 2, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      // intensywność: prędkość kropek + wielkość przechyłu + przyspieszenia; szybko w górę, wolno w dół
      const mag = clamp((count ? speed / count : 0) / 30 + Math.hypot(m.roll, m.pitch) / 10 + Math.hypot(ax, ay, m.heave) / 3, 0, 1);
      level += (mag - level) * (1 - Math.exp(-dt / (mag > level ? 0.4 : 2.5)));
    }

    function run() {
      if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); }
    }
    function pause() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    const onVis = () => (document.hidden ? pause() : run());
    const onReduced = () => { reduced = rmq.matches; };
    const refreshInk = () => { ink = readInk(); };
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const mo = new MutationObserver(refreshInk);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    addEventListener('orientationchange', layout);
    document.addEventListener('visibilitychange', onVis);
    rmq.addEventListener('change', onReduced);
    dark.addEventListener('change', refreshInk);

    layout();
    run();

    return () => {
      pause();
      stopSensors();
      ro.disconnect();
      mo.disconnect();
      removeEventListener('orientationchange', layout);
      document.removeEventListener('visibilitychange', onVis);
      rmq.removeEventListener('change', onReduced);
      dark.removeEventListener('change', refreshInk);
    };
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
      <p className="sr-only">
        {lang === 'pl' ? 'System przeciw chorobie morskiej jest zawsze włączony.' : 'The anti seasickness motion cues are always on.'}
      </p>
    </>
  );
}
