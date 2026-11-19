// Call tones generated with Web Audio (no sound files): incoming = two-tone ring every 1.6 s (+ vibration on phones),
// outgoing = quiet 425 Hz ringback (1 s on, 3 s off, the European pattern).
// Browsers start an AudioContext only after a user gesture, so unlockAudio() is called on the first tap / key press.
type Tone = 'incoming' | 'outgoing';

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

export function unlockAudio() {
  const ac = context();
  if (ac && ac.state === 'suspended') void ac.resume().catch(() => {});
}

function beep(ac: AudioContext, freq: number, at: number, dur: number, gain: number) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // short attack / release so the tone does not click
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.015);
  g.gain.setValueAtTime(gain, at + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function play(kind: Tone) {
  const ac = context();
  if (ac && ac.state === 'running') {
    const t = ac.currentTime + 0.02;
    if (kind === 'incoming') {
      beep(ac, 880, t, 0.16, 0.18);
      beep(ac, 660, t + 0.2, 0.16, 0.18);
      beep(ac, 880, t + 0.4, 0.16, 0.18);
    } else {
      beep(ac, 425, t, 1.0, 0.05);
    }
  }
  // vibration is only allowed after the user has interacted with the page
  const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
  if (kind === 'incoming' && active) navigator.vibrate?.([200, 120, 200]);
}

export function startTone(kind: Tone) {
  stopTone();
  unlockAudio();
  play(kind);
  timer = setInterval(() => play(kind), kind === 'incoming' ? 1600 : 4000);
}

export function stopTone() {
  if (timer) clearInterval(timer);
  timer = null;
}
