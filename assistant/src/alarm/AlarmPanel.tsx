/** "Alarmy" tab: bridge console (raise / end, acknowledgements with reaction times, muster accountability),
 *  crew status (current alarm, report a headcount), the alarm log with CSV export and the terminal settings.
 *  The bridge console needs a logged-in bridge officer or the master (src/auth, docs/ACCOUNTS.md); the role is checked
 *  again by the server on every raise / end. Everybody else sees the status and can acknowledge. */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { Lang } from '../types';
import { MUSTER, ZONE, ZONES } from '../ship/routes';
import {
  ALARM_KINDS, HEADCOUNT_MAX, MESSAGE_MAX, NAME_MAX, USER_MAX,
  type Alarm, type AlarmErrorCode, type AlarmKind, type AlarmZone, type BlockedStair, type TerminalRole, type TerminalZone,
} from '../../shared/alarms';
import { useAlarms, useElapsed } from './AlarmProvider';
import { useAuthOptional } from '../auth/AuthProvider';
import RoleBadge from '../auth/RoleBadge';
import { L, clock, kindName, reaction, tx } from './kinds';
import './alarm.css';

const BOAT_DECK = { pl: 'Pokład szalupowy (stacja ratunkowa)', en: 'Boat deck (muster station)' };
const zoneLabel = (lang: Lang, z: TerminalZone | null | undefined) =>
  !z ? '' : z === 'boat-deck' ? tx(lang, BOAT_DECK) : tx(lang, ZONE[z].name);
const stairLabel = (lang: Lang, s: BlockedStair | null) =>
  s === 'stair-aft' ? L(lang, 'schody rufowe', 'aft stairwell') : s === 'stair-fwd' ? L(lang, 'schody dziobowe', 'forward stairwell') : '';
const time = (lang: Lang, iso: string) => new Date(iso).toLocaleTimeString(lang === 'pl' ? 'pl-PL' : 'en-GB');
const dateTime = (lang: Lang, iso: string) => new Date(iso).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB');

const ERRORS: Record<AlarmErrorCode | 'offline', [string, string]> = {
  offline: ['Brak połączenia z centralą. Ponawiam…', 'No connection to the alarm server. Retrying…'],
  forbidden: ['Alarmy ogłasza i kończy tylko zalogowany oficer mostka albo kapitan.', 'Only a logged-in bridge officer or the master can raise or end alarms.'],
  confirm: ['Prawdziwy alarm wymaga potwierdzenia.', 'A real alarm needs confirmation.'],
  'no-alarm': ['Ten alarm nie jest już aktywny.', 'This alarm is no longer active.'],
  rate: ['Za dużo poleceń naraz. Odczekaj chwilę.', 'Too many commands. Wait a moment.'],
  'too-long': [`Komunikat może mieć najwyżej ${MESSAGE_MAX} znaków.`, `The message may have at most ${MESSAGE_MAX} characters.`],
  invalid: ['Nieprawidłowe dane.', 'Invalid data.'],
  json: ['Błąd komunikacji.', 'Communication error.'],
  unknown: ['Błąd komunikacji.', 'Communication error.'],
  'not-hello': ['Terminal jeszcze się nie przedstawił centrali.', 'The terminal has not introduced itself yet.'],
  'hello-twice': ['Błąd komunikacji.', 'Communication error.'],
};

/** Zones grouped by deck for <select>. */
function ZoneOptions({ lang, boatDeck }: { lang: Lang; boatDeck?: boolean }) {
  const groups = new Map<string, typeof ZONES>();
  for (const z of ZONES) {
    const k = tx(lang, z.deck);
    groups.set(k, [...(groups.get(k) ?? []), z]);
  }
  return (
    <>
      {[...groups].map(([deck, zs]) => (
        <optgroup key={deck} label={deck}>
          {zs.map((z) => <option key={z.id} value={z.id}>{tx(lang, z.name)}</option>)}
        </optgroup>
      ))}
      {boatDeck && <optgroup label={L(lang, 'Pokład 5', 'Deck 5')}><option value="boat-deck">{tx(lang, BOAT_DECK)}</option></optgroup>}
    </>
  );
}

const field = 'tap w-full rounded-card border border-line bg-paper px-3 text-base text-ink';

// ---------------------------------------------------------------------------------------------------------------
function RaiseForm({ lang }: { lang: Lang }) {
  const { raise, active, conn } = useAlarms();
  const [kind, setKind] = useState<AlarmKind>('general');
  const [zone, setZone] = useState<AlarmZone | ''>('');
  const [blocked, setBlocked] = useState<BlockedStair | ''>('');
  const [message, setMessage] = useState('');
  const [drill, setDrill] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const ids = useId();

  useEffect(() => { setConfirming(false); }, [kind, zone, blocked, drill]);

  function send(confirm: boolean) {
    const ok = raise({ kind, zone: zone || null, blocked: blocked || null, message: message.trim(), drill, ...(confirm ? { confirm: true } : {}) });
    if (ok) { setConfirming(false); setMessage(''); }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (drill) send(false);
    else setConfirming(true);
  }

  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 p-4" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="tech-title text-xl">{L(lang, 'Ogłoś alarm', 'Raise an alarm')}</h3>

      <fieldset>
        <legend className="tech-kicker mb-2">{L(lang, 'Rodzaj alarmu', 'Alarm type')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ALARM_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                    className="alarm-kind tap min-h-[52px] rounded-card border border-line bg-paper px-3 text-left text-sm font-semibold hover:bg-paper-2">
              {kindName(lang, k)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="tech-kicker">{L(lang, 'Miejsce zdarzenia', 'Location')}</span>
          <select className={field} value={zone} onChange={(e) => setZone(e.target.value as AlarmZone | '')}>
            <option value="">{L(lang, 'Bez strefy (cały statek)', 'No zone (whole ship)')}</option>
            <ZoneOptions lang={lang} />
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="tech-kicker">{L(lang, 'Zablokowana klatka', 'Blocked stairwell')}</span>
          <select className={field} value={blocked} onChange={(e) => setBlocked(e.target.value as BlockedStair | '')}>
            <option value="">{L(lang, 'Żadna', 'None')}</option>
            <option value="stair-aft">{stairLabel(lang, 'stair-aft')}</option>
            <option value="stair-fwd">{stairLabel(lang, 'stair-fwd')}</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="tech-kicker flex justify-between">
          <span>{L(lang, 'Komunikat', 'Message')}</span>
          <span className="tabular-nums" aria-hidden="true">{[...message].length}/{MESSAGE_MAX}</span>
        </span>
        <textarea className={`${field} min-h-[88px] py-2`} value={message} maxLength={MESSAGE_MAX}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={L(lang, 'np. Dym w kabinie 104, grupa pożarowa 1 na pokład 3', 'e.g. Smoke in cabin 104, fire team 1 to deck 3')} />
      </label>

      <fieldset>
        <legend className="tech-kicker mb-2">{L(lang, 'Tryb', 'Mode')}</legend>
        <div className="grid grid-cols-2 overflow-hidden rounded-card border border-line">
          <button type="button" aria-pressed={drill} data-drill="" onClick={() => setDrill(true)}
                  className="alarm-seg tap min-h-[52px] bg-paper font-semibold">{L(lang, 'Ćwiczenie', 'Drill')}</button>
          <button type="button" aria-pressed={!drill} data-real="" onClick={() => setDrill(false)}
                  className="alarm-seg tap min-h-[52px] border-l border-line bg-paper font-semibold">{L(lang, 'Prawdziwy', 'Real')}</button>
        </div>
      </fieldset>

      {active && (
        <p className="text-sm text-ink-2">
          {L(lang, 'Aktywny alarm zostanie zastąpiony nowym i zapisany w dzienniku.', 'The active alarm will be replaced and kept in the log.')}
        </p>
      )}

      {!confirming ? (
        <button type="submit" disabled={conn !== 'online'} data-drill={drill || undefined}
                className="alarm-btn-primary tap rounded-card px-5 text-lg font-bold uppercase tracking-[0.06em] disabled:opacity-50">
          {drill ? L(lang, 'Ogłoś ćwiczenie', 'Raise drill') : L(lang, 'Ogłoś prawdziwy alarm', 'Raise real alarm')}
        </button>
      ) : (
        <div role="alertdialog" aria-labelledby={`${ids}-c`} className="flex flex-col gap-3 rounded-card border-2 border-danger p-4">
          <p id={`${ids}-c`} className="font-semibold">
            {L(lang, `Ogłosić PRAWDZIWY alarm „${kindName(lang, kind)}” na wszystkich terminalach statku?`,
                     `Raise a REAL "${kindName(lang, kind)}" alarm on every terminal on board?`)}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" autoFocus onClick={() => setConfirming(false)}
                    className="tap min-h-[52px] flex-1 rounded-card border border-line bg-paper px-4 font-semibold hover:bg-paper-2">
              {L(lang, 'Anuluj', 'Cancel')}
            </button>
            <button type="button" onClick={() => send(true)}
                    className="alarm-btn-primary tap flex-1 rounded-card px-4 font-bold uppercase">
              {L(lang, 'Tak, ogłoś alarm', 'Yes, raise the alarm')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function ActiveCard({ lang }: { lang: Lang }) {
  const { active, state, identity, skew, end, ack, acked, user: me } = useAlarms();
  const elapsed = useElapsed(active?.at, skew);
  const [ending, setEnding] = useState(false);
  const [user, setUser] = useState('');
  const [count, setCount] = useState('');
  const [sent, setSent] = useState(false);
  const ids = useId();
  useEffect(() => { setEnding(false); setSent(false); }, [active?.id]);

  const rows = useMemo(() => {
    if (!active) return [];
    const out = new Map<string, { id: string; name: string; zone: TerminalZone | null; role?: TerminalRole; online: boolean }>();
    for (const t of state?.terminals ?? []) out.set(t.terminalId, { id: t.terminalId, name: t.name, zone: t.zone, role: t.role, online: true });
    for (const [id, a] of Object.entries(active.acks)) if (!out.has(id)) out.set(id, { id, name: a.name, zone: a.zone ?? null, online: false });
    return [...out.values()].sort((a, b) => {
      const ta = active.acks[a.id]?.at ?? '~', tb = active.acks[b.id]?.at ?? '~';
      return ta === tb ? a.name.localeCompare(b.name, 'pl') : ta < tb ? -1 : 1;
    });
  }, [active, state?.terminals]);

  if (!active) {
    return (
      <section className="panel flex items-center gap-3 p-4" aria-live="polite">
        <span className="alarm-dot" data-on="" aria-hidden="true" />
        <p className="font-semibold">{L(lang, 'Brak aktywnego alarmu.', 'No active alarm.')}</p>
      </section>
    );
  }
  const bridge = identity.role === 'bridge';
  const ackCount = Object.keys(active.acks).length;
  const zone = active.zone ? ZONE[active.zone] : null;
  const muster = state?.muster;

  function report(e: FormEvent) {
    e.preventDefault();
    const n = count.trim() === '' ? undefined : Number(count);
    if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > HEADCOUNT_MAX)) return;
    if (ack({ user: user.trim() || undefined, headcount: n })) setSent(true);
  }

  return (
    <section className="panel flex flex-col gap-4 p-4" aria-labelledby={`${ids}-h`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-card px-2 py-1 text-xs font-bold uppercase tracking-[0.1em] text-paper ${active.drill ? 'bg-gold-ink' : 'bg-danger'}`}>
          {active.drill ? L(lang, 'Ćwiczenie', 'Drill') : L(lang, 'Alarm rzeczywisty', 'Real alarm')}
        </span>
        <span className="tech-kicker">{L(lang, 'od', 'since')} {time(lang, active.at)} · {active.raisedBy}</span>
        <span className="tech-title ml-auto text-2xl tabular-nums" aria-label={L(lang, 'Czas trwania', 'Duration')}>{clock(elapsed)}</span>
      </div>
      <h3 id={`${ids}-h`} className="tech-title text-[2rem]">{kindName(lang, active.kind)}</h3>
      {(zone || active.blocked) && (
        <p className="text-sm">
          {zone && <>{tx(lang, zone.name)} · {tx(lang, zone.deck)}</>}
          {active.blocked && <span className="font-semibold text-danger">{zone ? ' · ' : ''}{L(lang, 'zablokowane', 'blocked')}: {stairLabel(lang, active.blocked)}</span>}
        </p>
      )}
      {active.message && <p className="rounded-card bg-paper-2 p-3">{active.message}</p>}

      {!bridge && acked && (
        <form onSubmit={report} className="flex flex-col gap-2 rounded-card bg-paper-2 p-3">
          <p className="tech-kicker">{L(lang, 'Zgłoś stan osób przy tym terminalu', 'Report the headcount at this terminal')}</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            {me ? (
              // logged in: the server records who you are, no free text
              <p className="flex min-h-[48px] items-center gap-2 text-sm"><span className="text-ink-2">{L(lang, 'Zgłasza', 'Reported by')}:</span>
                <span className="font-semibold">{me.name}</span></p>
            ) : (
              <input className={field} value={user} maxLength={USER_MAX} onChange={(e) => setUser(e.target.value)}
                     aria-label={L(lang, 'Kto zgłasza', 'Reported by')} placeholder={L(lang, 'Kto zgłasza (imię, funkcja)', 'Reported by (name, role)')} />
            )}
            <input className={field} value={count} inputMode="numeric" pattern="[0-9]*" maxLength={3}
                   onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))}
                   aria-label={L(lang, 'Liczba osób', 'Number of people')} placeholder={L(lang, 'Osób', 'People')} />
            <button type="submit" className="tap min-h-[48px] rounded-card bg-navy px-4 font-semibold text-paper">{L(lang, 'Wyślij', 'Send')}</button>
          </div>
          {sent && <p role="status" className="text-sm text-ok">{L(lang, 'Zgłoszenie wysłane na mostek.', 'Report sent to the bridge.')}</p>}
        </form>
      )}

      <div>
        <h4 className="tech-kicker mb-2">
          {L(lang, 'Potwierdzenia', 'Acknowledgements')} · {ackCount}/{rows.length}
        </h4>
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const a = active.acks[r.id];
            return (
              <li key={r.id} className="flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="alarm-dot" data-on={a ? '' : undefined} data-warn={!a ? '' : undefined} aria-hidden="true" />
                <span className="font-semibold">{r.name}</span>
                {r.role === 'bridge' && <span className="tech-kicker">{L(lang, 'mostek', 'bridge')}</span>}
                <span className="text-sm text-ink-2">{zoneLabel(lang, r.zone)}</span>
                <span className="ml-auto text-sm tabular-nums">
                  {a ? (
                    <span className="text-ok">
                      {L(lang, 'potwierdził po', 'acknowledged after')} {reaction(Date.parse(a.at) - Date.parse(active.at))}
                      {a.user ? ` · ${a.user}` : ''}{a.headcount != null ? ` · ${a.headcount} ${L(lang, 'os.', 'ppl')}` : ''}
                    </span>
                  ) : <span className="font-semibold text-gold-ink">{L(lang, 'oczekuje', 'waiting')}</span>}
                  {!r.online && <span className="text-ink-2"> · {L(lang, 'offline', 'offline')}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {muster && (
        <div>
          <h4 className="tech-kicker mb-2">{L(lang, 'Rozliczenie stanu osób (punkty zbiórki)', 'Muster accountability')}</h4>
          {!muster.crewOnline && (
            <p className="mb-2 text-sm text-gold-ink">{L(lang, 'Brak połączenia z bazą załogi: liczba osób w strefach nieznana.', 'Crew database unavailable: people per zone unknown.')}</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-2 font-semibold">{L(lang, 'Strefa', 'Zone')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">{L(lang, 'Osoby w bazie', 'People (DB)')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">{L(lang, 'Terminale', 'Terminals')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">{L(lang, 'Potwierdzone', 'Acknowledged')}</th>
                  <th scope="col" className="py-2 pl-2 text-right font-semibold">{L(lang, 'Zgłoszone osoby', 'Reported')}</th>
                </tr>
              </thead>
              {muster.rows.map((row) => (
                <tbody key={row.station}>
                  <tr className="bg-paper-2">
                    <th scope="rowgroup" className="py-2 pr-2 text-left font-bold">{tx(lang, MUSTER[row.station].name)}</th>
                    <td className="px-2 text-right font-bold tabular-nums">{row.expected ?? '–'}</td>
                    <td className="px-2 text-right font-bold tabular-nums">{row.terminals}</td>
                    <td className="px-2 text-right font-bold tabular-nums">{row.acked}/{row.terminals}</td>
                    <td className={`pl-2 text-right font-bold tabular-nums ${row.expected != null && row.reported < row.expected ? 'text-gold-ink' : ''}`}>
                      {row.reported}{row.expected != null ? `/${row.expected}` : ''}
                    </td>
                  </tr>
                  {row.zones.length === 0 && (
                    <tr><td colSpan={5} className="py-2 text-ink-2">{L(lang, 'Brak osób ani terminali kierowanych tutaj.', 'Nobody and no terminal assigned here.')}</td></tr>
                  )}
                  {row.zones.map((z) => (
                    <tr key={z.zone} className="border-b border-line">
                      <th scope="row" className="py-2 pr-2 pl-3 text-left font-normal">{zoneLabel(lang, z.zone)}</th>
                      <td className="px-2 text-right tabular-nums">{z.expected ?? '–'}</td>
                      <td className="px-2 text-right tabular-nums">{z.terminals}</td>
                      <td className={`px-2 text-right tabular-nums ${z.acked < z.terminals ? 'font-semibold text-gold-ink' : ''}`}>{z.acked}/{z.terminals}</td>
                      <td className="pl-2 text-right tabular-nums">{z.reported}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          {muster.unzonedAcks > 0 && (
            <p className="mt-2 text-xs text-ink-2">{L(lang, `Potwierdzenia z terminali bez strefy: ${muster.unzonedAcks}`, `Acknowledgements from terminals without a zone: ${muster.unzonedAcks}`)}</p>
          )}
          <p className="mt-2 text-xs text-ink-2">
            {L(lang, 'Osoby w bazie: zameldowane czytnikami w strefie. Punkt zbiórki wg trasy ewakuacji (z uwzględnieniem zablokowanej klatki).',
                     'People (DB): checked in at the zone readers. Muster station from the escape route (blocked stairwell considered).')}
          </p>
        </div>
      )}

      {bridge && (!ending ? (
        <button type="button" onClick={() => setEnding(true)}
                className="tap min-h-[52px] rounded-card border-2 border-ink bg-paper px-4 font-bold uppercase hover:bg-paper-2">
          {L(lang, 'Zakończ alarm', 'End alarm')}
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-card border border-line p-3 sm:flex-row sm:items-center">
          <p className="flex-1 font-semibold">{L(lang, 'Zakończyć alarm na wszystkich terminalach?', 'End the alarm on every terminal?')}</p>
          <button type="button" autoFocus onClick={() => setEnding(false)}
                  className="tap min-h-[48px] rounded-card border border-line bg-paper px-4 font-semibold">{L(lang, 'Anuluj', 'Cancel')}</button>
          <button type="button" onClick={() => end()}
                  className="tap min-h-[48px] rounded-card bg-navy px-4 font-bold text-paper">{L(lang, 'Tak, zakończ', 'Yes, end it')}</button>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function csvOf(lang: Lang, log: Alarm[]): string {
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['id', 'rodzaj', 'kind', 'tryb', 'strefa', 'zablokowane', 'komunikat', 'oglosil', 'start', 'koniec', 'powod_konca',
    'zakonczyl', 'czas_trwania_s', 'potwierdzenia', 'potwierdzenia_szczegoly'];
  const rows = log.map((a) => {
    const dur = a.endedAt ? Math.round((Date.parse(a.endedAt) - Date.parse(a.at)) / 1000) : '';
    const acks = Object.values(a.acks).map((k) =>
      `${k.name}${k.user ? ` (${k.user})` : ''}: ${Math.round((Date.parse(k.at) - Date.parse(a.at)) / 1000)} s${k.headcount != null ? `, ${k.headcount} os.` : ''}`).join(' | ');
    return [a.id, kindName('pl', a.kind), a.kind, a.drill ? 'ćwiczenie' : 'prawdziwy', a.zone ?? '', a.blocked ?? '', a.message,
      a.raisedBy, a.at, a.endedAt ?? '', a.endReason ?? '', a.endedBy ?? '', dur, Object.keys(a.acks).length, acks].map(q).join(';');
  });
  void lang;
  return String.fromCharCode(0xfeff) + [head.join(';'), ...rows].join('\r\n');
}

function LogList({ lang }: { lang: Lang }) {
  const { log, refreshLog } = useAlarms();
  const [all, setAll] = useState(false);
  const shown = all ? log : log.slice(0, 10);
  function exportCsv() {
    const blob = new Blob([csvOf(lang, log)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dziennik-alarmow-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <section className="panel flex flex-col gap-3 p-4" aria-labelledby="alarm-log-h">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="alarm-log-h" className="tech-title mr-auto text-xl">{L(lang, 'Dziennik alarmów', 'Alarm log')}</h3>
        <button type="button" onClick={refreshLog} className="tap min-h-[48px] rounded-card border border-line bg-paper px-3 text-sm font-semibold hover:bg-paper-2">
          {L(lang, 'Odśwież', 'Refresh')}
        </button>
        <button type="button" onClick={exportCsv} disabled={!log.length}
                className="tap min-h-[48px] rounded-card bg-navy px-3 text-sm font-semibold text-paper disabled:opacity-50">
          {L(lang, 'Eksport CSV', 'Export CSV')}
        </button>
      </div>
      {!log.length ? <p className="text-sm text-ink-2">{L(lang, 'Dziennik jest pusty.', 'The log is empty.')}</p> : (
        <ul className="divide-y divide-line">
          {shown.map((a) => {
            const acks = Object.values(a.acks);
            const times = acks.map((k) => Date.parse(k.at) - Date.parse(a.at)).filter((ms) => ms > 0);
            const avg = times.length ? times.reduce((s, x) => s + x, 0) / times.length : null;
            return (
              <li key={a.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-3">
                <span className="text-sm tabular-nums text-ink-2 sm:w-44">{dateTime(lang, a.at)}</span>
                <span className="font-semibold">{kindName(lang, a.kind)}</span>
                <span className={`text-xs font-bold uppercase tracking-[0.08em] ${a.drill ? 'text-gold-ink' : 'text-danger'}`}>
                  {a.drill ? L(lang, 'ćwiczenie', 'drill') : L(lang, 'prawdziwy', 'real')}
                </span>
                <span className="text-sm text-ink-2 sm:ml-auto">
                  {!a.endedAt ? <span className="font-semibold text-danger">{L(lang, 'trwa', 'active')}</span>
                    : `${clock((Date.parse(a.endedAt) - Date.parse(a.at)) / 1000)}${a.endReason === 'replaced' ? ` · ${L(lang, 'zastąpiony', 'replaced')}` : ''}`}
                  {' · '}{acks.length} {L(lang, 'potw.', 'acks')}{avg != null ? ` · ${L(lang, 'śr. reakcja', 'avg reaction')} ${reaction(avg)}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {log.length > 10 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="tap min-h-[48px] self-start text-sm font-semibold text-teal underline">
          {all ? L(lang, 'Pokaż mniej', 'Show less') : L(lang, `Pokaż wszystkie (${log.length})`, `Show all (${log.length})`)}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function Settings({ lang }: { lang: Lang }) {
  const { identity, setIdentity, defaultName, user } = useAlarms();
  const [open, setOpen] = useState(defaultName);
  const [name, setName] = useState(identity.name);
  const [zone, setZone] = useState<TerminalZone | ''>(identity.zone ?? '');
  const valid = [...name.trim()].length >= 2;
  useEffect(() => { setName(identity.name); setZone(identity.zone ?? ''); }, [identity]);

  function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setIdentity({ name: name.trim(), zone: zone || null });
    setOpen(false);
  }
  return (
    <section className="panel p-4" aria-labelledby="alarm-term-h">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="alarm-term-h" className="tech-title mr-auto text-xl">{L(lang, 'Ten terminal', 'This terminal')}</h3>
        <button type="button" aria-expanded={open} aria-controls="alarm-term-form" onClick={() => setOpen((v) => !v)}
                className="tap min-h-[48px] rounded-card border border-line bg-paper px-3 text-sm font-semibold hover:bg-paper-2">
          {open ? L(lang, 'Zamknij', 'Close') : L(lang, 'Zmień', 'Change')}
        </button>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-semibold">{identity.name}</span>
        {identity.zone ? ` · ${zoneLabel(lang, identity.zone)}` : ''}
        <span className="text-ink-2"> · {identity.terminalId}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">{L(lang, 'Obsługuje', 'Operated by')}:</span>
        {user ? <><span className="font-semibold">{user.name}</span><RoleBadge lang={lang} role={user.role} /></>
          : <span>{L(lang, 'nikt nie jest zalogowany (terminal załogi)', 'nobody logged in (crew terminal)')}</span>}
      </p>
      {open && (
        <form id="alarm-term-form" onSubmit={save} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="tech-kicker">{L(lang, 'Nazwa terminala', 'Terminal name')}</span>
            <input className={field} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} aria-invalid={!valid} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="tech-kicker">{L(lang, 'Strefa terminala', 'Terminal zone')}</span>
            <select className={field} value={zone} onChange={(e) => setZone(e.target.value as TerminalZone | '')}>
              <option value="">{L(lang, 'Nieokreślona', 'Not set')}</option>
              <ZoneOptions lang={lang} boatDeck />
            </select>
          </label>
          <p className="text-xs text-ink-2">
            {L(lang, 'Nazwa i strefa opisują urządzenie. Uprawnienia (konsola mostka) daje logowanie załogi, nie to ustawienie.',
                     'Name and zone describe the device. Rights (bridge console) come from the crew login, not from this setting.')}
          </p>
          <button type="submit" disabled={!valid} className="tap min-h-[48px] self-start rounded-card bg-navy px-5 font-semibold text-paper disabled:opacity-50">
            {L(lang, 'Zapisz', 'Save')}
          </button>
        </form>
      )}
    </section>
  );
}

/** Shown instead of the raise form to anyone without bridge rights. */
function RaiseLocked({ lang }: { lang: Lang }) {
  const auth = useAuthOptional();
  const user = auth?.user ?? null;
  return (
    <section className="panel flex flex-col gap-3 p-4" aria-labelledby="alarm-locked-h">
      <h3 id="alarm-locked-h" className="tech-title text-xl">{L(lang, 'Ogłaszanie alarmu', 'Raise an alarm')}</h3>
      {user ? (
        <p className="text-sm">
          {L(lang, `Jesteś zalogowany jako ${user.name} (${user.rank}). Alarmy ogłasza i kończy oficer mostka albo kapitan. W razie zagrożenia zgłoś je na mostek.`,
                   `You are logged in as ${user.name} (${user.rank}). Alarms are raised and ended by a bridge officer or the master. Report any danger to the bridge.`)}
        </p>
      ) : (
        <>
          <p className="text-sm">
            {L(lang, 'Konsola mostka jest dla zalogowanego oficera mostka albo kapitana. Bez logowania widzisz stan alarmu i możesz go potwierdzić.',
                     'The bridge console is for a logged-in bridge officer or the master. Without logging in you see the alarm status and can acknowledge it.')}
          </p>
          {auth && (
            <button type="button" onClick={() => auth.openLogin('alarm')}
                    className="tap-lg min-h-[56px] self-start rounded-card bg-navy px-5 font-bold uppercase tracking-[0.06em] text-on-strong">
              {L(lang, 'Zaloguj się na mostek', 'Log in for the bridge')}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export default function AlarmPanel({ lang }: { lang: Lang }) {
  const { conn, identity, lastError, state } = useAlarms();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!lastError) return;
    const key = lastError.message === 'offline' ? 'offline' : lastError.code;
    const [pl, en] = ERRORS[key] ?? ERRORS.unknown;
    setErr(L(lang, pl, en));
    const t = window.setTimeout(() => setErr(null), 6000);
    return () => clearTimeout(t);
  }, [lastError, lang]);
  const bridge = identity.role === 'bridge';
  const online = state?.terminals.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <p className="tech-kicker">{bridge ? L(lang, 'Konsola mostka', 'Bridge console') : L(lang, 'Terminal załogi', 'Crew terminal')}</p>
          <h2 className="tech-title text-h2">{L(lang, 'System alarmowy', 'Alarm system')}</h2>
        </div>
        <p className="flex items-center gap-2 text-sm" role="status">
          <span className="alarm-dot" data-on={conn === 'online' ? '' : undefined} data-warn={conn === 'connecting' ? '' : undefined} aria-hidden="true" />
          {conn === 'online' ? L(lang, `Połączono z centralą · terminale online: ${online}`, `Connected · terminals online: ${online}`)
            : conn === 'connecting' ? L(lang, 'Łączenie z centralą…', 'Connecting…')
            : L(lang, 'Brak połączenia z centralą. Ponawiam…', 'No connection. Retrying…')}
        </p>
      </header>
      {err && <p role="alert" className="rounded-card border-2 border-danger bg-paper p-3 font-semibold text-danger">{err}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <ActiveCard lang={lang} />
          {bridge ? <RaiseForm lang={lang} /> : <RaiseLocked lang={lang} />}
        </div>
        <div className="flex flex-col gap-4">
          <Settings lang={lang} />
          <LogList lang={lang} />
        </div>
      </div>
      <p className="text-xs text-ink-2">
        {L(lang, 'Materiał szkoleniowy i demonstracja. Nie zastępuje instalacji alarmowej statku, Rozkładu alarmowego (Muster List) ani poleceń kapitana.',
                 'Training material and demo. Does not replace the ship\'s alarm installation, the Muster List or the master\'s orders.')}
      </p>
    </div>
  );
}
