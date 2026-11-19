// Voice controls of the assistant: mic button (in the composer), voice bar (mode switch, state, grace/cancel,
// privacy note, settings) and the per-answer "Listen" button. Presentation only; logic in ../voice/useVoice.ts.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Lang } from '../types';
import Icon from '../icons/Icon';
import { VSTR } from '../voice/i18n';
import { GRACE_MS, RATES, type Voice } from '../voice/useVoice';

const QUOTE: Record<Lang, [string, string]> = { pl: ['„', '”'], de: ['„', '“'], en: ['“', '”'], uk: ['«', '»'] };
const fmtRate = (r: number, lang: Lang) => `${lang === 'en' ? String(r) : String(r).replace('.', ',')}×`;

/** five gold bars: listening = lively, speaking = wave, thinking = slow pulse, idle = flat. Decorative. */
function Meter({ phase }: { phase: string }) {
  return (
    <span aria-hidden="true" className="vx-meter" data-phase={phase}>
      <i /><i /><i /><i /><i />
    </span>
  );
}

export function MicButton({ voice, lang }: { voice: Voice; lang: Lang }) {
  const v = VSTR[lang];
  const ref = useRef<HTMLButtonElement>(null);
  const on = voice.phase === 'listening';
  // arriving from "Porozmawiaj z Mewką": the mic is the next step, so it gets focus
  useEffect(() => { if (voice.invited && voice.phase !== 'consent') ref.current?.focus({ preventScroll: true }); }, [voice.invited, voice.phase]);
  if (!voice.stt) return null;
  const label = on ? v.mic_stop : v.mic_start;
  return (
    <button ref={ref} type="button" onClick={voice.micPress} aria-keyshortcuts="Alt+Shift+M"
            aria-label={label} title={`${label} (Alt+Shift+M)`} data-on={on || undefined} data-invite={voice.invited || undefined}
            className="vx-mic tap inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-ink/35 text-ink">
      <Icon name={on ? 'stop' : 'mic'} size={on ? 16 : 20} />
    </button>
  );
}

export function ListenButton({ voice, lang, id, onClick }: { voice: Voice; lang: Lang; id: number; onClick(): void }) {
  const v = VSTR[lang];
  if (!voice.tts) return null;
  const on = voice.speakingId === id;
  return (
    <button type="button" onClick={onClick} aria-label={on ? v.listen_stop_aria : v.listen_aria} data-on={on || undefined}
            className="vx-listen tap -ml-1 inline-flex items-center gap-2 rounded-full px-3 text-sm font-medium text-ink-2 hover:text-ink">
      {on ? <Meter phase="speaking" /> : <Icon name="volume" size={18} />}
      <span>{on ? v.listen_stop : v.listen}</span>
    </button>
  );
}

/** `aside`: extra content at the end of the switch row (the chat puts the compact privacy link there on phones). */
export function VoiceBar({ voice, lang, aside }: { voice: Voice; lang: Lang; aside?: ReactNode }) {
  const v = VSTR[lang];
  const consentRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { phase, mode } = voice;

  // the privacy note takes focus when it appears, so keyboard and screen-reader users meet it first
  useEffect(() => { if (phase === 'consent') consentRef.current?.focus({ preventScroll: true }); }, [phase]);

  const status =
    phase === 'listening' ? v.st_listening :
    phase === 'thinking' ? v.st_thinking :
    phase === 'speaking' ? v.st_speaking : null;

  return (
    <div className="vx mb-2">
      {/* one polite, atomic live region for every voice state change (the chat log announces answers itself) */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{voice.live}</p>

      {(voice.stt || aside) && (
        <div className="vx-row flex flex-wrap items-center gap-x-3 gap-y-1">
          {voice.stt && <button type="button" role="switch" aria-checked={mode} onClick={voice.toggleMode} aria-describedby="vx-mode-hint"
                  className="vx-switch tap -ml-1 inline-flex items-center gap-2.5 rounded-full px-1 text-sm font-semibold">
            <span aria-hidden="true" className="vx-track"><span className="vx-thumb" /></span>
            {v.mode}
          </button>}
          {voice.stt && <span id="vx-mode-hint" className="sr-only">{v.mode_hint}</span>}
          {mode && status && (
            <span className="inline-flex min-w-0 items-center gap-2 text-sm text-ink-2" data-phase={phase}>
              <Meter phase={phase} />
              <span className="vx-status">{status}</span>
            </span>
          )}
          {phase === 'speaking' && (
            <span className="ml-auto inline-flex gap-1">
              <button type="button" onClick={voice.stop} className="vx-btn tap inline-flex items-center gap-1.5 rounded-full border border-ink px-3 text-sm font-semibold">
                <Icon name="stop" size={14} />{v.stop}
              </button>
              <button type="button" onClick={voice.skip} className="vx-btn tap inline-flex items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:border-ink">
                {v.skip}<Icon name="chevron-right" size={14} />
              </button>
            </span>
          )}
          {aside}
        </div>
      )}

      {phase === 'consent' && (
        <div role="group" aria-labelledby={titleId} className="vx-panel mt-2 border-l-2 border-gold bg-paper-2 px-4 py-3 text-sm">
          <p id={titleId} className="font-semibold">{v.privacy_title}</p>
          <p className="mt-1 max-w-[60ch] text-ink-2">{v.privacy}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button ref={consentRef} type="button" onClick={voice.consentOk}
                    className="tap inline-flex items-center gap-2 rounded-full bg-ink px-4 font-semibold text-paper">
              <Icon name="mic" size={18} />{v.privacy_ok}
            </button>
            <button type="button" onClick={voice.consentNo} className="tap inline-flex items-center rounded-full border border-ink px-4 font-semibold">{v.privacy_no}</button>
          </div>
        </div>
      )}

      {phase === 'heard' && (
        <div className="vx-panel vx-heard mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 bg-paper-2 px-4 py-2.5 text-sm">
          <span className="min-w-[14rem] flex-1">
            <span className="text-ink-2">{v.st_heard} </span>
            <span className="font-semibold">{QUOTE[lang][0]}{voice.heard}{QUOTE[lang][1]}</span>
          </span>
          <span className="inline-flex gap-1">
            <button type="button" onClick={voice.cancelHeard} className="vx-btn tap inline-flex items-center rounded-full border border-ink px-3 font-semibold">{v.cancel}</button>
            <button type="button" onClick={voice.sendHeard} className="vx-btn tap inline-flex items-center gap-1.5 rounded-full bg-ink px-3 font-semibold text-paper">
              {v.send_now}<Icon name="arrow-right" size={14} />
            </button>
          </span>
          {/* time left before sending: a shrinking hairline (static under reduced motion: the buttons carry the meaning) */}
          <span aria-hidden="true" className="vx-grace" style={{ ['--vx-grace' as any]: `${GRACE_MS}ms` }} />
        </div>
      )}

      {voice.error && <p className="mt-2 text-sm text-warn">{voice.error}</p>}
      {!voice.error && voice.notice && phase !== 'listening' && <p className="mt-2 text-sm text-ink-2">{voice.notice}</p>}

      {(mode || !voice.stt) && voice.tts !== null && (
        <details className="vx-set mt-1 text-sm">
          <summary className="tap inline-flex cursor-pointer items-center gap-1.5 text-ink-2 hover:text-ink">
            {v.settings}<Icon name="chevron-down" size={14} className="vx-chev" />
          </summary>
          <div className="mt-1 space-y-3 pb-1">
            {voice.tts ? (
              <>
                <fieldset>
                  <legend className="mb-1 text-ink-2">{v.rate}</legend>
                  <div className="flex flex-wrap gap-1">
                    {RATES.map((r) => (
                      <label key={r} className="vx-rate tap inline-flex cursor-pointer items-center rounded-full border border-line px-3">
                        <input type="radio" name="vx-rate" className="sr-only" checked={voice.rate === r} onChange={() => voice.setRate(r)} />
                        <span>{fmtRate(r, lang)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {voice.stt && (
                  <label className="tap inline-flex cursor-pointer items-center gap-2">
                    <input type="checkbox" className="size-5 accent-[var(--c-ink)]" checked={voice.autoRead} onChange={(e) => voice.setAutoRead(e.target.checked)} />
                    {v.autoread}
                  </label>
                )}
              </>
            ) : (
              <p className="text-ink-2">{v.no_voice}</p>
            )}
            {voice.stt && <p className="text-[0.8rem] text-ink-2">{v.keys}</p>}
          </div>
        </details>
      )}
    </div>
  );
}
