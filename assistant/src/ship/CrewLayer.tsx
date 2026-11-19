// "Załoga" layer of the ship view: terminal markers + zone headcount badges over the 3D canvas (HTML elements kept on
// projected 3D points by ShipView.setAnchorLayer), the side panel for a picked room / zone, the keyboard list
// "Terminale i obsada", the legend and the evacuation-mode summary. Data: useCrewData (crew.ts).
import { forwardRef } from 'react';
import type { CrewZone } from '../../shared/crew-map';
import type { Lang } from '../types';
import { L, tr } from './routes';
import {
  CREW_ZONES, crewZoneDeck, crewZoneName, hhmm, zoneBadgeAt,
  type CrewAlert, type CrewData, type CrewPerson, type Severity,
} from './crew';

export type CrewSel = { kind: 'room'; code: string } | { kind: 'zone'; zone: CrewZone };
export const selKey = (s: CrewSel | null) => (s ? (s.kind === 'room' ? `room:${s.code}` : `zone:${s.zone}`) : '');

const osoby = (lang: Lang, n: number) => L(lang, `${n} os.`, n === 1 ? '1 person' : `${n} people`);
const sevText = (lang: Lang, s: Severity) => (s === 'critical' ? L(lang, 'alarm krytyczny', 'critical alert') : L(lang, 'ostrzeżenie', 'warning'));

/** square card-reader glyph: safety-orange outline, card slot, green "online" lamp */
export function ReaderGlyph({ sev, size = 16 }: { sev?: Severity | null; size?: number }) {
  const stroke = sev === 'critical' ? 'var(--c-danger)' : 'var(--c-gold)';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="block shrink-0">
      <rect x="1" y="1" width="14" height="14" rx="2" fill="var(--c-paper)" stroke={stroke} strokeWidth="2" />
      <rect x="4.5" y="4" width="7" height="2" rx="0.5" fill="var(--c-ink)" />
      <circle cx="8" cy="10.5" r="1.8" fill="var(--c-ok)" />
    </svg>
  );
}

// ---------- markers over the canvas ----------
export const CrewMarkers = forwardRef<HTMLDivElement, {
  lang: Lang; data: CrewData; show: boolean; sel: CrewSel | null; hl: string; onSelect(s: CrewSel): void;
}>(function CrewMarkers({ lang, data, show, sel, hl, onSelect }, ref) {
  const key = selKey(sel);
  return (
    <div ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {show && data.status === 'ok' && (
        <>
          {data.terminals.map((t) => {
            if (!t.place) return null;
            const on = key === `room:${t.room_code}` || hl === `room:${t.room_code}`;
            const sev = data.roomSeverity[t.room_code];
            return (
              <button key={t.code} type="button" tabIndex={-1} data-at={t.place.at.join(',')}
                      onClick={() => onSelect({ kind: 'room', code: t.room_code })}
                      className={`group pointer-events-auto absolute left-0 top-0 rounded-[3px] p-0.5 ${on ? 'z-20 bg-gold/30' : 'z-10 hover:z-20'}`}>
                <ReaderGlyph sev={sev} />
                <span className={`absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded-[3px] border border-line bg-paper px-1.5 py-0.5 text-left text-[11px] font-semibold leading-tight text-ink shadow-sm ${on ? 'block' : 'hidden group-hover:block'}`}>
                  {t.code}<span className="block font-normal text-ink-2">{t.room_name}</span>
                </span>
              </button>
            );
          })}
          {CREW_ZONES.map((z) => {
            const e = data.byZone[z];
            if (!e) return null;
            const on = key === `zone:${z}` || hl === `zone:${z}`;
            const ring = e.severity === 'critical' ? 'border-danger' : e.severity === 'warning' ? 'border-gold' : 'border-paper';
            return (
              <button key={z} type="button" tabIndex={-1} data-at={zoneBadgeAt(z).join(',')} data-anchor="bottom" data-nudge="1"
                      title={tr(lang, crewZoneName(z))}
                      onClick={() => onSelect({ kind: 'zone', zone: z })}
                      className={`pointer-events-auto absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap rounded-full border-2 bg-navy px-2 py-0.5 text-xs font-bold text-paper shadow ${ring} ${on ? 'z-30 outline outline-2 outline-offset-1 outline-gold' : 'z-20'} ${e.people ? '' : 'opacity-70'}`}>
                {e.severity && <span className={`inline-block h-2 w-2 rounded-full ${e.severity === 'critical' ? 'bg-danger' : 'bg-gold'}`} />}
                {osoby(lang, e.people)}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
});

// ---------- legend + status over the canvas ----------
export function CrewLegend({ lang, data }: { lang: Lang; data: CrewData }) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 flex max-w-[60%] flex-col items-end gap-1">
      {data.status === 'down' && (
        <p role="status" className="rounded-card border border-danger bg-paper px-3 py-1 text-xs font-semibold text-danger">
          {L(lang, 'Brak połączenia z bazą załogi', 'No connection to the crew database')}
        </p>
      )}
      {data.status === 'loading' && (
        <p role="status" className="rounded-card bg-paper/90 px-3 py-1 text-xs font-semibold text-ink-2">
          {L(lang, 'Łączenie z bazą załogi…', 'Connecting to the crew database…')}
        </p>
      )}
      {data.status === 'ok' && (
        <ul className="panel hidden flex-col gap-1 px-2.5 py-2 text-[11px] text-ink sm:flex" aria-label={L(lang, 'Legenda warstwy Załoga', 'Crew layer legend')}>
          <li className="flex items-center gap-1.5"><ReaderGlyph size={13} />{L(lang, 'Terminal (czytnik kart)', 'Terminal (card reader)')}</li>
          <li className="flex items-center gap-1.5"><span className="rounded-full bg-navy px-1.5 text-[10px] font-bold text-paper">N</span>{L(lang, 'Osoby w strefie', 'People in zone')}</li>
          <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-danger" />{L(lang, 'Alarm krytyczny', 'Critical alert')}</li>
          <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-gold" />{L(lang, 'Ostrzeżenie', 'Warning')}</li>
          {data.updated && <li className="text-ink-2">{L(lang, 'Stan z', 'As of')} {new Date(data.updated).toLocaleTimeString(lang === 'pl' ? 'pl-PL' : 'en-GB')}</li>}
        </ul>
      )}
    </div>
  );
}

// ---------- side panel ----------
function Alerts({ lang, list }: { lang: Lang; list: CrewAlert[] }) {
  if (!list.length) return <p className="text-xs text-ink-2">{L(lang, 'Brak alarmów.', 'No alerts.')}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {list.map((a, i) => (
        <li key={i} className={`flex items-start gap-2 rounded-card border border-line px-2 py-1 text-xs ${a.severity === 'critical' ? 'bg-danger/10' : 'bg-gold/10'}`}>
          <span aria-hidden="true" className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${a.severity === 'critical' ? 'bg-danger' : 'bg-gold'}`} />
          <span className="min-w-0">
            <span className={`font-semibold ${a.severity === 'critical' ? 'text-danger' : 'text-gold-ink'}`}>{sevText(lang, a.severity)}: </span>
            {tr(lang, a.text)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function People({ lang, list }: { lang: Lang; list: CrewPerson[] }) {
  if (!list.length) return <p className="text-xs text-ink-2">{L(lang, 'Nikt nie jest odbity w środku.', 'Nobody is checked in.')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line text-sm">
      {list.map((p, i) => (
        <li key={`${p.name}|${p.room_code}|${i}`} className="flex items-baseline justify-between gap-2 py-1">
          <span className="min-w-0"><span className="font-semibold text-ink">{p.name}</span> <span className="text-xs text-ink-2">{p.rank}</span></span>
          {p.since && <span className="shrink-0 text-xs tabular-nums text-ink-2">{L(lang, 'od', 'since')} {hhmm(p.since)}</span>}
        </li>
      ))}
    </ul>
  );
}

export function CrewDetail({ lang, data, sel, onSelect, onClose }: {
  lang: Lang; data: CrewData; sel: CrewSel; onSelect(s: CrewSel): void; onClose(): void;
}) {
  const close = (
    <button type="button" onClick={onClose} className="tap shrink-0 rounded-card border border-line px-2 text-xs font-semibold text-ink-2 hover:text-ink">
      {L(lang, 'Zamknij', 'Close')}
    </button>
  );
  if (data.status !== 'ok') {
    return (
      <div className="rounded-card border border-line p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-ink-2">{data.status === 'down' ? L(lang, 'Brak połączenia z bazą załogi.', 'No connection to the crew database.') : L(lang, 'Ładowanie…', 'Loading…')}</p>
          {close}
        </div>
      </div>
    );
  }
  if (sel.kind === 'room') {
    const room = data.rooms.find((r) => r.code === sel.code);
    if (!room) return null;
    const z = room.place?.zone;
    const terms = data.terminals.filter((t) => t.room_code === room.code);
    const people = data.people.filter((p) => p.room_code === room.code).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const sev = data.roomSeverity[room.code];
    return (
      <div className={`rounded-card border-2 p-3 ${sev === 'critical' ? 'border-danger' : sev === 'warning' ? 'border-gold' : 'border-line'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="tech-kicker">{z ? `${tr(lang, crewZoneDeck(z))} · ${tr(lang, crewZoneName(z))}` : room.code}</p>
            <h3 className="tech-title text-xl">{room.name}</h3>
          </div>
          {close}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-card bg-paper-2 px-3 py-1.5">
            <dt className="tech-kicker">{L(lang, 'Obsada', 'Occupancy')}</dt>
            <dd className="tech-title text-2xl">{room.people}<span className="text-base text-ink-2"> / {room.capacity}</span></dd>
          </div>
          <div className="rounded-card bg-paper-2 px-3 py-1.5">
            <dt className="tech-kicker">{L(lang, 'Zapełnienie', 'Load')}</dt>
            <dd className="tech-title text-2xl">{Math.round(room.occupancy)}%</dd>
          </div>
        </dl>
        <p className="mt-1 text-xs text-ink-2">
          {room.code}
          {room.min_staff > 0 && ` · ${L(lang, `minimalna obsada ${room.min_staff} os.`, `minimum crew ${room.min_staff}`)}`}
          {room.hazardous ? ` · ${L(lang, 'strefa niebezpieczna', 'hazardous space')}` : ''}
          {terms.length > 0 && ` · ${L(lang, 'terminale', 'terminals')}: ${terms.map((t) => t.code).join(', ')}`}
        </p>
        <h4 className="tech-kicker mb-1 mt-3">{L(lang, 'W środku', 'Inside')}</h4>
        <People lang={lang} list={people} />
        <h4 className="tech-kicker mb-1 mt-3">{L(lang, 'Alarmy', 'Alerts')}</h4>
        <Alerts lang={lang} list={data.alerts.filter((a) => a.room === room.code)} />
      </div>
    );
  }
  const e = data.byZone[sel.zone];
  return (
    <div className={`rounded-card border-2 p-3 ${e?.severity === 'critical' ? 'border-danger' : e?.severity === 'warning' ? 'border-gold' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="tech-kicker">{tr(lang, crewZoneDeck(sel.zone))}</p>
          <h3 className="tech-title text-xl">{tr(lang, crewZoneName(sel.zone))}</h3>
          <p className="text-sm font-semibold text-ink">{L(lang, 'Osoby w strefie', 'People in the zone')}: {e?.people ?? 0}</p>
        </div>
        {close}
      </div>
      <h4 className="tech-kicker mb-1 mt-3">{L(lang, 'Pomieszczenia', 'Rooms')}</h4>
      <ul className="flex flex-col gap-1">
        {(e?.rooms ?? []).map((r) => (
          <li key={r.code}>
            <button type="button" onClick={() => onSelect({ kind: 'room', code: r.code })}
                    className="tap flex w-full items-center justify-between gap-2 rounded-card border border-line px-2 py-1 text-left text-sm hover:bg-paper-2">
              <span className="min-w-0">{r.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink-2">{r.people} / {r.capacity}</span>
            </button>
          </li>
        ))}
      </ul>
      <h4 className="tech-kicker mb-1 mt-3">{L(lang, 'Osoby', 'People')}</h4>
      <People lang={lang} list={e?.persons ?? []} />
      <h4 className="tech-kicker mb-1 mt-3">{L(lang, 'Alarmy', 'Alerts')}</h4>
      <Alerts lang={lang} list={e?.alerts ?? []} />
    </div>
  );
}

// ---------- keyboard / screen-reader equivalent of the markers ----------
export function CrewList({ lang, data, sel, onSelect, onHl }: {
  lang: Lang; data: CrewData; sel: CrewSel | null; onSelect(s: CrewSel): void; onHl(k: string): void;
}) {
  if (data.status !== 'ok') return null;
  const key = selKey(sel);
  const total = data.rooms.reduce((n, r) => n + r.people, 0);
  const hlProps = (k: string) => ({ onFocus: () => onHl(k), onBlur: () => onHl(''), onMouseEnter: () => onHl(k), onMouseLeave: () => onHl('') });
  return (
    <details className="panel mt-3 px-3 py-2">
      <summary className="tap flex cursor-pointer items-center text-sm font-semibold text-ink">
        {L(lang, 'Terminale i obsada', 'Terminals and crew')}
        <span className="ml-2 font-normal text-ink-2">
          ({L(lang, `${data.terminals.length} terminali, ${total} os. na pokładzie`, `${data.terminals.length} terminals, ${total} people on board`)})
        </span>
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {CREW_ZONES.map((z) => {
          const e = data.byZone[z];
          if (!e) return null;
          return (
            <li key={z}>
              <button type="button" aria-pressed={key === `zone:${z}`} onClick={() => onSelect({ kind: 'zone', zone: z })} {...hlProps(`zone:${z}`)}
                      className={`tap flex w-full items-center justify-between gap-2 rounded-card border px-2 py-1 text-left text-sm font-semibold ${key === `zone:${z}` ? 'border-gold bg-paper-2' : 'border-line hover:bg-paper-2'}`}>
                <span>{tr(lang, crewZoneName(z))}</span>
                <span className="shrink-0 text-xs">
                  {e.severity && <span className={e.severity === 'critical' ? 'text-danger' : 'text-gold-ink'}>{sevText(lang, e.severity)} · </span>}
                  {osoby(lang, e.people)}
                </span>
              </button>
              <ul className="ml-3 mt-1 flex flex-col gap-1 border-l border-line pl-2">
                {e.rooms.map((r) => {
                  const k = `room:${r.code}`;
                  const sev = data.roomSeverity[r.code];
                  const terms = data.terminals.filter((t) => t.room_code === r.code).map((t) => t.code);
                  return (
                    <li key={r.code}>
                      <button type="button" aria-pressed={key === k} onClick={() => onSelect({ kind: 'room', code: r.code })} {...hlProps(k)}
                              className={`flex min-h-9 w-full items-start gap-2 rounded-card px-2 py-1 text-left text-xs ${key === k ? 'bg-paper-2 font-semibold' : 'hover:bg-paper-2'}`}>
                        <ReaderGlyph sev={sev} size={14} />
                        <span className="min-w-0 flex-1">
                          <span className="text-sm text-ink">{r.name}</span>
                          <span className="block text-ink-2">{terms.join(', ') || L(lang, 'bez terminala', 'no terminal')}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-2">
                          {sev && <span className="sr-only">{sevText(lang, sev)}, </span>}
                          {r.people} / {r.capacity}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ---------- evacuation mode summary ----------
export function EvacCrew({ lang, data, zone, routeZones }: { lang: Lang; data: CrewData; zone: CrewZone; routeZones: CrewZone[] }) {
  if (data.status === 'down') return <p className="rounded-card border border-line px-3 py-2 text-xs text-ink-2">{L(lang, 'Brak połączenia z bazą załogi', 'No connection to the crew database')}</p>;
  if (data.status === 'loading') return null;
  const e = data.byZone[zone];
  const persons = e?.persons ?? [];
  const crit = routeZones.flatMap((z) => (data.byZone[z]?.alerts ?? []).filter((a) => a.severity === 'critical').map((a) => ({ z, a })));
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line px-3 py-2">
      <p className="text-sm font-semibold text-ink">
        {L(lang, 'Osoby w strefie startowej', 'People in the start zone')}: <span className="tabular-nums">{e?.people ?? 0}</span>
      </p>
      {persons.length > 0 && (
        <p className="text-xs text-ink-2">{persons.map((p) => `${p.name} (${p.rank})`).join(', ')}</p>
      )}
      {crit.length > 0 && (
        <div className="rounded-card border border-danger px-2 py-1.5 text-xs text-danger">
          <p className="font-semibold">{L(lang, 'Alarm krytyczny w strefie na tej drodze:', 'Critical alert in a zone on this route:')}</p>
          <ul className="list-disc pl-4">
            {crit.map(({ z, a }, i) => <li key={i}>{tr(lang, crewZoneName(z))}: {tr(lang, a.text)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
