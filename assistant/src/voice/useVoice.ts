// Voice mode state machine for the assistant chat.
//
//   idle ──mic──▶ (consent, first time only) ──▶ listening ──final──▶ heard (grace, cancel) ──▶ send
//     ▲                                              │ no speech / error                         │
//     │                                              ▼                                           ▼
//     └──────────── speaking ◀── answer (voice mode + "read aloud") ◀──────────────────── thinking
//                    │ done: voice mode → listening again (hands-free loop); else idle
//                    │ user speaks / mic / Escape / typing → stop speaking (barge-in)
//
// Streaming answers (beginStream / pushStreamText / endStream): the voice starts with the first COMPLETE sentence
// while the rest is still arriving; a sentence counts as complete once the next one has begun (or its paragraph
// closed with a blank line). The last one waits for endStream, which also adds whatever the final text has more.
//
// Every state is also text (visible status + one aria-live region); the gull only mirrors it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Answer, Lang } from '../types';
import { lev, tokens } from '../lib/text';
import type { MewkaState } from '../../../mewka/src';
import { Speaker, earcon, listen, pickVoice, sentences, sttSupported, ttsSupported, voicesReady, type Listening, type Seg, type SttError } from './engine';
import { LOCALE, VSTR } from './i18n';
import { claim, release } from '../lib/bus';
import { speakable, speechText, spokenWords } from './speakable';

export type Phase = 'idle' | 'consent' | 'listening' | 'heard' | 'thinking' | 'speaking';
type Beat = [MewkaState, number?];

/** grace period between the final transcript and sending (visible, cancellable) */
export const GRACE_MS = 1600;
export const RATES = [0.75, 1, 1.25, 1.5];
/** after the voice ends, the mic opens this late (room reverb / the speaker's buffer tail) */
const AFTER_SPEECH_MS = 1400;
/** right after the voice: a final that is mostly our own words is an echo, not a question */
const ECHO_TAIL_MS = 3000;
/** spoken commands that stop instead of being sent as a question */
const STOP_WORDS = new Set(['stop', 'stopp', 'dosc', 'koniec', 'zatrzymaj', 'przestan', 'cisza', 'halt', 'genug', 'enough', 'quiet', 'dosyt', 'zupynys', 'zupynysia', 'tycho']);

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function initialRate(): number {
  const own = parseFloat(lsGet('fs-voice-rate') || '');
  if (RATES.includes(own)) return own;
  try { const a = parseFloat(JSON.parse(lsGet('fs-a11y') || '{}').rate); if (RATES.includes(a)) return a; } catch { /* ignore */ }
  return 1;
}

export interface VoiceDeps {
  lang: Lang;
  busy: boolean;
  setInput(text: string): void;
  submit(text: string): void;
  mood(...beats: Beat[]): void;
}

export function useVoice({ lang, busy, setInput, submit, mood }: VoiceDeps) {
  const v = VSTR[lang];
  const locale = LOCALE[lang];
  const [stt, setStt] = useState(false);          // false on SSR; real value after mount
  const [tts, setTts] = useState<boolean | null>(null); // null = not known yet (voices load late)
  const [mode, setModeState] = useState(false);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [rate, setRateState] = useState(1);
  const [autoRead, setAutoReadState] = useState(true);
  const [invited, setInvited] = useState(false);

  // refs mirror state for event callbacks (no stale closures)
  const phaseRef = useRef<Phase>('idle');
  const modeRef = useRef(false);
  const autoRef = useRef(true);
  const rateRef = useRef(1);
  const rec = useRef<Listening | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const graceT = useRef(0);
  const loopT = useRef(0);
  const talkT = useRef(0);
  const spoken = useRef<Set<string>>(new Set());
  const bargeRestarts = useRef(0);
  const spokeUntil = useRef(0);
  const pendingStart = useRef(false);
  /** the streaming answer being read: `queued` sentences handed to the speaker; `dead` = stopped / barged in */
  const stream = useRef<{ id: number; queued: number; started: boolean; dead: boolean } | null>(null);
  const deps = useRef({ setInput, submit, mood });
  deps.current = { setInput, submit, mood };

  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const setMode = (m: boolean) => { modeRef.current = m; setModeState(m); };
  const announce = (t: string) => { setLive(''); requestAnimationFrame(() => setLive(t)); };
  const clearTimers = () => { clearTimeout(graceT.current); clearTimeout(loopT.current); clearInterval(talkT.current); };

  // ---- capabilities (client only) ----
  useEffect(() => {
    setStt(sttSupported());
    speaker.current = new Speaker();
    const r = initialRate();
    rateRef.current = r; setRateState(r);
    if (!ttsSupported()) setTts(false);
    else {
      voicesReady().then(() => setTts(!!pickVoice(locale)));
      const onVoices = () => setTts(!!pickVoice(locale));
      speechSynthesis.addEventListener?.('voiceschanged', onVoices);
      return () => speechSynthesis.removeEventListener?.('voiceschanged', onVoices);
    }
  }, [locale]);

  const stopSpeaking = useCallback((notify = false) => {
    clearInterval(talkT.current);
    if (stream.current) stream.current.dead = true; // the rest of a streaming answer stays silent
    if (speaker.current?.speaking) speaker.current.stop(notify);
    setSpeakingId(null);
  }, []);

  const stopListening = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    r?.abort();
  }, []);

  /** everything off, back to idle (mode stays as it is) */
  const stopAll = useCallback((say = false) => {
    clearTimers();
    stopListening();
    stopSpeaking();
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'thinking') setPhase('idle');
    if (say) announce(v.ann_stopped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  function sttError(e: SttError) {
    const p = phaseRef.current;
    if (p === 'speaking') { // the barge-in listener: stay quiet, except a revoked permission
      if (e === 'not-allowed') bargeRestarts.current = 99;
      return;
    }
    if (e === 'aborted') return;
    if (e === 'no-speech') {
      setNotice(v.st_paused); // the hands-free loop pauses after silence
      announce(v.st_paused);
      return;
    }
    const msg = { 'not-allowed': v.err_denied, 'audio-capture': v.err_audio, network: v.err_network, language: v.err_lang, other: v.err_generic }[e];
    setError(msg);
    announce(msg);
    if (e !== 'network' && e !== 'other') setMode(false);
  }

  /** does a heard word match something we said? fuzzy: the recogniser mangles our own voice (endings, typos) */
  function saidWord(w: string): boolean {
    if (spoken.current.has(w)) return true;
    if (w.length <= 2) return true; // short words are noise either way
    for (const s of spoken.current) {
      if (s.length >= 4 && w.length >= 4 && s.slice(0, 4) === w.slice(0, 4)) return true;
      if (Math.abs(s.length - w.length) <= 2 && lev(s, w, 2) <= (w.length > 6 ? 2 : 1)) return true;
    }
    return false;
  }
  /** share of the heard words that we said ourselves */
  function echoShare(t: string): number {
    const tk = tokens(t);
    if (!tk.length) return 1;
    return tk.filter(saidWord).length / tk.length;
  }
  function isEcho(t: string): boolean { return echoShare(t) >= 0.4; }
  function isStop(t: string): boolean {
    const tk = tokens(t);
    return tk.length > 0 && tk.length <= 2 && tk.every((w) => STOP_WORDS.has(w));
  }

  /** the user started talking over the voice: stop it and take over the same recogniser */
  function bargeIn() {
    stopSpeaking();
    setPhase('listening');
    deps.current.mood(['listening']);
  }

  function onFinal(t: string) {
    if (phaseRef.current === 'speaking') {
      // the mic hears the speaker (no echo cancellation for speechSynthesis): only a stop word, or a clearly
      // different sentence of 3+ words, counts as the user talking over the voice
      if (isStop(t)) { deps.current.setInput(''); stopAll(true); deps.current.mood(['idle']); return; }
      if (tokens(t).length < 3 || echoShare(t) >= 0.25) return;
      bargeIn();
    } else if (Date.now() < spokeUntil.current + ECHO_TAIL_MS && isEcho(t)) {
      // the tail of our own answer caught by the freshly opened mic: listen again instead of asking it back
      deps.current.setInput('');
      if (modeRef.current) loopT.current = window.setTimeout(() => { if (phaseRef.current === 'idle' && modeRef.current) startListening(); }, 300);
      return;
    }
    if (isStop(t)) { deps.current.setInput(''); stopAll(true); deps.current.mood(['idle']); return; }
    deps.current.setInput(t);
    setHeard(t);
    setPhase('heard');
    announce(v.ann_heard(t.replace(/[.!?…]+$/, '')));
    clearTimeout(graceT.current);
    graceT.current = window.setTimeout(() => commit(t), GRACE_MS);
  }

  function startRec() {
    let first = true;
    rec.current = listen(locale, {
      onInterim: (t) => {
        if (phaseRef.current === 'speaking') return; // interim guesses of our own voice: never barge in on them
        if (phaseRef.current !== 'listening') return;
        if (first) { first = false; setNotice(null); }
        deps.current.setInput(t);
      },
      onFinal,
      onError: sttError,
      onEnd: () => {
        const p = phaseRef.current;
        rec.current = null;
        // barge-in listener ended (silence / echo-only final) while still speaking: listen on
        if (p === 'speaking' && modeRef.current && speaker.current?.speaking && bargeRestarts.current++ < 8) {
          loopT.current = window.setTimeout(() => { if (phaseRef.current === 'speaking' && !rec.current) startRec(); }, 250);
          return;
        }
        if (p === 'listening') { setPhase('idle'); deps.current.mood(['idle']); }
      },
    });
    if (!rec.current && phaseRef.current === 'listening') setPhase('idle');
  }

  function startListening() {
    if (!sttSupported()) return;
    if (lsGet('fs-voice-privacy') !== '1') { pendingStart.current = true; setPhase('consent'); return; }
    clearTimers();
    stopSpeaking();
    stopListening();
    setError(null);
    setNotice(null);
    setHeard('');
    setPhase('listening');
    deps.current.mood(['listening']);
    announce(v.ann_listening);
    if (modeRef.current) { earcon(true); loopT.current = window.setTimeout(() => phaseRef.current === 'listening' && startRec(), 170); }
    else startRec();
  }

  function commit(t: string) {
    clearTimeout(graceT.current);
    setHeard('');
    setPhase('thinking');
    deps.current.submit(t);
  }

  function speak(id: number, a: Answer, loop: boolean) {
    return startSpeech(id, speakable(a, lang), loop, false);
  }

  /** words we are about to say: the barge-in listener ignores them (echo of our own voice) */
  function addEcho(segs: Seg[]) {
    for (const w of tokens(spokenWords(segs))) spoken.current.add(w);
  }

  /** complete sentences of a streaming text (markers are already gone; links etc. removed by speechText) */
  function streamSentences(text: string, final: boolean): Seg[] {
    const segs = text.split(/\n[ \t]*\n/).map((p) => ({ text: speechText(p.trim(), lang) })).filter((x) => x.text);
    const all = sentences(segs, locale);
    // the last sentence may still grow, unless the answer is over or its paragraph is closed
    return final || /\n[ \t]*\n\s*$/.test(text) ? all : all.slice(0, -1);
  }

  /** `open` = streaming: the speaker waits for more sentences until close() */
  function startSpeech(id: number, segs: Seg[], loop: boolean, open: boolean) {
    const sp = speaker.current;
    if (!sp || !tts) return false;
    if (stream.current && stream.current.id !== id) stream.current.dead = true; // "Listen" on another answer wins
    stopListening();
    spoken.current = new Set(tokens(spokenWords(segs)));
    setSpeakingId(id);
    setPhase('speaking');
    if (loop) announce(v.ann_speaking);
    const talk = () => deps.current.mood(['idle', 40], ['talking']);
    sp.speak(segs, {
      locale,
      rate: rateRef.current,
      onSentence: () => {
        // the beak is a 1.1 s one-shot: start it on every sentence and keep it going through long ones
        clearInterval(talkT.current);
        talk();
        talkT.current = window.setInterval(talk, 1400);
      },
      onEnd: (completed) => {
        clearInterval(talkT.current);
        setSpeakingId(null);
        spokeUntil.current = Date.now();
        stopListening(); // the barge-in listener
        if (phaseRef.current !== 'speaking') return; // barged in / stopped: the new phase is already set
        setPhase('idle');
        if (!completed) { deps.current.mood(['idle']); return; }
        deps.current.mood(['happy', 700]);
        if (loop && modeRef.current) loopT.current = window.setTimeout(() => { if (phaseRef.current === 'idle' && modeRef.current) startListening(); }, AFTER_SPEECH_MS);
      },
    }, open);
    // half-duplex: the mic stays closed while the voice speaks. Browsers do not cancel the echo of speechSynthesis,
    // so an open mic always ends up hearing Mewka herself. Interrupt = mic button, Escape, typing or a tap.
    bargeRestarts.current = 99;
    return true;
  }

  // ---- public actions ----
  const api = {
    stt, tts, mode, phase, heard, error, notice, live, speakingId, rate, autoRead, invited,

    /** mic button / Alt+Shift+M */
    micPress() {
      setInvited(false);
      const p = phaseRef.current;
      if (p === 'listening') { rec.current?.stop(); return; } // let the browser deliver the final words
      if (p === 'consent') return;
      startListening();
    },
    toggleMode() {
      setInvited(false);
      if (modeRef.current) {
        setMode(false); stopAll(); setNotice(null); deps.current.mood(['idle']); announce(v.ann_off);
        if (phaseRef.current === 'consent') setPhase('idle');
        return;
      }
      setMode(true); setError(null); autoRef.current = true; setAutoReadState(true);
      announce(v.ann_on);
      startListening();
    },
    /** "Hej Mewka": voice mode on (answers read aloud, hands-free loop); listen = open the mic now */
    wake(listen: boolean) {
      setInvited(false);
      setNotice(null);
      if (!modeRef.current) { setMode(true); setError(null); autoRef.current = true; setAutoReadState(true); announce(v.ann_on); }
      if (listen && phaseRef.current !== 'listening') startListening();
    },
    consentOk() {
      lsSet('fs-voice-privacy', '1');
      setPhase('idle');
      if (pendingStart.current) { pendingStart.current = false; startListening(); }
    },
    consentNo() {
      pendingStart.current = false;
      setPhase('idle');
      setMode(false);
      deps.current.mood(['idle']);
    },
    cancelHeard() {
      clearTimeout(graceT.current);
      setHeard('');
      setPhase('idle');
      deps.current.mood(['idle']);
      announce(v.ann_cancelled);
    },
    sendHeard() {
      const t = heard;
      if (t) commit(t);
    },
    stop() { stopAll(true); deps.current.mood(['idle']); },
    skip() { speaker.current?.skip(); },
    setRate(r: number) {
      rateRef.current = r; setRateState(r); lsSet('fs-voice-rate', String(r));
      speaker.current?.setRate(r);
    },
    setAutoRead(b: boolean) { autoRef.current = b; setAutoReadState(b); if (!b && speaker.current?.speaking && modeRef.current) stopAll(); },
    /** per-answer "Listen" button (works without voice mode) */
    read(id: number, a: Answer) {
      if (speakingId === id) { stopAll(); deps.current.mood(['idle']); return; }
      clearTimers();
      speak(id, a, false);
    },
    /** called by the chat when an answer lands; true = it is being spoken (the chat skips its own gull beats) */
    onAnswer(id: number, a: Answer): boolean {
      if (modeRef.current && autoRef.current && tts) return speak(id, a, true);
      if (phaseRef.current === 'thinking') setPhase('idle');
      return false;
    },
    // ---- streaming answers (the chat calls these in order; any of them is a no-op for another id) ----
    /** a streaming answer starts; true = voice mode reads it aloud (then call pushStreamText / endStream) */
    beginStream(id: number): boolean {
      stream.current = null;
      if (!(modeRef.current && autoRef.current && tts && speaker.current)) return false;
      stream.current = { id, queued: 0, started: false, dead: false };
      return true;
    },
    /** the visible text so far; speaks every newly completed sentence. true = the voice drives the gull now */
    pushStreamText(id: number, textSoFar: string): boolean {
      const st = stream.current;
      if (!st || st.id !== id || st.dead) return false;
      const all = streamSentences(textSoFar, false);
      if (all.length > st.queued) {
        const fresh = all.slice(st.queued);
        st.queued = all.length;
        if (!st.started) {
          st.started = startSpeech(id, fresh, true, true);
          if (!st.started) st.dead = true;
        } else {
          addEcho(fresh);
          speaker.current?.append(fresh);
        }
      }
      return st.started;
    },
    /** the stream ended: `a` = the final answer (null = aborted by the user). true = the voice handles the gull */
    endStream(id: number, a: Answer | null): boolean {
      const st = stream.current;
      if (!st || st.id !== id) {
        if (a) return apiRef.current.onAnswer(id, a);
        if (phaseRef.current === 'thinking') setPhase('idle');
        return false;
      }
      stream.current = null;
      if (!a) {
        if (st.started && !st.dead) { stopSpeaking(); if (phaseRef.current === 'speaking') setPhase('idle'); }
        if (phaseRef.current === 'thinking') setPhase('idle');
        return false;
      }
      if (st.dead) { if (phaseRef.current === 'thinking') setPhase('idle'); return true; } // stopped / barged in meanwhile
      const all = streamSentences(a.text.join('\n\n'), true);
      if (!st.started) {
        if (startSpeech(id, all, true, false)) return true;
        if (phaseRef.current === 'thinking') setPhase('idle');
        return false;
      }
      const rest = all.slice(st.queued);
      addEcho(rest);
      speaker.current?.append(rest);
      speaker.current?.close();
      return true;
    },
    /** typing, sending or clearing: new input always silences the voice */
    onUserInput() {
      if (phaseRef.current === 'heard') { clearTimeout(graceT.current); setHeard(''); setPhase('idle'); }
      if (speaker.current?.speaking) { stopSpeaking(); setPhase('idle'); }
      if (phaseRef.current === 'listening') { stopListening(); setPhase('idle'); }
    },
  };

  // page audio bus: while the assistant reads aloud, other voices (the gull) stay quiet
  useEffect(() => { if (speakingId !== null) claim('assistant'); else release('assistant'); }, [speakingId]);
  useEffect(() => () => release('assistant'), []);

  // thinking mirrors the chat's busy flag while a voice question is answered
  useEffect(() => {
    if (busy && (modeRef.current || phaseRef.current === 'thinking')) setPhase('thinking');
  }, [busy]);

  // deep link ?voice=1 (mascot bubble "Porozmawiaj z Mewką"): voice mode on, waiting for a tap on the mic
  // (browsers need a user gesture before speaking, and the mic needs one for the permission prompt)
  useEffect(() => {
    if (new URLSearchParams(location.search).get('voice') !== '1') return;
    if (!sttSupported()) { setNotice(v.unsupported); return; }
    setMode(true);
    setInvited(true);
    deps.current.mood(['listen-invite']);
    if (lsGet('fs-voice-privacy') !== '1') { pendingStart.current = true; setPhase('consent'); }
    else setNotice(v.st_ready);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // shortcuts + auto-stop on navigation / hidden tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') {
        if (!sttSupported()) return;
        e.preventDefault();
        apiRef.current.micPress();
        return;
      }
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      const p = phaseRef.current;
      if (p === 'heard') { e.preventDefault(); apiRef.current.cancelHeard(); }
      else if (p === 'listening' || p === 'speaking') { e.preventDefault(); apiRef.current.stop(); }
      else if (p === 'consent') { e.preventDefault(); apiRef.current.consentNo(); }
    };
    const off = () => { clearTimers(); stopListening(); stopSpeaking(); if (phaseRef.current !== 'thinking') setPhase('idle'); };
    const onVis = () => { if (document.hidden) off(); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (a && !a.getAttribute('href')!.startsWith('#') && speaker.current?.speaking) off();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('click', onClick, true);
    addEventListener('pagehide', off);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('click', onClick, true);
      removeEventListener('pagehide', off);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiRef = useRef(api);
  apiRef.current = api;
  return api;
}

export type Voice = ReturnType<typeof useVoice>;
