// Browser-native speech for the assistant. No external services, no audio leaves the page through our code:
//  - speech to text: Web Speech API (SpeechRecognition / webkitSpeechRecognition). NOTE: the browser vendor may
//    process the audio on its servers (Chrome → Google, Edge → Microsoft, Safari → Apple); the UI says so once.
//  - text to speech: speechSynthesis, one utterance per sentence (Chrome cuts long utterances at ~15 s, and per
//    sentence lets the mascot "talk" in step and lets the user skip a sentence).
// Framework-free; the React glue lives in useVoice.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = any; // SpeechRecognition is not in lib.dom for every TS target

function recCtor(): (new () => Rec) | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function sttSupported(): boolean {
  return !!recCtor();
}
export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof (window as any).SpeechSynthesisUtterance === 'function';
}

/** iOS / iPadOS: opening the mic switches the audio session to recording and silences speechSynthesis,
 *  so there we never listen while speaking (barge-in = press the mic or Escape). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// ---------------------------------------------------------------- voices

/** Higher = more natural. Edge "… Online (Natural)", Apple "Premium/Enhanced", Google network voices. */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|neural|premium|enhanced|wavenet|studio/.test(n)) s += 40;
  if (/^google/.test(n)) s += 20;
  if (/online/.test(n)) s += 10;
  if (/compact|espeak|eloquence/.test(n)) s -= 30;
  // Apple novelty voices
  if (/bells|bubbles|cellos|organ|whisper|zarvox|trinoids|bad news|good news|jester|superstar|wobble|boing|bahh|albert|fred|junior|ralph|kathy/.test(n)) s -= 60;
  if (v.default) s += 2;
  return s;
}

const norm = (l: string) => l.toLowerCase().replace('_', '-');

/** Best voice for a BCP-47 locale ("pl-PL"); exact region first, then same language. null = none installed. */
export function pickVoice(locale: string): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null;
  const vs = speechSynthesis.getVoices();
  const want = norm(locale), base = want.split('-')[0];
  const exact = vs.filter((v) => norm(v.lang) === want);
  const same = exact.length ? exact : vs.filter((v) => norm(v.lang).split('-')[0] === base);
  return same.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Voices load asynchronously in Chrome; resolve when there are some (or after `ms`). */
export function voicesReady(ms = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((res) => {
    const done = () => { clearTimeout(t); speechSynthesis.removeEventListener?.('voiceschanged', done); res(speechSynthesis.getVoices()); };
    const t = setTimeout(done, ms);
    speechSynthesis.addEventListener?.('voiceschanged', done);
  });
}

// ---------------------------------------------------------------- speech to text

export type SttError = 'no-speech' | 'not-allowed' | 'audio-capture' | 'network' | 'language' | 'aborted' | 'other';

export interface ListenHandlers {
  onStart?(): void;
  /** live transcript (final part + current guess) */
  onInterim?(text: string): void;
  onFinal?(text: string): void;
  onError?(e: SttError): void;
  /** always called last, once */
  onEnd?(): void;
}
export interface Listening { stop(): void; abort(): void }

/** One utterance of listening (continuous = false: the browser ends it after the user stops talking). */
export function listen(locale: string, h: ListenHandlers, silenceMs = 9000): Listening | null {
  const R = recCtor();
  if (!R) return null;
  const r: Rec = new R();
  r.lang = locale;
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let ended = false, gotFinal = false, heard = false;
  // our own silence guard (Safari and some Android builds never fire "no-speech")
  let silence = window.setTimeout(() => { if (!heard) { h.onError?.('no-speech'); try { r.abort(); } catch { finish(); } } }, silenceMs);
  const finish = () => { if (ended) return; ended = true; clearTimeout(silence); h.onEnd?.(); };

  r.onstart = () => h.onStart?.();
  r.onresult = (e: any) => {
    let fin = '', int = '';
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) fin += res[0].transcript; else int += res[0].transcript;
    }
    const text = (fin + int).replace(/\s+/g, ' ').trim();
    if (text) heard = true;
    const last = e.results[e.results.length - 1];
    if (last?.isFinal && fin.trim()) { gotFinal = true; h.onFinal?.(fin.replace(/\s+/g, ' ').trim()); }
    else if (text) h.onInterim?.(text);
  };
  r.onerror = (e: any) => {
    const map: Record<string, SttError> = {
      'no-speech': 'no-speech', 'not-allowed': 'not-allowed', 'service-not-allowed': 'not-allowed',
      'audio-capture': 'audio-capture', network: 'network', 'language-not-supported': 'language', aborted: 'aborted',
    };
    h.onError?.(map[e.error] ?? 'other');
  };
  r.onend = () => {
    // some engines end with only an interim result and no final one: treat what we have as no-speech
    if (!gotFinal && !heard) { /* onerror usually reported it already */ }
    finish();
  };
  try {
    r.start();
  } catch {
    clearTimeout(silence);
    h.onError?.('other');
    queueMicrotask(finish);
    return { stop() {}, abort() {} };
  }
  return {
    stop() { try { r.stop(); } catch { finish(); } },
    abort() { try { r.abort(); } catch { /* ignore */ } finish(); },
  };
}

// ---------------------------------------------------------------- text to speech

export interface Seg { text: string; locale?: string }

/** Split into sentences (Intl.Segmenter when available), keeping each segment's locale. */
export function sentences(segs: Seg[], locale: string): Seg[] {
  const Seg = (Intl as any).Segmenter;
  const out: Seg[] = [];
  for (const s of segs) {
    const loc = s.locale ?? locale;
    const parts: string[] = Seg
      ? Array.from(new Seg(loc, { granularity: 'sentence' }).segment(s.text) as Iterable<{ segment: string }>, (x) => x.segment)
      : s.text.split(/(?<=[.!?…])\s+/);
    for (const p of parts) {
      const t = p.trim();
      if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ text: t, locale: s.locale });
    }
  }
  return out;
}

export interface SpeakOpts {
  locale: string;
  rate: number;
  /** sentence i starts (also after skip / rate change) */
  onSentence?(i: number, total: number): void;
  /** completed = reached the end (false when stopped) */
  onEnd?(completed: boolean): void;
  /** optional character voice (the gull: ~1.4); default 1 */
  pitch?: number;
  /** optional 0..1; default 1 */
  volume?: number;
  /** word boundary inside sentence i (where the engine reports it), for lip/beak sync */
  onBoundary?(i: number, charIndex: number): void;
}

/** Sequential per-sentence speaker. One instance per page. */
export class Speaker {
  private queue: Seg[] = [];
  private i = 0;
  private token = 0;
  private opts: SpeakOpts | null = null;
  private watchdog = 0;
  private current: SpeechSynthesisUtterance | null = null; // keep a reference: Chrome GCs utterances and drops onend
  /** streaming: more sentences may still come (append); an empty queue waits instead of finishing */
  private open = false;
  private waiting = false;

  get speaking() { return this.opts !== null; }

  /** `open` = streaming: keep going until close(); feed more with append() */
  speak(segs: Seg[], opts: SpeakOpts, open = false) {
    if (!ttsSupported()) { opts.onEnd?.(false); return; }
    this.stop(false);
    this.queue = sentences(segs, opts.locale);
    this.i = 0;
    this.opts = opts;
    this.open = open;
    if (!this.queue.length) { if (open) this.waiting = true; else this.finish(true); return; }
    try { speechSynthesis.cancel(); speechSynthesis.resume(); } catch { /* ignore */ }
    this.next();
  }

  /** streaming: add sentences that are already split (see sentences()); resumes if the queue had run dry */
  append(sents: Seg[]) {
    if (!this.opts || !sents.length) return;
    this.queue.push(...sents);
    if (this.waiting) { this.waiting = false; this.next(); }
  }

  /** streaming: no more sentences; finishes now if everything was already said */
  close() {
    this.open = false;
    if (this.opts && this.waiting) { this.waiting = false; this.finish(true); }
  }

  /** stop now; onEnd(false) unless silent */
  stop(notify = true) {
    const o = this.opts;
    this.open = false;
    this.waiting = false;
    this.token++;
    clearTimeout(this.watchdog);
    this.opts = null;
    this.current = null;
    try { if (ttsSupported()) speechSynthesis.cancel(); } catch { /* ignore */ }
    if (o && notify) o.onEnd?.(false);
  }

  /** jump to the next sentence */
  skip() {
    if (!this.opts) return;
    this.restartAt(this.i + 1);
  }

  /** change rate; the current sentence starts again at the new rate */
  setRate(rate: number) {
    if (!this.opts) return;
    this.opts.rate = rate;
    this.restartAt(this.i);
  }

  private restartAt(i: number) {
    this.token++;
    clearTimeout(this.watchdog);
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this.i = i;
    // Safari fires the cancelled utterance's events late: give it a tick
    setTimeout(() => this.next(), 30);
  }

  private finish(completed: boolean) {
    const o = this.opts;
    this.open = false;
    this.waiting = false;
    this.opts = null;
    this.current = null;
    clearTimeout(this.watchdog);
    o?.onEnd?.(completed);
  }

  private next() {
    const o = this.opts;
    if (!o) return;
    if (this.i >= this.queue.length) {
      if (this.open) { this.waiting = true; return; } // streaming: wait for append() / close()
      this.finish(true); return;
    }
    const seg = this.queue[this.i];
    const tk = ++this.token;
    const u = new SpeechSynthesisUtterance(seg.text);
    const loc = seg.locale ?? o.locale;
    const v = pickVoice(loc) ?? (seg.locale ? pickVoice(o.locale) : null);
    if (v) u.voice = v;
    u.lang = v?.lang ?? loc;
    u.rate = o.rate;
    u.pitch = o.pitch ?? 1;
    if (o.volume != null) u.volume = o.volume;
    if (o.onBoundary) u.onboundary = (e) => { if (tk === this.token && e.name !== 'sentence') o.onBoundary?.(this.i, e.charIndex); };
    const advance = () => {
      if (tk !== this.token || !this.opts) return;
      clearTimeout(this.watchdog);
      this.i++;
      this.next();
    };
    u.onstart = () => { if (tk === this.token) o.onSentence?.(this.i, this.queue.length); };
    u.onend = advance;
    u.onerror = (e: any) => { if (e?.error === 'interrupted' || e?.error === 'canceled') return; advance(); };
    this.current = u;
    // watchdog: some engines never fire onend (Chrome on long idle, Android); ~11 chars/s at rate 1
    const est = (seg.text.length / (11 * o.rate)) * 1000 + 4000;
    this.watchdog = window.setTimeout(advance, est);
    speechSynthesis.speak(u);
  }
}

// ---------------------------------------------------------------- earcon

let ac: AudioContext | null = null;
/** Short, quiet two-note cue when the mic opens (hands-free mode only). Silent if audio is unavailable. */
export function earcon(up = true) {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ac ||= new AC();
    const ctx = ac!;
    const t = ctx.currentTime + 0.01;
    const notes = up ? [587.33, 880] : [880, 587.33];
    notes.forEach((f, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + k * 0.09);
      g.gain.linearRampToValueAtTime(0.06, t + k * 0.09 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.09 + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(t + k * 0.09); o.stop(t + k * 0.09 + 0.14);
    });
  } catch { /* ignore */ }
}
