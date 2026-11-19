// "Hej Mewka": a light background recogniser that only waits for the wake phrase. When it hears it, it stops itself
// and hands over to the normal voice mode (useVoice), with whatever was said after the name ("hej mewka, zadzwoń na
// mostek" -> rest = "zadzwoń na mostek"). Opt-in (switch in the voice bar), only after the voice privacy note was
// accepted, paused while the voice mode itself listens or speaks (one recogniser at a time; Mewka must not wake
// herself). Same browser speech service as the voice mode (Chrome: Google), so the same privacy note applies.
/* eslint-disable @typescript-eslint/no-explicit-any */

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
/** "hej mewka", "hey mewko", "mewka," ... (recognisers also write it "mewa", "mefka", "newka") */
const WAKE_RE = /\b(?:(?:hej|hey|hejka|ej|halo|czesc|hi|hello)\s+)?(?:mewk[aoiey]|mefk[ao]|newk[ao]|mewa)\b[,.!?\s]*/;

export function wakeSupported(): boolean {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  return !!(w && (w.SpeechRecognition || w.webkitSpeechRecognition));
}

/** the part after the wake phrase, or null when the phrase is not there */
export function afterWake(text: string): string | null {
  const t = fold(text);
  const m = WAKE_RE.exec(t);
  if (!m) return null;
  // map the folded index back onto the original (folding keeps length for Polish letters)
  return text.slice(m.index + m[0].length).replace(/^[\s,.!?]+/, '').trim();
}

export class WakeListener {
  private rec: any = null;
  private on = false;
  private timer = 0;
  private fails = 0;
  private locale: string;
  private onWake: (rest: string) => void;
  private onDenied?: () => void;
  constructor(locale: string, onWake: (rest: string) => void, onDenied?: () => void) {
    this.locale = locale; this.onWake = onWake; this.onDenied = onDenied;
  }

  /** keep listening (restarting after the browser ends a session) until stop() */
  start() {
    if (this.on || !wakeSupported()) return;
    this.on = true;
    this.fails = 0;
    this.open();
  }
  stop() {
    this.on = false;
    clearTimeout(this.timer);
    const r = this.rec;
    this.rec = null;
    try { r?.abort(); } catch { /* ignore */ }
  }
  setLocale(l: string) { if (l !== this.locale) { this.locale = l; if (this.on) { this.stop(); this.start(); } } }

  private open() {
    if (!this.on || this.rec) return;
    const W = window as any;
    const R = W.SpeechRecognition || W.webkitSpeechRecognition;
    const r = new R();
    r.lang = this.locale;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let fired = false;
    let armed = false; // phrase seen in an interim result: wait (max 1.6 s) for the rest of the sentence
    let armT = 0;
    const fire = (rest: string) => {
      if (fired) return;
      fired = true;
      clearTimeout(armT);
      this.stop();
      this.onWake(rest);
    };
    r.onresult = (e: any) => {
      this.fails = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = String(res[0]?.transcript ?? '');
        const rest = afterWake(text);
        if (rest === null) continue;
        if (res.isFinal) { fire(rest); return; }
        if (!armed) { armed = true; armT = window.setTimeout(() => fire(afterWake(text) ?? ''), 1600); }
      }
    };
    r.onerror = (e: any) => {
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') { this.on = false; this.onDenied?.(); }
      else if (e?.error !== 'no-speech' && e?.error !== 'aborted') this.fails++;
    };
    r.onend = () => {
      if (this.rec === r) this.rec = null;
      clearTimeout(armT);
      // the browser closes long sessions (silence, ~1 min): open the next one; back off when it keeps failing
      if (this.on && !fired) this.timer = window.setTimeout(() => this.open(), Math.min(250 * 2 ** this.fails, 15_000));
    };
    try { r.start(); this.rec = r; } catch { this.timer = window.setTimeout(() => this.open(), 1000); }
  }
}
