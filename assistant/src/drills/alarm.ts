// Web Audio synth for the drill alarm patterns (training demo, modest volume).
// whistle = low, rich horn-like tone; bell = electric alarm bell (clapper ~16 Hz); chime = PA attention gong.
// Must be started from a user gesture (click): the AudioContext is created / resumed inside playAlarm().
import type { AlarmPattern, AlarmStep } from './data';

const VOLUME = 0.16;
let ctx: AudioContext | null = null;
let current: { bus: GainNode; nodes: AudioScheduledSourceNode[]; timer: number } | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** total length of a pattern in ms */
export function patternDuration(p: AlarmPattern): number {
  return p.steps.reduce((ms, s, i) => ms + s.ms + (i < p.steps.length - 1 ? s.gap : 0), 0);
}

/** Short / long counts in human form, e.g. "7 × 1 s + 1 × 6 s". */
export function describePattern(p: AlarmPattern): string {
  const parts: string[] = [];
  let i = 0;
  while (i < p.steps.length) {
    const s = p.steps[i];
    let n = 1;
    while (i + n < p.steps.length && p.steps[i + n].ms === s.ms && p.steps[i + n].tone === s.tone) n++;
    parts.push(`${n} × ${Math.round(s.ms / 100) / 10} s`);
    i += n;
  }
  return parts.join(' + ');
}

function envelope(ac: AudioContext, out: AudioNode, t0: number, dur: number, peak: number, attack = 0.04, release = 0.12): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setValueAtTime(peak, Math.max(t0 + attack, t0 + dur - release));
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  g.connect(out);
  return g;
}

function whistle(ac: AudioContext, out: AudioNode, t0: number, dur: number, nodes: AudioScheduledSourceNode[]) {
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = envelope(ac, lp, t0, dur, 0.5, 0.08, 0.25);
  lp.connect(out);
  for (const [f, type, lvl] of [[165, 'sawtooth', 0.55], [247, 'sawtooth', 0.35], [330, 'square', 0.12]] as const) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lg = ac.createGain();
    lg.gain.value = lvl;
    o.connect(lg).connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    nodes.push(o);
  }
}

function bell(ac: AudioContext, out: AudioNode, t0: number, dur: number, nodes: AudioScheduledSourceNode[], level = 0.35) {
  const g = envelope(ac, out, t0, dur, level, 0.01, 0.08);
  // clapper: square LFO gating the gong partials
  const am = ac.createGain();
  am.gain.value = 0.5;
  const lfo = ac.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 16;
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(am.gain);
  am.connect(g);
  lfo.start(t0);
  lfo.stop(t0 + dur + 0.05);
  nodes.push(lfo);
  for (const [f, lvl] of [[1180, 0.5], [2950, 0.25], [4120, 0.12]] as const) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const lg = ac.createGain();
    lg.gain.value = lvl;
    o.connect(lg).connect(am);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    nodes.push(o);
  }
}

function chime(ac: AudioContext, out: AudioNode, t0: number, dur: number, nodes: AudioScheduledSourceNode[], high: boolean) {
  const o = ac.createOscillator();
  o.type = 'sine';
  o.frequency.value = high ? 784 : 622;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.6, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
  nodes.push(o);
}

/** Stop whatever is playing. Safe to call any time. */
export function stopAlarm() {
  if (!current || !ctx) { current = null; return; }
  const { bus, nodes, timer } = current;
  current = null;
  clearTimeout(timer);
  const now = ctx.currentTime;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setValueAtTime(bus.gain.value, now);
  bus.gain.linearRampToValueAtTime(0, now + 0.08);
  for (const n of nodes) { try { n.stop(now + 0.1); } catch { /* already stopped */ } }
  window.setTimeout(() => bus.disconnect(), 200);
}

/**
 * Play a pattern once. Call from a click handler. Returns false when Web Audio is unavailable.
 * `onEnd` fires when the pattern finishes on its own (not after stopAlarm()).
 */
export function playAlarm(p: AlarmPattern, onEnd?: () => void): boolean {
  const ac = audio();
  if (!ac) return false;
  stopAlarm();
  const bus = ac.createGain();
  bus.gain.value = VOLUME;
  bus.connect(ac.destination);
  const nodes: AudioScheduledSourceNode[] = [];
  const start = ac.currentTime + 0.05;
  let t = start;
  let chimeHigh = true;
  p.steps.forEach((s: AlarmStep, i) => {
    const dur = s.ms / 1000;
    if (s.tone === 'whistle') whistle(ac, bus, t, dur, nodes);
    else if (s.tone === 'bell') bell(ac, bus, t, dur, nodes);
    else { chime(ac, bus, t, dur, nodes, chimeHigh); chimeHigh = !chimeHigh; }
    t += dur + (i < p.steps.length - 1 ? s.gap / 1000 : 0);
  });
  if (p.bells) bell(ac, bus, start, t - start, nodes, 0.14);
  const total = patternDuration(p);
  const timer = window.setTimeout(() => {
    if (current?.bus === bus) { current = null; window.setTimeout(() => bus.disconnect(), 200); onEnd?.(); }
  }, total + 150);
  current = { bus, nodes, timer };
  return true;
}
