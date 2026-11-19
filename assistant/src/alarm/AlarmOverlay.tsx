/** Full-screen alarm on every terminal (mount once at the app root, inside <AlarmProvider>).
 *  Until this terminal acknowledges: role="alertdialog" over everything, the alarm sound looping (Web Audio patterns
 *  from the drills), focus kept inside. Escape never dismisses a real alarm (on a drill it acknowledges).
 *  After the acknowledgement: a slim sticky banner with the elapsed time until the bridge ends the alarm. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../types';
import { ZONE, type ZoneId, type Stair } from '../ship/routes';
import { playAlarm, stopAlarm } from '../drills/alarm';
import { isAlarmZone, type Alarm } from '../../shared/alarms';
import { useAlarms, useElapsed } from './AlarmProvider';
import { L, actionsFor, clock, kindName, patternFor, signalFor, tx } from './kinds';
import './alarm.css';

interface Props {
  lang: Lang;
  /** open the evacuation route (App: showRoute) */
  onShowRoute?(zone: ZoneId, blocked: Stair | null): void;
  /** open the "Alarmy" tab from the banner */
  onOpenPanel?(): void;
}

/** true when the browser will not start audio before a user gesture */
function audioBlocked(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (ua) return !ua.hasBeenActive;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    const probe = new AC();
    const blocked = probe.state === 'suspended';
    void probe.close();
    return blocked;
  } catch { return false; }
}

/** Loops the alarm pattern (1.5 s pause between repeats) while `on`. Returns [blocked, start]. */
function useAlarmSound(alarm: Alarm | null, on: boolean): [boolean, () => void] {
  const [blocked, setBlocked] = useState(false);
  const loop = useRef<{ id: string; timer: number } | null>(null);
  const stop = useCallback(() => {
    if (loop.current) { clearTimeout(loop.current.timer); loop.current = null; stopAlarm(); }
  }, []);
  const start = useCallback(() => {
    if (!alarm) return;
    stop();
    const id = alarm.id;
    const pattern = patternFor(alarm.kind);
    const cycle = () => {
      if (loop.current?.id !== id) return;
      const ok = playAlarm(pattern, () => {
        if (loop.current?.id === id) loop.current.timer = window.setTimeout(cycle, 1500);
      });
      if (!ok) setBlocked(false); // no Web Audio at all: nothing to unlock
    };
    loop.current = { id, timer: 0 };
    cycle();
    setBlocked(false);
  }, [alarm, stop]);
  useEffect(() => {
    if (!on || !alarm) { stop(); return; }
    if (audioBlocked()) setBlocked(true);
    else start();
    return stop;
  }, [on, alarm?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return [blocked && on, start];
}

export default function AlarmOverlay({ lang, onShowRoute, onOpenPanel }: Props) {
  const { active, acked, ack, identity, skew } = useAlarms();
  const show = !!active && !acked;
  const [blocked, startSound] = useAlarmSound(active, show);
  const elapsed = useElapsed(active?.at, skew);
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // focus: into the dialog when it opens, back where it was after the acknowledgement
  useEffect(() => {
    if (!show) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => title.current?.focus(), 30);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      html.style.overflow = prev;
      if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
    };
  }, [show, active?.id]);

  // banner after ack: push the sticky app header down
  const banner = !!active && acked;
  useEffect(() => {
    const html = document.documentElement;
    if (banner) html.dataset.alarmBanner = '1';
    else delete html.dataset.alarmBanner;
    return () => { delete html.dataset.alarmBanner; };
  }, [banner]);

  if (!active) return null;
  const drill = active.drill;
  const name = kindName(lang, active.kind);
  const zone = active.zone ? ZONE[active.zone] : null;
  // route: from the alarm zone, else from where this terminal stands
  const routeZone: ZoneId | null = active.zone ?? (isAlarmZone(identity.zone) ? identity.zone : null);

  if (banner) {
    return (
      <div className="alarm-banner fixed inset-x-0 top-0 z-[60] flex items-center gap-3 px-4" role="status" data-drill={drill || undefined}>
        <span className="tech-title shrink-0 text-lg text-paper">{drill ? L(lang, 'Ćwiczenie', 'Drill') : L(lang, 'Alarm', 'Alarm')}</span>
        <span className="min-w-0 truncate text-sm font-semibold">
          {name}{zone ? ` · ${tx(lang, zone.name)}` : ''}
        </span>
        <span className="ml-auto shrink-0 text-sm font-semibold tabular-nums" aria-label={L(lang, 'Czas od ogłoszenia', 'Time since raised')}>
          {clock(elapsed)}
        </span>
        {onOpenPanel && (
          <button type="button" onClick={onOpenPanel}
                  className="tap shrink-0 rounded-card border border-current px-3 text-sm font-semibold">
            {L(lang, 'Szczegóły', 'Details')}
          </button>
        )}
      </div>
    );
  }

  function acknowledge() { ack(); }
  function route() {
    if (routeZone) onShowRoute?.(routeZone, active!.blocked);
    ack();
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (drill) acknowledge(); // a real alarm is never dismissed with Escape
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hasAttribute('disabled'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const actions = actionsFor(active.kind);
  return createPortal(
    <div ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="alarm-title" aria-describedby="alarm-desc"
         onKeyDown={onKey} lang={lang === 'pl' ? 'pl' : 'en'}
         data-real={!drill || undefined} data-drill={drill || undefined}
         className="alarm-overlay alarm-enter fixed inset-0 z-[100] overflow-y-auto text-ink">
      <div className="alarm-stripe sticky top-0 z-10 flex min-h-[56px] items-center justify-center px-4 text-center"
           data-drill={drill || undefined} data-pulse="">
        <span className="tech-title text-[1.375rem] tracking-[0.12em] text-paper sm:text-[1.75rem]">
          {drill ? L(lang, 'Ćwiczenie · to nie jest prawdziwy alarm', 'Drill · this is not a real alarm')
                 : L(lang, 'Alarm rzeczywisty', 'Real alarm')}
        </span>
      </div>

      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 pb-10 pt-6">
        <p className="tech-kicker">
          {L(lang, 'System alarmowy · ogłosił', 'Alarm system · raised by')} {active.raisedBy} · {clock(elapsed)}
        </p>
        <h2 id="alarm-title" ref={title} tabIndex={-1}
            className="tech-title text-[clamp(2.75rem,10vw,5.5rem)] leading-[0.95] outline-none">
          {name}
        </h2>

        <div id="alarm-desc" className="flex flex-col gap-3">
          {zone && (
            <p className="text-lg font-semibold">
              {L(lang, 'Miejsce', 'Location')}: {tx(lang, zone.name)} <span className="font-normal text-ink-2">· {tx(lang, zone.deck)}</span>
            </p>
          )}
          {active.blocked && (
            <p className="text-lg font-semibold text-danger">
              {L(lang, 'Zablokowane', 'Blocked')}: {active.blocked === 'stair-aft' ? L(lang, 'schody rufowe', 'aft stairwell') : L(lang, 'schody dziobowe', 'forward stairwell')}
            </p>
          )}
          {active.message && <p className="panel p-4 text-lg">{active.message}</p>}
          <p className="text-sm text-ink-2">{L(lang, 'Sygnał', 'Signal')}: {signalFor(lang, active.kind)}</p>
        </div>

        {actions.length > 0 && (
          <section aria-labelledby="alarm-actions" className="panel p-4">
            <h3 id="alarm-actions" className="tech-kicker mb-2">{L(lang, 'Natychmiast', 'Immediately')}</h3>
            <ol className="flex flex-col gap-2">
              {actions.map((a, i) => (
                <li key={i} className="flex gap-3 text-base">
                  <span className="tech-title w-6 shrink-0 text-xl tabular-nums" aria-hidden="true">{i + 1}</span>
                  <span>{tx(lang, a)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {blocked && (
          <button type="button" onClick={startSound}
                  className="tap panel flex min-h-[48px] items-center justify-center gap-2 px-4 font-semibold hover:bg-paper-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
              <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
            </svg>
            {L(lang, 'Włącz dźwięk alarmu', 'Turn on the alarm sound')}
          </button>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={acknowledge} data-drill={drill || undefined}
                  className="alarm-btn-primary tap flex-1 rounded-card px-5 text-lg font-bold uppercase tracking-[0.06em]">
            {L(lang, 'Potwierdzam', 'Acknowledge')}
          </button>
          {routeZone && onShowRoute && (
            <button type="button" onClick={route}
                    className="tap flex min-h-[56px] flex-1 items-center justify-center rounded-card border-2 border-ok bg-paper px-5 text-lg font-bold text-ok hover:bg-paper-2">
              {L(lang, 'Pokaż drogę ewakuacji', 'Show escape route')}
            </button>
          )}
        </div>
        <p className="text-xs text-ink-2">
          {drill
            ? L(lang, 'Ćwiczenie: działaj jak przy prawdziwym alarmie. Potwierdzenie trafia na mostek z czasem reakcji.',
                'Drill: act as in a real alarm. Your acknowledgement reaches the bridge with the reaction time.')
            : L(lang, 'Potwierdzenie trafia na mostek. Wykonuj polecenia kapitana i Rozkład alarmowy (Muster List).',
                'Your acknowledgement reaches the bridge. Follow the master\'s orders and the Muster List.')}
          {' '}{L(lang, 'Wersja demonstracyjna, nie zastępuje instalacji alarmowej statku.', 'Demo version, does not replace the ship\'s alarm installation.')}
        </p>
      </div>
    </div>,
    document.body,
  );
}
