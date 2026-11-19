// Mewka's voice, synthesised with Web Audio (no files, no services). Works on AudioContext and OfflineAudioContext.
//
// One character, one instrument: every sound is built from the same "syrinx" note:
//   saw + triangle source (a gull is buzzy, not a whistle) → a fast amplitude flutter (the rasp of a gull)
//   → high-pass 450 Hz → two formant band-passes (the beak tube) + a little dry → envelope.
// A short noise tick in front gives the hard "k" of "kyow" / "kek". The Voice object (base pitch, formants, rasp,
// brightness) is shared by all sounds, so the call, chirp, coo and trill sound like the same bird.
//
// Model (cute, shortened): the herring gull long call = a rising squeal, then a run of falling "kow" notes, head
// thrown back. Real calls are ~1-2 kHz with strong harmonics; Mewka sits at ~1.05 kHz, softer and rounder.

export type GullSound = 'call' | 'greet' | 'chirp' | 'happy' | 'coo' | 'murmur' | 'trill' | 'click' | 'unsure';

export interface Voice {
  /** fundamental, Hz */
  base: number;
  /** formant centres, Hz */
  f1: number;
  f2: number;
  /** 0..1 amplitude flutter depth (harshness) */
  rasp: number;
  /** flutter rate, Hz */
  raspHz: number;
  /** 0..1 saw share in the source (brightness) */
  bright: number;
}

export const MEWKA: Voice = { base: 1050, f1: 1750, f2: 3150, rasp: 0.32, raspHz: 74, bright: 0.42 };

/** sound lengths in seconds (for the bus / talking sync) */
export const LENGTH: Record<GullSound, number> = {
  call: 1.08, greet: 0.36, chirp: 0.16, happy: 0.32, coo: 0.5, murmur: 0.86, trill: 0.56, click: 0.04, unsure: 0.22,
};

interface NoteOpts {
  /** pitch contour: [fraction of dur, multiplier of base] */
  curve: [number, number][];
  gain: number;
  /** "k" onset strength 0..1 */
  k?: number;
  rasp?: number;
  raspHz?: number;
  bright?: number;
  /** vibrato depth (fraction) */
  vib?: number;
  /** extra low-pass, Hz (darker) */
  lp?: number;
  /** formant shift (multiplier) */
  fs?: number;
  attack?: number;
}

let noiseBuf: AudioBuffer | null = null;
let noiseFor: BaseAudioContext | null = null;
function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuf && noiseFor === ctx) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.4);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
  noiseBuf = b; noiseFor = ctx;
  return b;
}

function note(ctx: BaseAudioContext, out: AudioNode, v: Voice, t: number, dur: number, o: NoteOpts, pitch = 1) {
  const f0 = v.base * pitch;
  const end = t + dur;
  // source
  const saw = ctx.createOscillator(), tri = ctx.createOscillator();
  saw.type = 'sawtooth'; tri.type = 'triangle';
  const bright = o.bright ?? v.bright;
  const gSaw = ctx.createGain(), gTri = ctx.createGain();
  gSaw.gain.value = bright * 0.55; gTri.gain.value = (1 - bright) * 1.0;
  for (const osc of [saw, tri]) {
    const f = osc.frequency;
    f.setValueAtTime(f0 * o.curve[0][1], t);
    for (let i = 1; i < o.curve.length; i++) {
      const [x, m] = o.curve[i];
      f.exponentialRampToValueAtTime(Math.max(40, f0 * m), t + dur * x);
    }
  }
  tri.detune.value = 6; // a hair of chorus: two membranes
  if (o.vib) {
    const lfo = ctx.createOscillator(), d = ctx.createGain();
    lfo.frequency.value = 9; d.gain.value = f0 * o.vib;
    lfo.connect(d); d.connect(saw.frequency); d.connect(tri.frequency);
    lfo.start(t); lfo.stop(end + 0.05);
  }
  saw.connect(gSaw); tri.connect(gTri);
  // rasp: amplitude flutter
  const am = ctx.createGain();
  const rasp = o.rasp ?? v.rasp;
  am.gain.value = 1 - rasp / 2;
  if (rasp > 0) {
    const fl = ctx.createOscillator(), depth = ctx.createGain();
    fl.type = 'triangle'; fl.frequency.value = o.raspHz ?? v.raspHz; depth.gain.value = rasp / 2;
    fl.connect(depth); depth.connect(am.gain);
    fl.start(t); fl.stop(end + 0.05);
  }
  gSaw.connect(am); gTri.connect(am);
  // beak tube
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450; hp.Q.value = 0.7;
  am.connect(hp);
  const fs = o.fs ?? 1;
  const b1 = ctx.createBiquadFilter(); b1.type = 'bandpass'; b1.frequency.value = v.f1 * fs; b1.Q.value = 3.2;
  const b2 = ctx.createBiquadFilter(); b2.type = 'bandpass'; b2.frequency.value = v.f2 * fs; b2.Q.value = 5;
  const g1 = ctx.createGain(), g2 = ctx.createGain(), gd = ctx.createGain();
  g1.gain.value = 1.6; g2.gain.value = 0.7; gd.gain.value = 0.35;
  const env = ctx.createGain();
  hp.connect(b1).connect(g1).connect(env);
  hp.connect(b2).connect(g2).connect(env);
  hp.connect(gd).connect(env);
  let tail: AudioNode = env;
  if (o.lp) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; env.connect(lp); tail = lp; }
  tail.connect(out);
  // envelope: quick attack, a little swell, exponential fall (no clicks)
  const a = o.attack ?? 0.012, g = env.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(o.gain, t + a);
  g.setValueAtTime(o.gain, t + Math.max(a, dur * 0.55));
  g.exponentialRampToValueAtTime(0.0001, end);
  saw.start(t); tri.start(t); saw.stop(end + 0.02); tri.stop(end + 0.02);
  // the "k": a tiny filtered noise tick
  if (o.k) tick(ctx, out, t - 0.006, o.k * o.gain, 3400 * fs, 0.014);
}

function tick(ctx: BaseAudioContext, out: AudioNode, t: number, gain: number, freq: number, dur: number) {
  t = Math.max(0, t);
  const n = ctx.createBufferSource(); n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(bp).connect(g).connect(out);
  n.start(t, Math.random() * 0.3); n.stop(t + dur + 0.01);
}

const KOW: [number, number][] = [[0, 0.86], [0.28, 1.22], [1, 0.9]];

/**
 * Schedule one sound at context time t0 into `out`. `pitch` shifts the whole voice (±3 % per play keeps it alive).
 * Returns the length in seconds.
 */
export function playGull(ctx: BaseAudioContext, out: AudioNode, kind: GullSound, t0: number, v: Voice = MEWKA, pitch = 1): number {
  const n = (dt: number, dur: number, o: NoteOpts, p = 1) => note(ctx, out, v, t0 + dt, dur, o, pitch * p);
  switch (kind) {
    case 'call': {
      // long call, shortened: squeal rising with a wobble, then four falling "kow"s that soften (the laugh)
      n(0, 0.34, { curve: [[0, 0.72], [0.55, 1.42], [1, 1.28]], gain: 0.5, k: 0.4, vib: 0.025, attack: 0.03 });
      [1.2, 1.12, 1.04, 0.96].forEach((p, i) => n(0.42 + i * 0.165, 0.13, { curve: KOW, gain: 0.62 - i * 0.09, k: 0.8 }, p));
      break;
    }
    case 'greet': // "kyow-kek": the two beak opens of the greet call
      n(0, 0.17, { curve: [[0, 0.85], [0.3, 1.26], [1, 0.92]], gain: 0.55, k: 0.8 });
      n(0.2, 0.1, { curve: [[0, 1.0], [0.3, 1.2], [1, 0.96]], gain: 0.45, k: 0.9 });
      break;
    case 'chirp': // a curious little "kyip"
      n(0, 0.12, { curve: [[0, 0.95], [0.4, 1.38], [1, 1.22]], gain: 0.4, k: 0.5, rasp: 0.18 }, 1.08);
      break;
    case 'happy': // "ha-ha": two bright keks
      n(0, 0.09, { curve: [[0, 1.05], [0.3, 1.26], [1, 1.0]], gain: 0.5, k: 0.9 });
      n(0.2, 0.1, { curve: [[0, 1.1], [0.3, 1.3], [1, 1.02]], gain: 0.42, k: 0.9 });
      break;
    case 'unsure': // "kyu?": dips, then lifts at the end like a question
      n(0, 0.2, { curve: [[0, 1.0], [0.45, 0.86], [1, 1.24]], gain: 0.62, k: 0.4, rasp: 0.2 });
      break;
    case 'coo': // contented purr: low, soft, slow flutter (the "mrrr" of a petted gull)
      n(0, 0.48, { curve: [[0, 0.5], [0.35, 0.56], [1, 0.47]], gain: 0.42, rasp: 0.55, raspHz: 23, bright: 0.15, lp: 2600, fs: 0.75, attack: 0.05 });
      break;
    case 'murmur': // sleepy: two soft sinking "mrr"s and a breath
      n(0, 0.34, { curve: [[0, 0.5], [0.4, 0.53], [1, 0.42]], gain: 0.28, rasp: 0.5, raspHz: 18, bright: 0.08, lp: 1800, fs: 0.7, attack: 0.06 });
      n(0.42, 0.42, { curve: [[0, 0.45], [0.3, 0.47], [1, 0.36]], gain: 0.2, rasp: 0.5, raspHz: 15, bright: 0.05, lp: 1500, fs: 0.65, attack: 0.08 });
      break;
    case 'trill': // reward: a quick rising run of chirps, then a happy kek
      [1.0, 1.12, 1.26, 1.41].forEach((p, i) => n(i * 0.075, 0.06, { curve: [[0, 0.96], [0.5, 1.08], [1, 1.02]], gain: 0.34 + i * 0.03, k: 0.4, rasp: 0.15 }, p));
      n(0.36, 0.2, { curve: [[0, 1.3], [0.3, 1.62], [1, 1.4]], gain: 0.48, k: 0.8 });
      break;
    case 'click': // beak clap: a short dry tick with a hint of tone
      tick(ctx, out, t0, 1.4, 2300, 0.02);
      tick(ctx, out, t0 + 0.004, 0.6, 5200, 0.012);
      break;
  }
  return LENGTH[kind];
}
