// Progressive enhancement gate for the 3D bird (the only 3D code in the initial bundle, < 1 KB gzip).
// The SSR'd SVG stays the truth until the 3D chunk (three.js) has drawn its first frame.
// No 3D (and no WebGL context at all) when: reduced motion, fs-mascot=off, Save-Data, <= 2 cores,
// size sm, ?mewka3d=0, or WebGL fails. The chunk loads only once the bird is on screen and the browser is idle.
import type { MewkaState } from './mewka';
import type { Outfit } from './outfit';
import type { Bird3D } from './mewka3d';

const reduced = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

const QA = () => typeof location !== 'undefined' && /[?&]mwqa=1/.test(location.search); // lazy: this module is also evaluated in SSR
/** null = 3D allowed, else the reason it is not (logged with ?mwqa=1) */
function why(root: HTMLElement): string | null {
  if (root.classList.contains('mewka--sm') || root.dataset.render === 'svg') return 'size sm / render=svg';
  if (reduced()) return 'reduced motion';
  if (/[?&]mewka3d=0/.test(location.search)) return '?mewka3d=0';
  const n = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (n.connection?.saveData) return 'Save-Data';
  // only a real single-core device: Firefox privacy.resistFingerprinting (Tor, Mullvad, LibreWolf, older Firefox)
  // reports exactly 2 cores, which used to switch the 3D bird off for those visitors
  if ((n.hardwareConcurrency || 4) < 2) return 'single core';
  try { if (localStorage.getItem('fs-mascot') === 'off') return 'fs-mascot=off'; } catch {}
  if (!('IntersectionObserver' in window)) return 'no IntersectionObserver';
  return null;
}
const allowed = (root: HTMLElement) => why(root) === null;
const log = (...a: unknown[]) => { if (QA()) console.info('[mewka3d]', ...a); };

// Preload the 3D chunk once, on the first idle moment after load, so a bird that is (or comes) on screen mounts
// right away and the SVG phase stays short. Only when 3D is allowed at all.
type Mod = typeof import('./mewka3d');
let mod: Promise<Mod> | null = null;
const load = () => (mod ??= import('./mewka3d'));
let preloading = false;
function preload() {
  if (preloading) return;
  preloading = true;
  const go = () => { const ric = (window as any).requestIdleCallback || ((f: () => void) => setTimeout(f, 300)); ric(() => load().catch((e) => log('chunk failed', e)), { timeout: 1500 }); };
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
}

export interface Bird3DProxy extends Bird3D {}

const live = new Set<() => void>();
let watching = false;
function watchReduce() {
  if (watching) return;
  watching = true;
  const drop = () => { if (reduced()) live.forEach((f) => f()); };
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', drop);
  new MutationObserver(drop).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
}

/** Returns a proxy that buffers calls until the 3D bird exists (or forever, if 3D is not allowed). */
// root[data-mw3d]: "on" = the 3D bird is drawn, "off" = this bird stays SVG (not allowed, WebGL failed, or
// dropped for reduced motion). Unset = still deciding. Hosts can show 2D fallbacks (e.g. the nest outfit) on "off".
const off = (root: HTMLElement) => { root.dataset.mw3d = 'off'; };

export function attach3d(root: HTMLElement, getState: () => MewkaState): Bird3DProxy | null {
  const no = why(root);
  if (no) { log('svg:', no); off(root); return null; }
  watchReduce();
  preload();
  let bird: Bird3D | null = null, dead = false;
  let lx = 0, ly = 0, lon = false, pr: number | null = null, outfit: Outfit | null = null;
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    // on screen: mount as soon as the chunk is there (usually already preloaded)
    load().then((m) => {
      if (dead) return;
      if (!allowed(root)) { off(root); return; }
      bird = m.mount(root, getState());
      if (!bird) { log('svg: WebGL2 unavailable'); off(root); return; }
      bird.point(pr); bird.look(lx, ly, lon);
      if (outfit) bird.setOutfit(outfit);
    }, (e) => { log('svg: chunk failed', e); off(root); });
  });
  io.observe(root);
  const kill = () => { dead = true; io.disconnect(); bird?.destroy(); bird = null; live.delete(kill); off(root); };
  live.add(kill);
  return {
    setState: (s) => bird?.setState(s),
    look: (x, y, on) => { lx = x; ly = y; lon = on; bird?.look(x, y, on); },
    point: (r) => { pr = r; bird?.point(r); },
    setOutfit: (o) => { outfit = o; bird?.setOutfit(o); },
    destroy: () => { kill(); delete root.dataset.mw3d; },
  };
}

/** true while the 3D bird is drawn (the SVG is then only a hidden fallback) */
export const is3d = (root: HTMLElement) => root.dataset.mw3d === 'on';
