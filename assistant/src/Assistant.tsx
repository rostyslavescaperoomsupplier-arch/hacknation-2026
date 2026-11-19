import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { Action, Answer, Lang, Stair, Turn } from './types';
import { STR, CONTACT, contactLabel } from './i18n';
import { askStream, paragraphs } from './adapter';
import { MewkaReact } from '../../mewka/src/mewka/MewkaReact';
import type { MewkaState } from '../../mewka/src';
import './assistant.css';
import Icon from './icons/Icon';
import { useVoice, type Voice } from './voice/useVoice';
import { ListenButton, MicButton, VoiceBar } from './ui/Voice';
import { trackKeyboardInset } from './lib/keyboard-inset';

/** `streamed`: the text was already shown growing in the live bubble (no second entrance animation / scroll jump) */
type Msg = { id: number; role: 'user'; text: string } | { id: number; role: 'bot'; answer: Answer; note?: string; streamed?: boolean };

let seq = 0;

// strings of the streaming UI (i18n.ts is shared; Polish first, English for the rest)
const UI = {
  pl: { stop: 'Zatrzymaj', stopped: 'Odpowiedź przerwana.' },
  en: { stop: 'Stop', stopped: 'Answer stopped.' },
};

// Mewka beats. Short on purpose: nothing decorative runs > 5 s (WCAG 2.2.2).
const T = { greet: 1800, talk: 960, point: 2600, unsure: 1500, happy: 700 };
/** while an answer streams in, the gull's talking beat (a one-shot) is re-triggered about this often */
const TALK_EVERY = 1200;
/** states the avatar of the latest answer mirrors (the big one shows every state) */
const ANSWER_STATES: MewkaState[] = ['talking', 'pointing', 'unsure', 'happy'];

/** The mascot is decoration and can be switched off: localStorage fs-mascot=off. */
function mascotEnabled(): boolean {
  try { return localStorage.getItem('fs-mascot') !== 'off'; } catch { return true; }
}

export interface AssistantProps {
  lang: Lang;
  /** open the Ewakuacja tab with this zone (and a blocked stairwell) */
  onRoute?(zone: string, blocked: Stair | null): void;
  /** open the Ćwiczenia tab on this drill */
  onDrill?(id: string): void;
}

export default function Assistant({ lang, onRoute, onDrill }: AssistantProps) {
  const s = STR[lang];
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  /** the answer that is streaming in right now (text so far); null = none / nothing arrived yet */
  const [live, setLive] = useState<{ id: number; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** id of the bot answer that is in flight (for the voice stream) */
  const pendingId = useRef(0);
  /** bumped by "clear": a request from before the clear must not write into the new conversation */
  const genRef = useRef(0);
  const history = useRef<Turn[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const userScrollAt = useRef(0);

  // ---- Mewka state machine: purely visual, every state also exists as text/ARIA ----
  const [mascot, setMascot] = useState(false);
  const [mood, setMoodState] = useState<MewkaState>('idle');
  const moodRef = useRef<MewkaState>('idle');
  const timers = useRef<number[]>([]);
  /** play a sequence of [state, holdMs] beats, then rest in idle; any new event interrupts it */
  function play(...beats: [MewkaState, number?][]) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    let at = 0;
    const set = (st: MewkaState) => { moodRef.current = st; setMoodState(st); };
    beats.forEach(([st, hold], i) => {
      if (i === 0) set(st); else timers.current.push(window.setTimeout(() => set(st), at));
      at += hold ?? 0;
      if (i === beats.length - 1 && hold) timers.current.push(window.setTimeout(() => set('idle'), at));
    });
  }

  /** what the big Mewka aims at: the action buttons of the newest answer, then the contact link, else the answer */
  function pointTarget(): Element | null {
    const last = [...msgs].reverse().find((m) => m.role === 'bot');
    const box = last && document.getElementById(`msg-${last.id}`);
    return box?.querySelector('[data-action]') ?? box?.querySelector('a[href^="tel:"]') ?? box?.querySelector('ol a') ?? box ?? null;
  }

  // ---- voice mode (speech in / speech out): see voice/useVoice.ts ----
  const sendRef = useRef<(q: string) => void>(() => {});
  const voice = useVoice({
    lang, busy,
    setInput: (t) => setValue(t.slice(0, 500)),
    submit: (t) => sendRef.current(t),
    mood: (...beats) => play(...beats),
  });
  // stream callbacks outlive the render that started them: always talk to the latest voice API
  const voiceRef = useRef<Voice>(voice);
  voiceRef.current = voice;
  const ui = UI[lang === 'pl' ? 'pl' : 'en'];

  async function send(q: string) {
    const query = q.trim();
    if (!query || busy) return;
    voice.onUserInput();
    setMsgs((m) => [...m, { id: ++seq, role: 'user', text: query }]);
    setValue('');
    history.current = [...history.current, { role: 'user', content: query }];
    setBusy(true);
    play(['thinking']);
    const id = ++seq;
    pendingId.current = id;
    const gen = genRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // voice mode + read aloud: speak sentence by sentence while the answer streams in
    const voiced = voiceRef.current.beginStream(id);
    let streamed = false;
    let lastBeat = 0;
    const started = performance.now();
    const a = await askStream(history.current, lang, {
      signal: ctrl.signal,
      onDelta: (text) => {
        if (gen !== genRef.current) return;
        if (!text) { streamed = false; setLive(null); play(['thinking']); return; } // falling back to the JSON endpoint
        setLive({ id, text });
        const voiceTalks = voiced && voiceRef.current.pushStreamText(id, text);
        const now = performance.now();
        if (!voiceTalks && (!streamed || now - lastBeat >= TALK_EVERY)) {
          lastBeat = now;
          if (streamed) play(['idle', 40], ['talking']); else play(['talking']);
        }
        streamed = true;
      },
    });
    if (abortRef.current === ctrl) abortRef.current = null;
    if (gen !== genRef.current) return; // the conversation was cleared meanwhile
    if (!streamed) await new Promise((r) => setTimeout(r, Math.max(0, 280 - (performance.now() - started))));
    // the history only keeps complete answers; a failed / stopped question is dropped (the user can simply ask again)
    if (!a.remoteFailed) history.current = [...history.current, { role: 'assistant', content: a.text.join('\n\n') }];
    else history.current = history.current.slice(0, -1);
    setLive(null);
    if (a.aborted) {
      if (a.text.length) setMsgs((m) => [...m, { id, role: 'bot', answer: a, note: ui.stopped, streamed: true }]);
      setBusy(false);
      voiceRef.current.endStream(id, null);
      play(['idle']);
      return;
    }
    setMsgs((m) => [...m, { id, role: 'bot', answer: a, streamed }]);
    setBusy(false);
    // voice mode: the answer is read aloud and the gull talks per sentence instead of the beats below
    if (voiced ? voiceRef.current.endStream(id, a) : voiceRef.current.onAnswer(id, a)) return;
    if (a.fallback) play(['talking', T.talk / 2], ['unsure', T.unsure], ['pointing', T.point]);
    else if (a.actions?.length || a.sources.length) play(['talking', T.talk], ['pointing', T.point]);
    else play(['talking', T.talk]);
  }

  useEffect(() => {
    if (!mascotEnabled()) return;
    setMascot(true);
    let greeted = true;
    try { greeted = sessionStorage.getItem('fs-mewka-greeted') === '1'; sessionStorage.setItem('fs-mewka-greeted', '1'); } catch { /* private mode */ }
    if (!greeted && !new URLSearchParams(location.search).get('q')) play(['greet', T.greet]);
    return () => timers.current.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  sendRef.current = send;

  /** Stop button / Escape: abort the answer that is streaming in (what arrived so far stays, marked as stopped) */
  function stopAnswer() {
    abortRef.current?.abort();
    input.current?.focus();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // not checking defaultPrevented: the voice layer may already have used Escape to stop speaking
      if (e.key !== 'Escape' || !abortRef.current || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      abortRef.current.abort();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); abortRef.current?.abort(); };
  }, []);

  // input focus / typing -> listening (wing to ear); blur or emptied -> idle
  function onInputFocus() { if (!busy) play(['listening']); }
  function onInputBlur() { if (moodRef.current === 'listening') play(['idle']); }
  function onInputChange(v: string) {
    setValue(v);
    voice.onUserInput();
    if (busy) return;
    if (v.trim()) { if (moodRef.current !== 'listening') play(['listening']); }
    else if (moodRef.current === 'listening') play(['idle']);
  }
  function onLogClick(ev: MouseEvent) {
    const link = (ev.target as Element).closest?.('a, [data-action]');
    if (link) play(['happy', T.happy]);
  }

  // deep link: ?q=...
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q');
    if (q) send(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // phones: keep the composer on top of the on-screen keyboard
  useEffect(() => {
    const untrack = trackKeyboardInset(() => [dock.current]);
    const mark = () => { userScrollAt.current = performance.now(); };
    window.addEventListener('touchmove', mark, { passive: true });
    window.addEventListener('wheel', mark, { passive: true });
    return () => { untrack(); window.removeEventListener('touchmove', mark); window.removeEventListener('wheel', mark); };
  }, []);

  useEffect(() => {
    if (!msgs.length) return;
    const reading = performance.now() - userScrollAt.current < 1200;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const last = msgs[msgs.length - 1];
    // a streamed answer was followed while it grew: stay at the end instead of jumping back to its start
    const el = !busy && last.role === 'bot' && !last.streamed ? document.getElementById(`msg-${last.id}`) : null;
    if (!reading) (el ?? end.current)?.scrollIntoView({ block: el ? 'start' : 'nearest', behavior });
  }, [msgs.length, busy]);

  // follow the growing answer (instant: smooth scrolling on every chunk would wobble), unless the user scrolls
  useEffect(() => {
    if (!live || performance.now() - userScrollAt.current < 1200) return;
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [live?.text]);

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    send(value);
    input.current?.focus();
  }

  function runAction(a: Action) {
    voice.onUserInput();
    play(['happy', T.happy]);
    if (a.type === 'route') onRoute?.(a.zone, a.blocked ?? null);
    else onDrill?.(a.id);
  }

  function clear() {
    genRef.current++;
    const streaming = abortRef.current;
    abortRef.current = null;
    streaming?.abort();
    if (streaming) { voice.endStream(pendingId.current, null); setBusy(false); setLive(null); }
    voice.onUserInput();
    setMsgs([]);
    history.current = [];
    play(['idle']);
    input.current?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end gap-3 pb-1 sm:gap-4 sm:pb-2">
        {mascot && (
          <span className="asst-head shrink-0">
            <MewkaReact state={mood} size="xl" pointTarget={mood === 'pointing' ? pointTarget() : null} />
          </span>
        )}
        <div className="min-w-0 flex-1 pb-2">
          <p className="tech-kicker">{s.ai_badge}</p>
          <h1 className="tech-title mt-1 text-h2">{s.title}</h1>
        </div>
        {msgs.length > 0 && (
          <button type="button" onClick={clear}
                  className="tap mb-1 inline-flex shrink-0 items-center gap-2 self-end rounded-card border border-line bg-paper px-3 text-sm font-semibold text-ink-2 hover:border-ink hover:text-ink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true" focusable="false">
              <path d="M5 12a7 7 0 1 0 2.1-5" /><path d="M4.5 3.5v4h4" />
            </svg>
            {s.clear}
          </button>
        )}
      </header>

      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- delegated listener on real links */}
      <div role="log" aria-live="polite" aria-relevant="additions" aria-label={s.log_label} aria-busy={busy}
           onClick={onLogClick} className="flex flex-col gap-5">
        <BotBubble mascot={mascot}>
          <p>{s.hello}</p>
        </BotBubble>
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id} className="asst-user flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-br-[2px] bg-navy px-4 py-3 leading-snug text-on-strong">
                <span className="sr-only">{s.you}: </span>{m.text}
              </p>
            </div>
          ) : (
            <BotAnswer key={m.id} id={`msg-${m.id}`} a={m.answer} lang={lang} note={m.note} mascot={mascot} animate={!m.streamed}
                       voice={voice} onListen={() => voice.read(m.id, m.answer)} onAction={runAction}
                       mood={i === msgs.length - 1 && ANSWER_STATES.includes(mood) ? mood : 'idle'} />
          ),
        )}
      </div>
      {/* the answer while it streams in: outside the log (not a live region, so screen readers are not flooded
          with every chunk); the finished answer is added to the log once and announced then */}
      {busy && live && (
        <div aria-busy="true">
          <BotBubble mascot={mascot} id={`msg-${live.id}`} animate mood={ANSWER_STATES.includes(mood) ? mood : 'idle'}>
            <span className="sr-only">{s.bot}: </span>
            {paragraphs(live.text).map((t, i) => <p key={i} className="max-w-[62ch] whitespace-pre-wrap leading-relaxed">{t}</p>)}
          </BotBubble>
        </div>
      )}
      {busy && !live && (
        <div role="status" className="asst-bot flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-gold text-gold-ink"><Icon name="spark-solid" size={14} /></span>
          <span className="panel inline-flex items-center gap-3 rounded-tl-[2px] px-4 py-2.5 text-sm text-ink-2">
            <span aria-hidden="true" className="asst-dots"><i /><i /><i /></span>
            {s.thinking}
          </span>
        </div>
      )}
      <div ref={end} className="-mt-4" />

      <div ref={dock} data-started={msgs.length > 0 || undefined}
           className="asst-dock sticky z-10 -mx-6 border-t border-line bg-paper px-6 pb-3 pt-3 lg:mx-0 lg:rounded-card lg:border lg:px-5 lg:pb-4 lg:pt-4">
        <div className={`mb-2 items-baseline justify-between gap-3 ${msgs.length ? 'hidden lg:flex' : 'flex'}`}>
          <h2 id="sugg-h" className="tech-kicker">{s.suggestions}</h2>
        </div>
        <ul aria-labelledby="sugg-h" onFocus={(e) => (e.target as HTMLElement).scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}
            className={`asst-chips -mx-6 mb-3 snap-x snap-proximity scroll-px-6 gap-2 overflow-x-auto overscroll-x-contain px-6 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0 ${msgs.length ? 'hidden lg:flex' : 'flex'}`}>
          {s.sugg.map((q) => (
            <li key={q} className="shrink-0 snap-start">
              <button type="button" onClick={() => send(q)} disabled={busy}
                      className="asst-chip tap inline-flex items-center gap-2 rounded-card border border-line bg-paper px-4 py-2 text-left text-[0.9375rem] hover:border-ink hover:bg-paper-2 disabled:opacity-50">
                {q}
                <Icon name="arrow-right" size={14} className="asst-chip-ic text-gold-ink" />
              </button>
            </li>
          ))}
        </ul>
        <VoiceBar voice={voice} lang={lang} />
        <form onSubmit={onSubmit} className="asst-composer flex items-center gap-2 rounded-full border border-ink/35 bg-paper py-1 pl-5 pr-1.5">
          <div className="min-w-0 flex-1">
            <label htmlFor="assistant-q" className="sr-only">{s.input_label}</label>
            <input id="assistant-q" ref={input} type="text" name="q" value={value} onChange={(e) => onInputChange(e.target.value)}
                   onFocus={onInputFocus} onBlur={onInputBlur}
                   placeholder={s.placeholder} autoComplete="off" enterKeyHint="send" maxLength={500}
                   aria-describedby="assistant-rodo-short"
                   className="tap w-full bg-transparent text-base placeholder:text-ink-2 focus:outline-none" />
          </div>
          <div className="asst-composer-btns flex shrink-0 items-center gap-2">
            <MicButton voice={voice} lang={lang} />
            {busy ? (
              <button type="button" onClick={stopAnswer} aria-keyshortcuts="Escape" title={`${ui.stop} (Esc)`}
                      className="asst-send tap inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-ink bg-paper px-4 font-semibold text-ink">
                <Icon name="stop" size={14} />
                <span className="sr-only sm:not-sr-only">{ui.stop}</span>
              </button>
            ) : (
            <button type="submit" disabled={!value.trim()}
                    className="asst-send tap inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-gold-ink px-4 font-semibold text-on-strong disabled:bg-paper-2 disabled:text-ink-2">
              <span className="sr-only sm:not-sr-only">{s.send}</span>
              <Icon name="arrow-right" size={18} />
            </button>
            )}
          </div>
        </form>
        <p id="assistant-rodo-short" className="asst-rodo mt-2 text-[0.8rem] text-ink-2">{s.rodo}</p>
      </div>
    </div>
  );
}

/** route action glyph: a walking arrow toward a flag (muster station) */
function RouteGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M3 18h9.5" /><path d="M9.5 15l3 3-3 3" /><path d="M17 20V4" /><path d="M17 4.5h4.5l-1.5 2.5 1.5 2.5H17" />
    </svg>
  );
}

function BotBubble({ children, mascot, mood = 'idle', id, animate }: { children: React.ReactNode; mascot?: boolean; mood?: MewkaState; id?: string; animate?: boolean }) {
  return (
    <div id={id} className={`flex scroll-mt-24 gap-3 ${animate ? 'asst-bot' : ''}`}>
      {mascot ? (
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
          <MewkaReact state={mood} size="sm" />
        </span>
      ) : (
        <span aria-hidden="true" className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-gold text-gold-ink"><Icon name="spark-solid" size={14} /></span>
      )}
      <div className="panel min-w-0 flex-1 space-y-3 rounded-tl-[2px] px-4 py-3">{children}</div>
    </div>
  );
}

function BotAnswer({ a, lang, note, mascot, mood, id, voice, onListen, onAction, animate = true }: { a: Answer; lang: Lang; note?: string; mascot?: boolean; mood?: MewkaState; id?: string; voice: Voice; onListen(): void; onAction(a: Action): void; animate?: boolean }) {
  const s = STR[lang];
  return (
    <BotBubble mascot={mascot} mood={mood} id={id} animate={animate}>
      <span className="sr-only">{s.bot}: </span>
      {note && <p className="text-sm text-warn">{note}</p>}
      {a.text.map((t, i) => <p key={i} className="max-w-[62ch] whitespace-pre-wrap leading-relaxed">{t}</p>)}
      {a.actions && a.actions.length > 0 && (
        <div className="pt-1">
          <p className="tech-kicker">{s.actions}</p>
          <ul className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {a.actions.map((act) => (
              <li key={act.type + (act.type === 'route' ? act.zone + (act.blocked ?? '') : act.id)}>
                <button type="button" data-action={act.type} onClick={() => onAction(act)}
                        className={`asst-act tap-lg inline-flex w-full items-center justify-between gap-3 rounded-card px-4 py-2.5 text-left font-semibold sm:w-auto ${
                          act.type === 'route' ? 'bg-ok text-on-strong hover:brightness-110' : 'border-2 border-gold bg-paper text-ink hover:bg-paper-2'}`}>
                  <span className="flex min-w-0 items-center gap-3">
                    {act.type === 'route' ? <RouteGlyph /> : <span aria-hidden="true" className="mark mark-sq" />}
                    <span className="min-w-0">
                      <span className={`block text-xs font-semibold uppercase tracking-[0.08em] ${act.type === 'route' ? '' : 'text-gold-ink'}`}>{act.type === 'route' ? s.act_route : s.act_drill}</span>
                      <span className="block">{act.label}</span>
                    </span>
                  </span>
                  <Icon name="arrow-right" size={20} className="shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ListenButton voice={voice} lang={lang} id={Number(id?.slice(4))} onClick={onListen} />
      {a.fallback && (
        <div className="flex flex-wrap gap-2">
          <a href={`tel:${CONTACT.tel}`} className="tap-lg inline-flex max-w-full items-center gap-3 rounded-card bg-navy px-4 py-2 text-on-strong no-underline">
            <Icon name="phone" size={20} className="shrink-0" />
            <span className="min-w-0 leading-tight">
              <span className="block font-semibold">{s.call}</span>
              <span className="block text-sm">{contactLabel(lang)}</span>
            </span>
          </a>
        </div>
      )}
      {a.sources.length > 0 && (
        <div className="pt-1">
          <p className="tech-kicker">{a.sources.length > 1 ? s.sources : s.source}</p>
          <ol className={`mt-2 grid gap-2 ${a.sources.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {a.sources.map((src, i) => {
              const ext = src.href.startsWith('http');
              return (
                <li key={src.href + src.label} className="flex">
                  <a href={src.href} {...(ext ? { rel: 'noopener', target: '_blank' } : {})}
                     className="tap group flex min-w-0 flex-1 items-start gap-3 rounded-card border border-line px-3 py-2 text-sm transition-colors hover:border-ink">
                    <span aria-hidden="true" className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-gold text-[0.7rem] font-semibold tabular-nums text-gold-ink">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-snug underline decoration-gold underline-offset-4 group-hover:decoration-ink">{src.label}</span>
                      {ext && <span className="block text-[0.8rem] text-ink-2">{new URL(src.href).hostname.replace(/^www\./, '')}</span>}
                    </span>
                    {ext && <Icon name="external" size={14} className="mt-1 shrink-0 text-ink-2" />}
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </BotBubble>
  );
}
