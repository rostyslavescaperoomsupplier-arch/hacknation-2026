import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { Answer, Lang, Turn } from './types';
import { STR, CONTACT } from './i18n';
import { ask } from './adapter';
import { MewkaReact } from '../../mewka/src/mewka/MewkaReact';
import type { MewkaState } from '../../mewka/src';
import './assistant.css';
import Icon from './icons/Icon';
import { useVoice, type Voice } from './voice/useVoice';
import { ListenButton, MicButton, VoiceBar } from './ui/Voice';
import { trackKeyboardInset } from './lib/keyboard-inset';
import CrewVideoChat from './crew/CrewVideoChat';

type Msg = { id: number; role: 'user'; text: string } | { id: number; role: 'bot'; answer: Answer; note?: string };

let seq = 0;

// Mewka beats. Short on purpose: nothing decorative runs > 5 s (WCAG 2.2.2).
const T = { greet: 1800, talk: 960, point: 2600, unsure: 1500, happy: 700 };
/** states the avatar of the latest answer mirrors (the big one shows every state) */
const ANSWER_STATES: MewkaState[] = ['talking', 'pointing', 'unsure', 'happy'];

/** The mascot is decoration and can be switched off: localStorage fs-mascot=off. */
function mascotEnabled(): boolean {
  try { return localStorage.getItem('fs-mascot') !== 'off'; } catch { return true; }
}

export default function Assistant({ lang }: { lang: Lang }) {
  const s = STR[lang];
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
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

  /** what the big Mewka aims at: the contact links of the newest answer, else the answer itself */
  function pointTarget(): Element | null {
    const last = [...msgs].reverse().find((m) => m.role === 'bot');
    const box = last && document.getElementById(`msg-${last.id}`);
    return box?.querySelector('a[href^="tel:"]') ?? box?.querySelector('ol a') ?? box ?? null;
  }

  // ---- voice mode (speech in / speech out): see voice/useVoice.ts ----
  const sendRef = useRef<(q: string) => void>(() => {});
  const voice = useVoice({
    lang, busy,
    setInput: (t) => setValue(t.slice(0, 500)),
    submit: (t) => sendRef.current(t),
    mood: (...beats) => play(...beats),
  });

  async function send(q: string) {
    const query = q.trim();
    if (!query || busy) return;
    voice.onUserInput();
    setMsgs((m) => [...m, { id: ++seq, role: 'user', text: query }]);
    setValue('');
    history.current = [...history.current, { role: 'user', content: query }];
    setBusy(true);
    play(['thinking']);
    const started = performance.now();
    const a = await ask(history.current, lang);
    const wait = Math.max(0, 280 - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    if (!a.remoteFailed) history.current = [...history.current, { role: 'assistant', content: a.text.join('\n\n') }];
    else history.current = history.current.slice(0, -1); // let the user simply ask again
    const id = ++seq;
    setMsgs((m) => [...m, { id, role: 'bot', answer: a }]);
    setBusy(false);
    // voice mode: the answer is read aloud and the gull talks per sentence instead of the beats below
    if (voice.onAnswer(id, a)) return;
    if (a.fallback) play(['talking', T.talk / 2], ['unsure', T.unsure], ['pointing', T.point]);
    else if (a.sources.length) play(['talking', T.talk], ['pointing', T.point]);
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
    const link = (ev.target as Element).closest?.('a');
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
    const el = !busy && last.role === 'bot' ? document.getElementById(`msg-${last.id}`) : null;
    if (!reading) (el ?? end.current)?.scrollIntoView({ block: el ? 'start' : 'nearest', behavior });
  }, [msgs.length, busy]);

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    send(value);
    input.current?.focus();
  }

  function clear() {
    voice.onUserInput();
    setMsgs([]);
    history.current = [];
    play(['idle']);
    input.current?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end gap-4 pb-2">
        {mascot && (
          <span className="asst-head shrink-0">
            <MewkaReact state={mood} size="xl" pointTarget={mood === 'pointing' ? pointTarget() : null} />
          </span>
        )}
        <div className="min-w-0 pb-2">
          <h1 className="text-h2 font-semibold">{s.title}</h1>
          <p className="text-sm text-ink-2">{s.ai_badge}</p>
        </div>
      </header>

      <CrewVideoChat lang={lang} />

      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- delegated listener on real links */}
      <div role="log" aria-live="polite" aria-relevant="additions" aria-label={s.log_label} aria-busy={busy}
           onClick={onLogClick} className="flex flex-col gap-5">
        <BotBubble mascot={mascot}>
          <p>{s.hello}</p>
        </BotBubble>
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id} className="asst-user flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-[1.25rem] rounded-br-[4px] bg-ink px-4 py-2.5 leading-snug text-paper">
                <span className="sr-only">{s.you}: </span>{m.text}
              </p>
            </div>
          ) : (
            <BotAnswer key={m.id} id={`msg-${m.id}`} a={m.answer} lang={lang} note={m.note} mascot={mascot}
                       voice={voice} onListen={() => voice.read(m.id, m.answer)}
                       mood={i === msgs.length - 1 && ANSWER_STATES.includes(mood) ? mood : 'idle'} />
          ),
        )}
      </div>
      {busy && (
        <div role="status" className="asst-bot flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-gold text-gold-ink"><Icon name="spark-solid" size={14} /></span>
          <span className="inline-flex items-center gap-3 rounded-[1.25rem] rounded-tl-[4px] bg-paper-2 px-4 py-2.5 text-sm text-ink-2">
            <span aria-hidden="true" className="asst-dots"><i /><i /><i /></span>
            {s.thinking}
          </span>
        </div>
      )}
      <div ref={end} className="-mt-4" />

      <div ref={dock} data-started={msgs.length > 0 || undefined}
           className="asst-dock sticky z-10 -mx-4 border-t border-line bg-paper/95 px-4 pb-3 pt-3 backdrop-blur lg:mx-0 lg:rounded-card lg:border lg:px-5 lg:pb-4 lg:pt-4">
        <div className={`mb-2 items-baseline justify-between gap-3 ${msgs.length ? 'hidden lg:flex' : 'flex'}`}>
          <h2 id="sugg-h" className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-2">{s.suggestions}</h2>
          {msgs.length > 0 && (
            <button type="button" onClick={clear} className="tap -my-3 px-1 text-sm text-ink-2 underline underline-offset-4 hover:text-ink">{s.clear}</button>
          )}
        </div>
        <ul aria-labelledby="sugg-h" onFocus={(e) => (e.target as HTMLElement).scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}
            className={`asst-chips -mx-4 mb-3 snap-x snap-proximity scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0 ${msgs.length ? 'hidden lg:flex' : 'flex'}`}>
          {s.sugg.map((q) => (
            <li key={q} className="shrink-0 snap-start">
              <button type="button" onClick={() => send(q)} disabled={busy}
                      className="asst-chip tap inline-flex items-center gap-2 rounded-full border border-line bg-paper px-4 text-sm hover:border-ink hover:bg-paper-2 disabled:opacity-50">
                {q}
                <Icon name="arrow-right" size={14} className="asst-chip-ic text-gold-ink" />
              </button>
            </li>
          ))}
        </ul>
        <VoiceBar voice={voice} lang={lang} />
        <form onSubmit={onSubmit} className="asst-composer flex items-center gap-2 rounded-full border border-ink/35 bg-paper py-1 pl-5 pr-1">
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
            <button type="submit" disabled={busy || !value.trim()}
                    className="asst-send tap inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-ink px-4 font-semibold text-paper disabled:bg-paper-2 disabled:text-ink-2">
              <span className="sr-only sm:not-sr-only">{s.send}</span>
              <Icon name="arrow-right" size={18} />
            </button>
          </div>
        </form>
        <p id="assistant-rodo-short" className="asst-rodo mt-2 text-[0.8rem] text-ink-2">{s.rodo}</p>
      </div>
    </div>
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
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </div>
  );
}

function BotAnswer({ a, lang, note, mascot, mood, id, voice, onListen }: { a: Answer; lang: Lang; note?: string; mascot?: boolean; mood?: MewkaState; id?: string; voice: Voice; onListen(): void }) {
  const s = STR[lang];
  return (
    <BotBubble mascot={mascot} mood={mood} id={id} animate>
      <span className="sr-only">{s.bot}: </span>
      {note && <p className="text-sm text-warn">{note}</p>}
      {a.text.map((t, i) => <p key={i} className="max-w-[62ch] whitespace-pre-wrap leading-relaxed">{t}</p>)}
      <ListenButton voice={voice} lang={lang} id={Number(id?.slice(4))} onClick={onListen} />
      {a.fallback && (
        <div className="flex flex-wrap gap-2">
          <a href={`tel:${CONTACT.tel}`} className="tap inline-flex items-center gap-2 rounded-full bg-ink px-4 font-semibold text-paper">
            <Icon name="phone" size={18} />
            {s.call} <span className="font-normal">{CONTACT.telLabel}</span>
          </a>
          <a href={`mailto:${CONTACT.mail}`} className="tap inline-flex items-center rounded-full border border-ink px-4 font-semibold">{s.write}</a>
        </div>
      )}
      {a.sources.length > 0 && (
        <div className="pt-1">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-2">{a.sources.length > 1 ? s.sources : s.source}</p>
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
