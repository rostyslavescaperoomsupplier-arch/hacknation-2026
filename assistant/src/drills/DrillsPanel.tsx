// "Ćwiczenia" tab: drill cards, phased checklist with a drill timer, alarm signal playback,
// evacuation route hand-off and a local drill log (localStorage, CSV export).
// TRAINING material based on general SOLAS / IMO practice; the ship's Muster List and SMS take precedence.
import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../types';
import type { ZoneId } from '../ship/routes';
import Icon from '../icons/Icon';
import { DISCLAIMER, DRILLS, DRILL_BY_ID, type DrillId, type Txt } from './data';
import { describePattern, playAlarm, stopAlarm } from './alarm';

type Blocked = 'stair-aft' | 'stair-fwd' | null;
interface Props { lang: Lang; drill?: DrillId | null; onShowRoute(zone: ZoneId, blocked?: Blocked): void }

interface LogEntry { id: string; drill: DrillId; date: string; durationMs: number; ticked: number; total: number; notes: string }

const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);
const tx = (lang: Lang, t: Txt) => (lang === 'pl' ? t.pl : t.en);
const LOG_KEY = 'ju-drill-log';

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function loadLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as LogEntry[]) : [];
  } catch { return []; }
}
function saveLog(log: LogEntry[]) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* private mode / quota */ }
}

const fmtDate = (iso: string, lang: Lang) => {
  try { return new Date(iso).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return iso; }
};

function exportCsv(log: LogEntry[], lang: Lang) {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const head = lang === 'pl'
    ? ['Ćwiczenie', 'Data', 'Czas trwania', 'Wykonane', 'Wszystkie', 'Uwagi']
    : ['Drill', 'Date', 'Duration', 'Done', 'Total', 'Notes'];
  const rows = log.map((e) => [tx(lang, DRILL_BY_ID[e.drill]?.title ?? { pl: e.drill, en: e.drill }), e.date, mmss(e.durationMs), e.ticked, e.total, e.notes]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dziennik-cwiczen-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BackIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
    <path d="M14.5 7.5 9 12l5.5 4.5" />
  </svg>
);

export default function DrillsPanel({ lang, drill, onShowRoute }: Props) {
  const [openId, setOpenId] = useState<DrillId | null>(drill ?? null);
  const [checked, setChecked] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [acc, setAcc] = useState(0);
  const [startAt, setStartAt] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notes, setNotes] = useState('');
  const [live, setLive] = useState('');
  const [log, setLog] = useState<LogEntry[]>(() => loadLog());
  const headRef = useRef<HTMLHeadingElement>(null);
  const logRef = useRef<HTMLHeadingElement>(null);
  const lastCard = useRef<DrillId | null>(null);
  const focusAfter = useRef<'drill' | 'log' | 'card' | null>(drill ? 'drill' : null);

  const d = openId ? DRILL_BY_ID[openId] : null;
  const elapsed = acc + (running ? Math.max(0, now - startAt) : 0);
  const total = d ? d.phases.reduce((n, p) => n + p.items.length, 0) : 0;
  const ticked = Object.keys(checked).length;
  /** the first unticked checklist item: what the sticky bar offers as the next action */
  const next = (() => {
    if (!d) return null;
    for (let pi = 0; pi < d.phases.length; pi++) {
      const p = d.phases[pi];
      for (let ii = 0; ii < p.items.length; ii++) {
        const key = `${pi}-${ii}`;
        if (!(key in checked)) return { key, text: tx(lang, p.items[ii]), phase: `${pi + 1}. ${tx(lang, p.title)}` };
      }
    }
    return null;
  })();

  function resetRun() {
    setChecked({}); setRunning(false); setAcc(0); setStartAt(0); setNotes('');
    stopAlarm(); setPlaying(false);
  }
  function open(id: DrillId | null, focus: 'drill' | 'log' | 'card' = 'drill') {
    resetRun();
    if (id) lastCard.current = id;
    focusAfter.current = id ? 'drill' : focus;
    setOpenId(id);
  }

  // deep link from the assistant ([[DRILL:id]])
  useEffect(() => { if (drill && drill !== openId) open(drill); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [drill]);

  // focus management after a view change
  useEffect(() => {
    const f = focusAfter.current;
    focusAfter.current = null;
    if (f === 'drill') headRef.current?.focus();
    else if (f === 'log') logRef.current?.focus();
    else if (f === 'card' && lastCard.current) document.getElementById(`drill-card-${lastCard.current}`)?.focus();
  }, [openId]);

  // display tick only while running
  useEffect(() => {
    if (!running) return;
    setNow(performance.now());
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => () => stopAlarm(), []);

  function start() {
    const t = performance.now();
    setStartAt(t); setNow(t); setRunning(true);
    setLive(L(lang, `Stoper uruchomiony, ${mmss(acc)}`, `Timer started, ${mmss(acc)}`));
  }
  function pause() {
    const t = performance.now();
    setAcc((a) => a + (t - startAt)); setRunning(false);
    setLive(L(lang, `Stoper zatrzymany na ${mmss(acc + t - startAt)}`, `Timer paused at ${mmss(acc + t - startAt)}`));
  }
  function reset() {
    setRunning(false); setAcc(0); setStartAt(0);
    setLive(L(lang, 'Stoper wyzerowany', 'Timer reset'));
  }

  function toggle(key: string) {
    const n = { ...checked };
    if (key in n) delete n[key];
    else {
      n[key] = elapsed;
      if (!running && elapsed === 0) start(); // first tick starts the drill clock
    }
    setChecked(n);
  }

  function signal() {
    if (!d) return;
    if (playing) { stopAlarm(); setPlaying(false); return; }
    const ok = playAlarm(d.alarm, () => setPlaying(false));
    setPlaying(ok);
    if (!ok) setLive(L(lang, 'Dźwięk niedostępny w tej przeglądarce', 'Audio not available in this browser'));
  }

  function finish() {
    if (!d) return;
    const entry: LogEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      drill: d.id, date: new Date().toISOString(), durationMs: Math.round(elapsed), ticked, total, notes: notes.trim(),
    };
    const next = [entry, ...log];
    setLog(next); saveLog(next);
    setLive(L(lang, `Zapisano ćwiczenie: ${tx(lang, d.title)}, ${mmss(elapsed)}`, `Drill saved: ${tx(lang, d.title)}, ${mmss(elapsed)}`));
    open(null, 'log');
  }

  function clearLog() {
    if (!window.confirm(L(lang, 'Usunąć cały dziennik ćwiczeń z tego urządzenia?', 'Delete the whole drill log from this device?'))) return;
    setLog([]); saveLog([]);
    setLive(L(lang, 'Dziennik wyczyszczony', 'Log cleared'));
  }

  const btn = 'tap inline-flex items-center justify-center gap-2 rounded-card px-4 font-semibold';
  const btnLine = `${btn} border border-ink/40 bg-paper text-ink hover:bg-paper-2`;

  return (
    <section className="mx-auto w-full max-w-5xl text-ink" aria-labelledby="drills-h">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{live}</p>

      <header className={d ? 'sr-only' : 'mb-4'}>
        <p className="tech-kicker">{L(lang, 'Szkolenie załogi', 'Crew training')}</p>
        <h2 id="drills-h" className="tech-title text-h2">{L(lang, 'Ćwiczenia alarmowe', 'Emergency drills')}</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-ink-2">{tx(lang, DISCLAIMER)}</p>
      </header>

      {!d && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" role="list">
          {DRILLS.map((x) => (
            <li key={x.id}>
              <button id={`drill-card-${x.id}`} type="button" onClick={() => open(x.id)}
                      className={`panel group flex h-full min-h-[8.5rem] w-full flex-col gap-2 p-4 text-left hover:bg-paper-2 ${x.danger ? 'border-danger' : ''}`}>
                <span className="flex w-full items-start justify-between gap-2">
                  <span className={`tech-title flex items-center gap-2.5 text-[1.375rem] ${x.danger ? 'text-danger' : ''}`}>
                    <span aria-hidden="true" className={`mark ${x.danger ? 'mark-tri' : 'mark-sq'}`} />{tx(lang, x.title)}
                  </span>
                  <Icon name="chevron-right" size={22} className="mt-0.5 shrink-0 text-ink-2 transition-transform group-hover:translate-x-0.5" />
                </span>
                {x.danger && <span className="sr-only">{L(lang, 'Zagrożenie życia. ', 'Danger to life. ')}</span>}
                <span className="text-[0.9375rem] leading-snug">{tx(lang, x.summary)}</span>
                <span className="mt-auto text-sm text-ink-2">
                  <span className="font-semibold">{L(lang, 'Sygnał: ', 'Signal: ')}</span>
                  {x.alarm.demo ? L(lang, 'komunikat / wg Rozkładu alarmowego', 'announcement / per Muster List') : describePattern(x.alarm)}
                  {x.alarm.bells && L(lang, ' + dzwonki', ' + bells')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {d && (
        <article aria-labelledby="drill-h" className="space-y-4">
          <button type="button" onClick={() => open(null, 'card')} className={`${btn} -ml-2 bg-transparent px-2 text-ink-2 hover:text-ink`}>
            <BackIcon />{L(lang, 'Wszystkie ćwiczenia', 'All drills')}
          </button>
          {/* containing block of the sticky next-step bar: from the title to the end of the checklist,
              so the bar is on screen from the first view and leaves once the checklist is scrolled past */}
          <div className="space-y-4">
          <div>
            <p className="tech-kicker flex items-center gap-2">
              <span aria-hidden="true" className={`mark ${d.danger ? 'mark-tri' : 'mark-sq'}`} />
              {L(lang, 'Ćwiczenie', 'Drill')}{d.danger ? L(lang, ' · zagrożenie życia', ' · danger to life') : ''}
            </p>
            <h3 id="drill-h" ref={headRef} tabIndex={-1} className={`tech-title text-h2 outline-none ${d.danger ? 'text-danger' : ''}`}>{tx(lang, d.title)}</h3>
            <p className="mt-1 max-w-[65ch] text-ink-2">{tx(lang, d.summary)}</p>
          </div>

          {/* the two things a drill leader reaches for first: the alarm and the escape route */}
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="panel flex flex-col gap-2 p-4" aria-labelledby="sig-h">
              <h4 id="sig-h" className="tech-title text-lg">{L(lang, 'Sygnał alarmowy', 'Alarm signal')}</h4>
              <p className="text-[0.9375rem] leading-snug">{tx(lang, d.signal)}</p>
              <p className="text-sm text-ink-2">
                {L(lang, 'Wzór: ', 'Pattern: ')}<span className="font-semibold text-ink">{describePattern(d.alarm)}</span>{d.alarm.bells && L(lang, ' + dzwonki alarmowe', ' + alarm bells')}
                {d.alarm.demo && L(lang, ' (demonstracja)', ' (demo)')}
              </p>
              <button type="button" onClick={signal} aria-pressed={playing}
                      className={`${btn} tap-lg mt-auto w-full ${playing ? 'border-2 border-ink bg-paper text-ink' : `${d.danger ? 'bg-danger' : 'bg-gold-ink'} text-on-strong`}`}>
                <Icon name={playing ? 'stop' : 'volume'} size={20} />
                {playing ? L(lang, 'Zatrzymaj sygnał', 'Stop signal') : L(lang, 'Odtwórz sygnał', 'Play signal')}
              </button>
            </section>
            {d.zone ? (
              <section className="panel flex flex-col gap-2 p-4" aria-labelledby="route-h">
                <h4 id="route-h" className="tech-title text-lg">{L(lang, 'Droga ewakuacji', 'Escape route')}</h4>
                {d.scenario && <p className="text-[0.9375rem] leading-snug">{tx(lang, d.scenario)}</p>}
                <button type="button" onClick={() => onShowRoute(d.zone as ZoneId, d.blocked)} className={`${btn} tap-lg mt-auto w-full bg-ok text-on-strong`}>
                  {L(lang, 'Pokaż drogę ewakuacji', 'Show escape route')}<Icon name="arrow-right" size={20} />
                </button>
              </section>
            ) : (
              <section className="panel bg-paper-2 p-4" aria-labelledby="freq-h">
                <h4 id="freq-h" className="tech-title text-lg">{L(lang, 'Częstotliwość ćwiczeń', 'Drill frequency')}</h4>
                <p className="mt-1 text-[0.9375rem] leading-snug">{tx(lang, d.frequency)}</p>
              </section>
            )}
          </div>

          {/* timer + checklist + the sticky next-step bar */}
            <div className="panel flex flex-wrap items-center gap-3 p-4">
              <div className="mr-auto">
                <p className="tech-kicker">{L(lang, 'Czas ćwiczenia', 'Drill time')}</p>
                <p className="font-display text-5xl font-bold tabular-nums leading-none" aria-label={L(lang, `Czas ćwiczenia ${mmss(elapsed)}`, `Drill time ${mmss(elapsed)}`)}>
                  {mmss(elapsed)}
                </p>
              </div>
              <div className="flex gap-2">
                {running
                  ? <button type="button" onClick={pause} className={`${btnLine} tap-lg`}><Icon name="stop" size={18} />{L(lang, 'Pauza', 'Pause')}</button>
                  : <button type="button" onClick={start} className={`${btn} tap-lg bg-gold-ink text-on-strong`}>
                      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4.5v15L19.5 12Z" fill="currentColor" /></svg>
                      {elapsed > 0 ? L(lang, 'Wznów', 'Resume') : L(lang, 'Start', 'Start')}
                    </button>}
                <button type="button" onClick={reset} disabled={elapsed === 0 && !running} className={`${btnLine} tap-lg disabled:opacity-50`}>{L(lang, 'Zeruj', 'Reset')}</button>
              </div>
            </div>

            <section className="panel p-4" aria-labelledby="check-h">
              <div className="flex items-baseline justify-between gap-2">
                <h4 id="check-h" className="tech-title text-xl">{L(lang, 'Lista kontrolna', 'Checklist')}</h4>
                <span className="text-sm font-semibold tabular-nums text-ink-2">{ticked}/{total}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-2" aria-hidden="true">
                <div className="h-full bg-ok transition-[width] duration-300" style={{ width: `${total ? (ticked / total) * 100 : 0}%` }} />
              </div>
              {d.phases.map((p, pi) => (
                <fieldset key={p.id} className="mt-4">
                  <legend className="mb-1 flex items-center gap-2 font-display text-base font-bold uppercase tracking-[0.04em]">
                    <span aria-hidden="true" className={`inline-flex size-6 items-center justify-center rounded-sm text-[0.8rem] text-on-strong ${d.danger ? 'bg-danger' : 'bg-gold-ink'}`}>{pi + 1}</span>
                    {tx(lang, p.title)}
                  </legend>
                  <ul className="divide-y divide-line border-y border-line">
                    {p.items.map((it, ii) => {
                      const key = `${pi}-${ii}`;
                      const on = key in checked;
                      const isNext = next?.key === key;
                      return (
                        <li key={key} id={`drill-item-${key}`} className={isNext ? 'bg-paper-2' : ''}>
                          <label className="tap-lg flex cursor-pointer items-center gap-3 px-1 py-2.5">
                            <input type="checkbox" checked={on} onChange={() => toggle(key)} className="chk" />
                            <span className={`min-w-0 flex-1 leading-snug ${on ? 'text-ink-2 line-through decoration-ink-2/60' : ''} ${isNext ? 'font-semibold' : ''}`}>{tx(lang, it)}</span>
                            {on && <span className="shrink-0 text-sm font-semibold tabular-nums text-ok">
                              <span className="sr-only">{L(lang, 'wykonano o ', 'done at ')}</span>{mmss(checked[key])}
                            </span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
            </section>

            <div className="next-bar panel flex items-center gap-3 border-ink/40 p-3" role="group" aria-label={L(lang, 'Następny krok', 'Next step')}>
              {next ? (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="tech-kicker flex items-baseline gap-2">
                      <span className="shrink-0">{L(lang, 'Następny krok', 'Next step')}</span>
                      <span aria-hidden="true" className="font-display text-base font-bold tabular-nums tracking-normal text-ink">{mmss(elapsed)}</span>
                      <span className="hidden truncate sm:inline">· {next.phase}</span>
                    </p>
                    <p className="line-clamp-2 font-semibold leading-snug">{next.text}</p>
                  </div>
                  <button type="button" onClick={() => toggle(next.key)} className={`${btn} tap-lg shrink-0 bg-ok px-3 text-on-strong sm:px-4`}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                    {L(lang, 'Wykonane', 'Done')}
                  </button>
                </>
              ) : (
                <>
                  <p className="min-w-0 flex-1 font-semibold leading-snug text-ok">
                    {L(lang, 'Wszystkie kroki wykonane', 'All steps done')} <span className="font-display tabular-nums">{mmss(elapsed)}</span>
                  </p>
                  <button type="button" onClick={() => { const n = document.getElementById('drill-notes'); n?.scrollIntoView({ block: 'center' }); n?.focus({ preventScroll: true }); }}
                          className={`${btn} tap-lg shrink-0 bg-navy text-on-strong`}>
                    {L(lang, 'Omówienie', 'Debrief')}<Icon name="arrow-right" size={18} />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* roles */}
          <section className="panel p-4" aria-labelledby="roles-h">
            <h4 id="roles-h" className="tech-title text-lg">{L(lang, 'Zespoły i funkcje', 'Teams and roles')}</h4>
            <dl className="mt-2 divide-y divide-line">
              {d.roles.map((r, i) => (
                <div key={i} className="py-2.5 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-3">
                  <dt className="font-semibold">{tx(lang, r.name)}</dt>
                  <dd className="text-[0.9375rem] text-ink-2">{tx(lang, r.task)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {d.zone && (
            <section className="panel bg-paper-2 p-4" aria-labelledby="freq-h">
              <h4 id="freq-h" className="tech-kicker">{L(lang, 'Częstotliwość ćwiczeń', 'Drill frequency')}</h4>
              <p className="mt-1 text-[0.9375rem]">{tx(lang, d.frequency)}</p>
            </section>
          )}

          {/* debrief */}
          <section className="panel p-4" aria-labelledby="deb-h">
            <h4 id="deb-h" className="tech-title text-lg">{L(lang, 'Omówienie po ćwiczeniu', 'Debrief')}</h4>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[0.9375rem]">
              {d.debrief.map((q, i) => <li key={i}>{tx(lang, q)}</li>)}
            </ol>
            <label htmlFor="drill-notes" className="tech-kicker mt-4 block">{L(lang, 'Uwagi', 'Notes')}</label>
            <textarea id="drill-notes" value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 2000))} rows={3}
                      placeholder={L(lang, 'Co poszło dobrze, co poprawić', 'What went well, what to improve')}
                      className="mt-1 w-full rounded-card border border-ink/40 bg-paper p-3 text-ink" />
            <button type="button" onClick={finish} className={`${btn} tap-lg mt-3 w-full bg-navy text-on-strong sm:w-auto`}>
              {L(lang, 'Zakończ i zapisz ćwiczenie', 'Finish and save drill')}
            </button>
            <p className="mt-1 text-sm text-ink-2">{L(lang, 'Zapis trafia do dziennika na tym urządzeniu.', 'Saved to the log on this device.')}</p>
          </section>
        </article>
      )}

      {/* log */}
      {(log.length > 0 || !d) && (
        <section className="panel mt-4 p-4" aria-labelledby="log-h">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="log-h" ref={logRef} tabIndex={-1} className="tech-title mr-auto text-lg outline-none">{L(lang, 'Dziennik ćwiczeń', 'Drill log')}</h3>
            {log.length > 0 && <>
              <button type="button" onClick={() => exportCsv(log, lang)} className={btnLine}>{L(lang, 'Eksport CSV', 'Export CSV')}</button>
              <button type="button" onClick={clearLog} className={`${btnLine} text-danger`}>{L(lang, 'Wyczyść', 'Clear')}</button>
            </>}
          </div>
          {log.length === 0
            ? <p className="mt-2 text-sm text-ink-2">{L(lang, 'Brak zapisanych ćwiczeń. Otwórz ćwiczenie i zakończ je, aby dodać wpis.', 'No drills saved yet. Open a drill and finish it to add an entry.')}</p>
            : <ul className="mt-2 divide-y divide-line" role="list">
                {log.map((e) => {
                  const x = DRILL_BY_ID[e.drill];
                  return (
                    <li key={e.id} className="py-2 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className={`font-semibold ${x?.danger ? 'text-danger' : ''}`}>{x ? tx(lang, x.title) : e.drill}</span>
                        <span className="text-sm text-ink-2">{fmtDate(e.date, lang)}</span>
                        <span className="ml-auto text-sm tabular-nums text-ink-2">{mmss(e.durationMs)} · {e.ticked}/{e.total}</span>
                      </div>
                      {e.notes && <p className="mt-0.5 whitespace-pre-line text-sm text-ink-2">{e.notes}</p>}
                    </li>
                  );
                })}
              </ul>}
        </section>
      )}
    </section>
  );
}
