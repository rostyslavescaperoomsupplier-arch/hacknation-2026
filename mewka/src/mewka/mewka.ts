// Mewka engine: framework-agnostic, no dependencies.
// CSS (mewka.css) owns poses + ambient loops; this file only
//  - switches data-state and interrupts running gestures cleanly,
//  - plays one-shot WAAPI gestures (anticipation, wave, hop, talk, shrug),
//  - writes --look-x/--look-y for pointer tracking (rAF only while settling),
//  - pauses everything when the tab is hidden or the bird is off-screen.
import './mewka.css';
import { attach3d, is3d } from './mewka3d-gate';
import type { Outfit } from './outfit';

export type MewkaState =
  | 'hidden' | 'peek' | 'idle' | 'listen-invite' | 'listening' | 'thinking'
  | 'talking' | 'pointing' | 'unsure' | 'happy' | 'greet';

export interface MewkaApi {
  setState(state: MewkaState): void;
  /** desktop eye/head tracking; ignored on touch, reduced motion, off-screen */
  lookAtPointer(enable: boolean): void;
  /** aim the wing at an element (switches to 'pointing'); null = back to 'idle' */
  pointAt(target: Element | null): void;
  /** dress the 3D bird in Gniazdo Mewki items ({ head: 'top-hat', neck: 'bowtie-gold', … }).
   *  Unknown ids are ignored, null / {} = no accessories. The SVG fallback shows no accessories
   *  (hosts draw their own 2D fallback when root[data-mw3d="off"]). */
  setOutfit(outfit: Outfit | null): void;
  destroy(): void;
  readonly state: MewkaState;
}

const IO = 'cubic-bezier(0.77, 0, 0.175, 1)';
const OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EAR = 'rotate(84deg) scale(.62)';
const SHOULDER = [26.38, 29.25]; // wing-l pivot, viewBox units (mewka.css)
const REST_DEG = 178; // direction of the folded wing (shoulder -> tip)
const instances = new WeakMap<Element, MewkaApi>();

const reduced = () =>
  document.documentElement.dataset.motion === 'reduce' ||
  matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createMewka(root: HTMLElement): MewkaApi {
  const existing = instances.get(root);
  if (existing) return existing;

  const $ = (id: string) => root.querySelector<SVGGraphicsElement>('#mw-' + id)!;
  const svg = root.querySelector('svg')!;
  const all = root.querySelector<SVGGElement>('#mw')!;
  const body = $('body'), head = $('head'), wingL = $('wing-l'), wingR = $('wing-r'), jaw = $('beak-bottom');
  let state = (root.dataset.state as MewkaState) || 'hidden';
  let running: Animation[] = [];
  let visible = true;
  // 3D bird (progressive enhancement): gets the same state/look/point calls; SVG stays as fallback
  const three = attach3d(root, () => state);

  // ---------- gestures ----------
  type El = SVGGraphicsElement;
  const play = (el: Element, frames: Keyframe[], o: KeyframeAnimationOptions) => {
    const a = el.animate(frames, { easing: IO, ...o });
    running.push(a);
    a.finished.then(() => { running = running.filter((x) => x !== a); }, () => {});
    return a;
  };
  // additive offset on top of whatever the element shows; ends at 0, so no snap
  const add = (el: Element, frames: Keyframe[], duration: number, o: KeyframeAnimationOptions = {}) =>
    play(el, frames, { duration, composite: 'add', ...o });
  // gesture that carries the element into its new CSS pose itself (anticipation,
  // overshoot): the CSS transition is switched off meanwhile, the last frame
  // equals the CSS pose, so nothing snaps when it ends.
  const own = (el: El, frames: (string | [string, number])[], duration: number) => {
    el.style.transition = 'none';
    const a = play(el, frames.map((f) => (typeof f === 'string' ? { transform: f } : { transform: f[0], offset: f[1] })), { duration });
    a.finished.then(() => el.style.removeProperty('transition'), () => {});
  };
  const now = (el: El) => { const t = getComputedStyle(el).transform; return t === 'none' ? 'rotate(0deg) scale(1)' : t; };

  function interrupt() {
    const els = new Set<El>();
    for (const a of running) {
      const t = (a.effect as KeyframeEffect | null)?.target as El | null;
      try { a.commitStyles(); if (t) els.add(t); } catch {}
      a.cancel();
      t?.style.removeProperty('transition');
    }
    running = [];
    return els;
  }

  function gesture(s: MewkaState, w: string, h: string, r: string) {
    switch (s) {
      case 'listening': // dip (anticipation) -> up to the ear with a little overshoot -> hold
        own(wingL, [w, ['rotate(-10deg) scale(1)', .2], ['rotate(92deg) scale(.6)', .78], EAR], 600);
        own(head, [h, ['rotate(-2deg)', .25], ['rotate(9deg)', .8], 'rotate(7deg)'], 680);
        break;
      case 'listen-invite': // one-off "I'm listening": to the ear, hold, back
        own(wingL, [w, ['rotate(-10deg) scale(1)', .12], [EAR, .34], [EAR, .72], 'rotate(0deg) scale(1)'], 1900);
        own(head, [h, ['rotate(7deg)', .36], ['rotate(7deg)', .72], 'rotate(0deg)'], 1900);
        break;
      case 'pointing': {
        const d = parseFloat(wingL.style.getPropertyValue('--mw-pt')) || 220;
        own(wingL, [w, ['rotate(-8deg) scale(1)', .18], [`rotate(${d + 8}deg) scale(.9)`, .8], `rotate(${d}deg) scale(.9)`], 640);
        break;
      }
      case 'unsure': // shrug: wings and body pop up together, settle into the pose
        own(wingL, [w, ['rotate(30deg) scale(1)', .5], 'rotate(22deg)'], 560);
        own(wingR, [r, ['rotate(22deg) scale(1)', .5], 'rotate(16deg)'], 560);
        own(head, [h, ['rotate(-11deg)', .5], 'rotate(-7deg)'], 640);
        add(body, [{ transform: 'none' }, { transform: 'translateY(-1.2px)', offset: .45 }, { transform: 'none' }], 560);
        break;
      case 'talking': // beak <= 1.08 s, then still
        add(jaw, [{ transform: 'none' }, { transform: 'rotate(16deg)' }, { transform: 'none' }], 180, { easing: 'ease-in-out', iterations: 6 });
        break;
      case 'greet': // wave once: wing up over the back, two flicks, down
        own(wingL, [w, ['rotate(-8deg)', .12], ['rotate(112deg)', .38], ['rotate(132deg)', .5], ['rotate(108deg)', .62], ['rotate(126deg)', .74], 'rotate(0deg)'], 1500);
        break;
      case 'happy': // hop: squash (anticipation) -> stretch up -> land squash -> rest
        play(all, [
          { transform: 'none' },
          { transform: 'scale(1.05, .93)', offset: .18, easing: OUT },
          { transform: 'translateY(-5px) scale(.97, 1.04)', offset: .48, easing: IO },
          { transform: 'scale(1.04, .95)', offset: .76, easing: OUT },
          { transform: 'none' },
        ], { duration: 600, easing: 'linear' });
        own(wingL, [w, ['rotate(30deg) scale(1)', .45], 'rotate(0deg) scale(1)'], 600);
        own(wingR, [r, ['rotate(24deg)', .45], 'rotate(0deg)'], 600);
        break;
    }
  }

  function go(next: MewkaState) {
    const committed = interrupt();
    const w = now(wingL), h = now(head), r = now(wingR); // where the rig really is
    state = next;
    root.dataset.state = next;
    if (next === 'hidden') setTarget(0, 0);
    else if (!reduced() && visible && !document.hidden && !is3d(root)) gesture(next, w, h, r);
    three?.setState(next);
    // for the gull voice (lib/audio/mewka-voice.ts): it syncs sounds to the gesture that starts now
    root.dispatchEvent(new CustomEvent('mewka:state', { bubbles: true, detail: { state: next, three: is3d(root) } }));
    // hand interrupted elements back to CSS: transitions start from the committed value
    committed.forEach((el) => getComputedStyle(el).transform);
    committed.forEach((el) => el.style.removeProperty('transform'));
  }

  // ---------- pointing ----------
  function pointAt(target: Element | null) {
    if (!target) { three?.point(null); if (state === 'pointing') go('idle'); return; }
    if (three) { // screen direction from the bird's chest to the target centre (y up)
      const b = root.getBoundingClientRect(), t = target.getBoundingClientRect();
      three.point(Math.atan2(b.top + b.height * 0.55 - (t.top + t.height / 2), t.left + t.width / 2 - (b.left + b.width * 0.55)));
    }
    const m = svg.getScreenCTM();
    let deg = 220; // default: forward, down-right (cards under the avatar)
    if (m) {
      const p = new DOMPoint(SHOULDER[0], SHOULDER[1]).matrixTransform(m);
      const r = target.getBoundingClientRect();
      const a = (Math.atan2(r.top + r.height / 2 - p.y, r.left + r.width / 2 - p.x) * 180) / Math.PI;
      deg = (((a - REST_DEG) % 360) + 360) % 360; // rotate clockwise over the back
      if (deg > 240) deg -= 360; // targets below: swing down instead of round the top
    }
    wingL.style.setProperty('--mw-pt', deg.toFixed(1) + 'deg');
    if (state !== 'pointing') go('pointing');
  }

  // ---------- pointer tracking: target -> lerp 0.18 -> stop when settled ----------
  let tracking = false, raf = 0, tx = 0, ty = 0, x = 0, y = 0, cx = 0, cy = 0, dirty = true;
  let lastE: PointerEvent | null = null;
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  function loop() {
    if (lastE) { // layout is read here (rAF), never inside pointermove
      if (dirty) { const r = root.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height * .3; dirty = false; }
      const dx = lastE.clientX - cx, dy = lastE.clientY - cy;
      // the whole window counts: the bird turns towards the mouse wherever it is, more when it is close
      const on = state !== 'hidden';
      const rx = Math.max(160, innerWidth * 0.32), ry = Math.max(140, innerHeight * 0.32);
      tx = on ? clamp(dx / rx) : 0; ty = on ? clamp(dy / ry) : 0;
      three?.look(tx, ty, on);
      lastE = null;
    }
    x += (tx - x) * .18; y += (ty - y) * .18;
    const settled = Math.abs(tx - x) + Math.abs(ty - y) < .004;
    if (settled) { x = tx; y = ty; }
    root.style.setProperty('--look-x', x.toFixed(3));
    root.style.setProperty('--look-y', y.toFixed(3));
    raf = settled ? 0 : requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  function setTarget(nx: number, ny: number) { tx = nx; ty = ny; lastE = null; three?.look(nx, ny, false); if (tx !== x || ty !== y) kick(); }
  function onMove(e: PointerEvent) { if (e.pointerType === 'mouse') { lastE = e; kick(); } }
  const invalidate = () => { dirty = true; };
  const canTrack = () => tracking && visible && fine.matches && !reduced() && !document.hidden;
  function syncListeners() {
    if (canTrack()) {
      addEventListener('pointermove', onMove, { passive: true });
      addEventListener('scroll', invalidate, { passive: true });
      addEventListener('resize', invalidate);
    } else {
      removeEventListener('pointermove', onMove);
      removeEventListener('scroll', invalidate);
      removeEventListener('resize', invalidate);
      if (x || y) setTarget(0, 0); // ease back to centre, then the loop stops itself
    }
  }
  function lookAtPointer(enable: boolean) { tracking = enable; dirty = true; syncListeners(); }

  // ---------- pausing ----------
  function syncPause() {
    const paused = !visible || document.hidden;
    if (paused) root.dataset.paused = ''; else delete root.dataset.paused;
    running.forEach((a) => (paused ? a.pause() : a.play()));
    syncListeners();
  }
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; dirty = true; syncPause(); });
  io.observe(root);
  document.addEventListener('visibilitychange', syncPause);

  function destroy() {
    interrupt();
    three?.destroy();
    tracking = false; syncListeners();
    if (raf) cancelAnimationFrame(raf);
    io.disconnect();
    document.removeEventListener('visibilitychange', syncPause);
    root.style.removeProperty('--look-x'); root.style.removeProperty('--look-y');
    instances.delete(root);
  }

  // public setState: 'pointing' without pointAt() aims at the default (down-right)
  const setState = (next: MewkaState) => {
    if (next === 'pointing') { wingL.style.removeProperty('--mw-pt'); three?.point(null); }
    go(next);
  };

  const setOutfit = (o: Outfit | null) => { three?.setOutfit(o ?? null); };
  const api: MewkaApi = { setState, lookAtPointer, pointAt, setOutfit, destroy, get state() { return state; } };
  instances.set(root, api);
  return api;
}
