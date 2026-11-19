// Header button of the anti-seasickness system: a small horizon that tilts with the ship (so people notice the
// system exists and that it follows the motion) and a panel that explains it, shows the sea state and recalibrates.
// The cues themselves are always on (MotionCues.tsx); this only makes them visible and explainable.
import { useEffect, useId, useRef, useState } from 'react';
import type { Lang } from '../types';
import { getSeaState, peekMotion, recalibrate, type SeaState } from './sensors';

const T = {
  pl: {
    btn: 'System przeciw chorobie morskiej', title: 'Przeciw chorobie morskiej',
    how: 'Kropki i pomarańczowe kreski przy krawędziach ekranu ruszają się razem ze statkiem. Patrz na nie kątem oka: oczy widzą to samo kołysanie, które czuje błędnik, więc mdłości są słabsze.',
    always: 'Zawsze włączone. Siła wskazówek rośnie, gdy morze jest mocniejsze.',
    level: { spokojnie: 'spokojne', umiarkowanie: 'umiarkowane', silnie: 'silne' }, sea: 'Morze', roll: 'przechył',
    src: { sensor: 'czujnik tego urządzenia', ship: 'czujnik statku', sim: 'symulacja (urządzenie bez czujnika ruchu)' }, from: 'Źródło',
    cal: 'Skalibruj (wyzeruj przechył)', calDone: 'Wyzerowano', close: 'Zamknij',
  },
  en: {
    btn: 'Anti-seasickness system', title: 'Against seasickness',
    how: 'The dots and orange lines at the screen edges move with the ship. Watch them from the corner of your eye: your eyes see the same motion your inner ear feels, so nausea is weaker.',
    always: 'Always on. The cues get stronger when the sea is rougher.',
    level: { spokojnie: 'calm', umiarkowanie: 'moderate', silnie: 'rough' }, sea: 'Sea', roll: 'roll',
    src: { sensor: 'this device’s sensor', ship: 'ship sensor', sim: 'simulation (no motion sensor here)' }, from: 'Source',
    cal: 'Recalibrate (zero the roll)', calDone: 'Zeroed', close: 'Close',
  },
};

export default function MotionBadge({ lang }: { lang: Lang }) {
  const t = lang === 'pl' ? T.pl : T.en;
  const [roll, setRoll] = useState(0);
  const [sea, setSea] = useState<SeaState>(() => getSeaState());
  const [open, setOpen] = useState(false);
  const [cal, setCal] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  // ~8 updates / s is enough for a 20 px icon; stops when the tab is hidden
  useEffect(() => {
    const iv = setInterval(() => { if (!document.hidden) { setRoll(peekMotion().roll); setSea(getSeaState()); } }, 125);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', out); addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', out); removeEventListener('keydown', esc); };
  }, [open]);
  // the icon exaggerates the tilt (x2) so a 3 deg roll is visible on a 20 px glyph; the world stays level: -roll
  const deg = Math.max(-35, Math.min(35, -roll * 2));
  const strong = sea.level !== 'spokojnie';
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} title={t.btn} aria-label={t.btn}
              className={`hdr-btn tap inline-flex items-center justify-center gap-1.5 rounded-card border bg-paper px-2.5 text-sm font-semibold uppercase ${strong ? 'border-gold text-ink' : 'border-line text-ink-2 hover:text-ink'}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: '12px 12px', transition: 'transform 120ms linear' }}>
            <path d="M3.5 12h17" stroke="var(--c-gold)" strokeWidth="2.6" strokeLinecap="round" />
            <path d="M8 15.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".6" />
          </g>
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={t.title}
             className="panel fixed inset-x-4 top-[4.25rem] z-50 flex flex-col gap-3 p-4 text-sm normal-case sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
          <p className="tech-title text-lg">{t.title}</p>
          <p>{t.how}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-2">{t.sea}</dt>
            <dd className="font-semibold">{t.level[sea.level]} · {t.roll} ±{sea.roll.toFixed(1)}°</dd>
            <dt className="text-ink-2">{t.from}</dt>
            <dd>{t.src[sea.source]}</dd>
          </dl>
          <p className="text-ink-2">{t.always}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => { recalibrate(); setCal(true); setTimeout(() => setCal(false), 1500); }}
                    className="tap flex-1 rounded-card border border-ink px-3 font-semibold">{cal ? t.calDone : t.cal}</button>
            <button type="button" onClick={() => setOpen(false)} className="tap rounded-card border border-line px-3">{t.close}</button>
          </div>
        </div>
      )}
    </div>
  );
}
