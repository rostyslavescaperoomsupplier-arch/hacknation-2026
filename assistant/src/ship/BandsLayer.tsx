// "Opaski" on the evacuation view: every crew member with an ESP32 wristband as a dot on the 3D model (rendered inside
// the CrewMarkers anchor layer, so ShipView keeps them on their projected points) + the side panel "Do odnalezienia":
// counts and the people still to be found, most urgent first. Picking a person selects them and shows the route
// between their zone and the muster station (the way to go and fetch them).
import './bands.css';
import type { Lang } from '../types';
import { DECK_NAME } from '../../shared/positions';
import { L, ZONE, isZoneId, tr } from './routes';
import { STATUS_TEXT, ago, type BandPerson, type BandStatus, type BandsData } from './bands';

const DOT: Record<BandStatus, string> = {
  safe: 'bg-ok border-paper',
  moving: 'bg-gold border-ink',
  still: 'bg-danger border-paper band-pulse',
  sos: 'bg-danger border-paper band-pulse',
  lost: 'bg-paper border-ink-2 border-dashed',
  ok: 'bg-ink-2 border-paper',
};
const zoneLabel = (lang: Lang, p: BandPerson) =>
  p.zone === 'muster-a' ? L(lang, 'punkt zbiórki A', 'muster station A')
    : p.zone === 'muster-b' ? L(lang, 'punkt zbiórki B', 'muster station B')
    : p.zone === 'stair-aft' ? L(lang, 'schody rufowe', 'aft stairwell')
    : p.zone === 'stair-fwd' ? L(lang, 'schody dziobowe', 'forward stairwell')
    : p.zone === 'boat-deck' ? L(lang, 'pokład szalupowy', 'boat deck')
    : p.zone && isZoneId(p.zone) ? tr(lang, ZONE[p.zone].name)
    : L(lang, 'nieznane miejsce', 'unknown place');

/** dots over the canvas; children of the anchor layer (data-at) */
export function BandDots({ lang, data, sel, onSelect }: { lang: Lang; data: BandsData; sel: string | null; onSelect(p: BandPerson): void }) {
  if (data.status !== 'ok' || !data.state) return null;
  return (
    <>
      {data.state.people.map((p) => {
        if (!p.at) return null;
        const on = sel === p.key;
        const urgent = p.status === 'sos' || p.status === 'still' || p.status === 'lost';
        return (
          <button key={p.key} type="button" tabIndex={-1} data-at={`${p.at[0]},${p.at[1] + 0.9},${p.at[2]}`}
                  onClick={() => onSelect(p)}
                  className={`group pointer-events-auto absolute left-0 top-0 p-1 ${on ? 'z-30' : urgent ? 'z-20' : 'z-10 hover:z-30'}`}>
            <span className={`block rounded-full border-2 ${DOT[p.status]} ${on ? 'size-4 ring-2 ring-ink' : 'size-3'}`} />
            <span className={`absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded-[3px] border border-line bg-paper px-1.5 py-0.5 text-left text-[11px] font-semibold leading-tight text-ink shadow-sm ${on || p.status === 'sos' ? 'block' : 'hidden group-hover:block'}`}>
              {p.name}<span className="block font-normal text-ink-2">{tr(lang, STATUS_TEXT[p.status])}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

/** side panel: counts + people to find */
export function BandsPanel({ lang, data, sel, onSelect, onLogin }: {
  lang: Lang; data: BandsData; sel: string | null; onSelect(p: BandPerson): void; onLogin(): void;
}) {
  if (data.status === 'loading') return null;
  if (data.status === 'login') {
    return (
      <div className="flex flex-col gap-2 rounded-card border border-line px-3 py-2 text-sm">
        <p className="font-semibold">{L(lang, 'Opaski załogi', 'Crew wristbands')}</p>
        <p className="text-ink-2">{L(lang, 'Położenie osób widać po zalogowaniu.', 'Log in to see where people are.')}</p>
        <button type="button" onClick={onLogin} className="tap self-start rounded-card border border-gold px-3 font-semibold">{L(lang, 'Zaloguj', 'Log in')}</button>
      </div>
    );
  }
  if (data.status === 'down') return <p className="rounded-card border border-line px-3 py-2 text-xs text-ink-2">{L(lang, 'Brak danych z opasek', 'No wristband data')}</p>;
  const s = data.state;
  if (!s) return null;
  if (!s.counts.total) return <p className="rounded-card border border-line px-3 py-2 text-xs text-ink-2">{L(lang, 'Żadna opaska nie nadaje.', 'No wristband is transmitting.')}</p>;
  const now = Date.parse(s.now);
  const toFind = s.alarm ? s.people.filter((p) => p.status !== 'safe') : s.people.filter((p) => p.status === 'sos' || p.status === 'lost');
  const c = s.counts;
  return (
    <section aria-label={L(lang, 'Opaski załogi', 'Crew wristbands')} className={`flex flex-col gap-2 rounded-card border-2 px-3 py-2 ${s.alarm ? 'border-danger' : 'border-line'}`}>
      <p className="font-semibold">
        {s.alarm ? L(lang, 'Opaski: rozliczenie ewakuacji', 'Wristbands: evacuation check') : L(lang, 'Opaski załogi', 'Crew wristbands')}
      </p>
      <dl className="grid grid-cols-3 gap-1.5 text-center text-xs" role="status" aria-live="polite">
        {(s.alarm ? (['safe', 'moving', 'still', 'sos', 'lost'] as BandStatus[]) : (['ok', 'sos', 'lost'] as BandStatus[])).map((k) => (
          <div key={k} className={`rounded-card border px-1 py-1 ${(k === 'sos' || k === 'still' || k === 'lost') && c[k] ? 'border-danger text-danger' : 'border-line'}`}>
            <dt className="text-ink-2">{tr(lang, STATUS_TEXT[k])}</dt>
            <dd className="tech-title text-lg tabular-nums">{c[k]}</dd>
          </div>
        ))}
        <div className="rounded-card border border-line px-1 py-1">
          <dt className="text-ink-2">{L(lang, 'razem', 'total')}</dt>
          <dd className="tech-title text-lg tabular-nums">{c.total}</dd>
        </div>
      </dl>
      {toFind.length > 0 && (
        <>
          <p className="text-sm font-semibold">{s.alarm ? L(lang, 'Do odnalezienia', 'To be found') : L(lang, 'Wymaga uwagi', 'Needs attention')}</p>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {toFind.map((p) => {
              const seen = p.seen ? (now - Date.parse(p.seen)) / 1000 : null;
              const on = sel === p.key;
              return (
                <li key={p.key}>
                  <button type="button" aria-pressed={on} onClick={() => onSelect(p)}
                          className={`flex w-full items-start gap-2 rounded-card border px-2 py-1.5 text-left text-sm ${on ? 'border-ink bg-gold/20' : 'border-line hover:border-ink-2'}`}>
                    <span aria-hidden="true" className={`mt-1 inline-block size-3 shrink-0 rounded-full border-2 ${DOT[p.status]}`} />
                    <span className="min-w-0">
                      <span className="block font-semibold">{p.name} <span className="font-normal text-ink-2">{p.rank}</span></span>
                      <span className={`block text-xs ${p.status === 'moving' ? 'text-ink-2' : 'font-semibold text-danger'}`}>
                        {tr(lang, STATUS_TEXT[p.status])}
                        {p.status === 'still' && p.stillFor != null && ` ${ago(p.stillFor)}`}
                        {p.status === 'lost' && seen != null && `, ${L(lang, 'ostatnio', 'last')} ${ago(seen)} ${L(lang, 'temu', 'ago')}`}
                      </span>
                      <span className="block text-xs text-ink-2">
                        {p.status === 'lost' ? L(lang, 'ostatnia pozycja: ', 'last position: ') : ''}
                        {zoneLabel(lang, p)}{p.deck ? `, ${tr(lang, DECK_NAME[p.deck])}` : ''}{p.acc != null ? ` (±${Math.round(p.acc)} m)` : ''}
                        {p.acked ? `, ${L(lang, 'potwierdził alarm', 'acknowledged')}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="text-xs text-ink-2">
        {L(lang, 'Pozycja z opasek ESP32 (BLE, dokładność kilka metrów). Kliknij osobę: zaznaczenie na modelu i droga do niej od punktu zbiórki.',
          'Position from ESP32 wristbands (BLE, a few metres accuracy). Pick a person: marked on the model, with the route between them and the muster station.')}
        {s.unknownBands > 0 && ` ${L(lang, `Nieprzypisane opaski: ${s.unknownBands}.`, `Unassigned bands: ${s.unknownBands}.`)}`}
      </p>
    </section>
  );
}
