// "Statek 3D" and "Ewakuacja" tabs: three.js view of the stylized Jantar Unity model.
// mode="model": explore the ship, hover/click a room to see its name and deck.
// mode="evac": pick a zone (and optionally a blocked stairwell), see the training route to the muster station.
// The textual route in the side panel is the real content; the canvas is decoration for sighted users.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Lang } from '../types';
import { L, MUSTER, STAIRS, ZONE, ZONES, fmtTime, route, tr, type Stair, type ZoneId } from './routes';
import { ShipView, type AlertLevel, type ModelKey } from './view';
import { deckOf, roomName, zoneOfGroup } from './names';
import { crewZoneName, useCrewData, useRouteZones } from './crew';
import { CrewDetail, CrewLegend, CrewList, CrewMarkers, EvacCrew, type CrewSel } from './CrewLayer';
import { routeZoneOf, useBands, type BandPerson } from './bands';
import { BandDots, BandsPanel } from './BandsLayer';
import { useAuth } from '../auth';

export interface ShipPanelProps {
  lang: Lang;
  mode: 'model' | 'evac';
  zone?: ZoneId | null;
  blocked?: Stair | null;
  onZone?(z: ZoneId): void;
}

const MODELS: { key: ModelKey; pl: string; en: string }[] = [
  { key: 'full', pl: 'Cały prom', en: 'Whole ferry' },
  { key: 'cabins', pl: 'Pokład kabinowy', en: 'Cabin deck' },
  { key: 'engine', pl: 'Maszynownia', en: 'Engine room' },
];

const DECK_GROUPS: { pl: string; en: string; zones: ZoneId[] }[] = [
  { pl: 'Pokład 5', en: 'Deck 5', zones: ['bridge'] },
  { pl: 'Pokład 4', en: 'Deck 4', zones: ['restaurant', 'lounge', 'reclining-lounge'] },
  { pl: 'Pokład 3 (kabiny)', en: 'Deck 3 (cabins)', zones: ['cabins-fwd', 'cabins-mid', 'cabins-aft'] },
  { pl: 'Pokłady samochodowe', en: 'Vehicle decks', zones: ['vehicle-d2', 'vehicle-d1'] },
  { pl: 'Maszynownia', en: 'Engine room', zones: ['engine-room', 'engine-control'] },
];

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return r;
}

function Segmented<T extends string>({ label, value, options, onChange, tone = 'ink' }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void; tone?: 'ink' | 'danger';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid w-full max-w-xl auto-cols-fr grid-flow-col gap-0.5 rounded-card border border-line bg-paper p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        const active = tone === 'danger' && o.value !== ('' as T) ? 'bg-danger text-on-strong' : 'bg-ink text-on-strong';
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
                  className={`tap rounded-[4px] px-2 py-1 text-center text-sm font-semibold leading-tight transition-colors ${on ? active : 'text-ink-2 hover:bg-paper-2 hover:text-ink'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** the panel stays mounted under `hidden` when another tab is open: poll only while it is on screen */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => setOn(e.some((x) => x.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

export default function ShipPanel({ lang, mode, zone, blocked, onZone }: ShipPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ShipView | null>(null);
  const reduced = useReducedMotion();
  const descId = useId();
  const zoneSelId = useId();

  const [model, setModel] = useState<ModelKey>('full');
  const [progress, setProgress] = useState<{ pct: number; bytes?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [glFail, setGlFail] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [modelZone, setModelZone] = useState<ZoneId | null>(null);
  const [evZone, setEvZone] = useState<ZoneId>(zone ?? 'cabins-mid');
  const [evBlocked, setEvBlocked] = useState<Stair | null>(blocked ?? null);

  // presets from the assistant / drills
  useEffect(() => { if (zone) setEvZone(zone); }, [zone]);
  useEffect(() => { setEvBlocked(blocked ?? null); }, [blocked]);
  // the evacuation view starts on the whole ship
  useEffect(() => { if (mode === 'evac') setModel('full'); }, [mode]);

  const r = useMemo(() => route(evZone, evBlocked), [evZone, evBlocked]);

  // ---- crew layer ----
  const onScreen = useOnScreen(rootRef);
  const [crewOn, setCrewOn] = useState(true);
  const [crewSel, setCrewSel] = useState<CrewSel | null>(null);
  const [crewHl, setCrewHl] = useState('');
  const crew = useCrewData(onScreen && (mode === 'evac' || crewOn));
  const routeZones = useRouteZones(r.points, evZone);
  const showCrew = mode === 'model' && crewOn;
  // ---- wristbands (evacuation view) ----
  const bands = useBands(onScreen && mode === 'evac');
  const [bandSel, setBandSel] = useState<string | null>(null);
  const { openLogin } = useAuth();
  const pickBand = (p: BandPerson) => {
    if (bandSel === p.key) { setBandSel(null); return; }
    setBandSel(p.key);
    const z = routeZoneOf(p.zone);
    if (z) setEvZone(z);
    // the person is shown on the model: bring it on screen when the list scrolled it away
    const st = hostRef.current?.parentElement;
    if (st) { const b = st.getBoundingClientRect(); if (b.bottom < 80 || b.top > innerHeight - 80) st.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }
  };
  const bandsAlarm = bands.status === 'ok' && !!bands.state?.alarm;
  useEffect(() => { viewRef.current?.refreshAnchors(); }, [bands]);
  const crewSelId = useId();
  const crewSelLabel = !crewSel ? '' : crewSel.kind === 'room'
    ? (crew.rooms.find((x) => x.code === crewSel.code)?.name ?? '')
    : tr(lang, crewZoneName(crewSel.zone));

  // ---- three.js lifecycle ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let v: ShipView;
    try {
      v = new ShipView(host, {
        onHover: setHover,
        onPick: (g) => { setPicked(g); setModelZone(null); },
        onProgress: (pct, bytes) => setProgress(pct === null ? null : { pct, bytes }),
        onError: setError,
      }, reduced);
    } catch {
      setGlFail(true);
      return;
    }
    viewRef.current = v;
    v.setAnchorLayer(markerRef.current);
    return () => { v.dispose(); viewRef.current = null; };
    // reduced motion is pushed separately below; the view is created once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { viewRef.current?.setReducedMotion(reduced); }, [reduced]);

  useEffect(() => {
    setError(null);
    void viewRef.current?.setModel(model);
    // the engine-room cutaway has nothing above deck 1: hide markers that would float in the air
    viewRef.current?.setAnchorLayer(markerRef.current, model === 'engine' ? (p) => p.y < 1 : null);
  }, [model, glFail]);

  // crew markers moved / changed: re-place them; alert tint of the zones in model mode
  useEffect(() => { viewRef.current?.refreshAnchors(); }, [crew, crewSel, crewHl, showCrew, lang]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const m = new Map<string, AlertLevel>();
    if (showCrew && crew.status === 'ok') {
      for (const z of ZONES) {
        const sev = crew.byZone[z.id]?.severity;
        if (sev) for (const g of z.groups) m.set(g, sev);
      }
    }
    v.setAlertGroups(m);
  }, [crew, showCrew]);

  // mode / route
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    if (mode === 'evac') {
      const z = ZONE[evZone];
      const mu = MUSTER[r.muster];
      const letter = r.muster === 'muster-a' ? 'A' : 'B';
      setHover(null); setPicked(null);
      v.setGhost(true);
      v.showRoute({
        points: r.points,
        start: z.anchor,
        musters: mu.points,
        musterLabels: [L(lang, `Punkt zbiórki ${letter}`, `Muster station ${letter}`)],
        startLabel: L(lang, 'Tu jesteś', 'You are here'),
        blockedBox: evBlocked ? STAIRS[evBlocked].box : null,
        blockedLabel: L(lang, 'Zablokowane', 'Blocked'),
        zoneGroups: z.groups,
      });
    } else {
      v.clearRoute();
      v.setGhost(false);
      v.frameModel();
    }
  }, [mode, r, evZone, evBlocked, lang]);

  // model mode: zone list highlight
  useEffect(() => {
    const v = viewRef.current;
    if (!v || mode !== 'model') return;
    if (modelZone) { v.setSelected(null); v.setZoneGroups(ZONE[modelZone].groups); v.frameBox(ZONE[modelZone].box); }
    else v.setZoneGroups([]);
  }, [modelZone, mode]);

  function pickCrew(s: CrewSel) {
    setCrewSel(s);
    // on narrow screens the side panel is below the canvas: bring it into view
    requestAnimationFrame(() => document.getElementById(crewSelId)?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }));
  }

  function pickZone(z: ZoneId) {
    setEvZone(z);
    onZone?.(z);
  }

  const shown = hover ?? picked;
  const shownInfo = useMemo(() => {
    if (!shown) return null;
    const b = viewRef.current?.groupBox(shown);
    return {
      name: roomName(lang, shown),
      deck: b ? deckOf(lang, b.min.y, b.max.y) : '',
      zone: zoneOfGroup(shown),
    };
  }, [shown, lang]);

  const loadingText = progress
    ? progress.pct >= 0
      ? L(lang, `Ładowanie modelu 3D… ${progress.pct}%`, `Loading 3D model… ${progress.pct}%`)
      : L(lang, `Ładowanie modelu 3D… ${((progress.bytes ?? 0) / 1e6).toFixed(1)} MB`, `Loading 3D model… ${((progress.bytes ?? 0) / 1e6).toFixed(1)} MB`)
    : null;

  const disclaimer = L(lang,
    'Model szkoleniowy (uproszczony model 3D). Nie zastępuje rozkładu alarmowego (Muster List) statku ani poleceń załogi.',
    'Training model (simplified 3D model). It does not replace the ship\'s Muster List or crew instructions.');

  const blockedOptions: { value: '' | Stair; label: string }[] = [
    { value: '', label: L(lang, 'Brak', 'None') },
    { value: 'stair-aft', label: L(lang, 'Rufowa', 'Aft') },
    { value: 'stair-fwd', label: L(lang, 'Dziobowa', 'Forward') },
  ];

  const canvasDesc = mode === 'evac'
    ? L(lang, `Widok 3D promu z zaznaczoną drogą ewakuacji: ${tr(lang, ZONE[evZone].name)} do: ${tr(lang, MUSTER[r.muster].name)}. Ta sama droga jest opisana w krokach obok.`,
        `3D view of the ferry with the evacuation route from ${tr(lang, ZONE[evZone].name)} to ${tr(lang, MUSTER[r.muster].name)}. The same route is described step by step next to it.`)
    : L(lang, 'Interaktywny model 3D promu. Obracaj przeciągnięciem, przybliżaj kółkiem lub gestem. Lista stref obok działa z klawiatury.',
        'Interactive 3D model of the ferry. Drag to rotate, scroll or pinch to zoom. The zone list next to it works with the keyboard.');

  const evac = mode === 'evac';
  const modelPicker = (
    <Segmented label={L(lang, 'Model', 'Model')} value={model} onChange={(v) => setModel(v as ModelKey)}
               options={MODELS.map((m) => ({ value: m.key, label: L(lang, m.pl, m.en) }))} />
  );

  // Layout: phones stack head / route / canvas in evacuation (the written route is the next action and comes first),
  // head / canvas / zones when exploring. Desktop: head + canvas on the left, the side panel spans both rows.
  return (
    <section ref={rootRef} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:grid-rows-[auto_1fr] lg:gap-x-6" aria-labelledby={`${descId}-t`}>
      <div className="order-1 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1">
        <p className="tech-kicker">MF Jantar Unity</p>
        <h2 id={`${descId}-t`} className="tech-title mb-3 text-h2">
          {evac ? L(lang, 'Droga ewakuacji', 'Evacuation route') : L(lang, 'Statek 3D', 'Ship 3D')}
        </h2>

        {!evac && (
          <div className="flex flex-wrap items-center gap-2">
            {modelPicker}
            <button type="button" aria-pressed={crewOn} onClick={() => { setCrewOn(!crewOn); setCrewSel(null); }}
                    className={`tap inline-flex items-center gap-2 rounded-card border px-3 text-sm font-semibold ${crewOn ? 'border-gold bg-paper text-ink' : 'border-line bg-paper text-ink-2 hover:text-ink'}`}>
              <span aria-hidden="true" className={`inline-block h-3.5 w-3.5 rounded-[2px] border-2 ${crewOn ? 'border-gold bg-gold' : 'border-ink-2'}`} />
              {L(lang, 'Warstwa: Załoga', 'Layer: Crew')}
            </button>
          </div>
        )}

        {evac && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={zoneSelId} className="tech-kicker">{L(lang, 'Gdzie jesteś?', 'Where are you?')}</label>
              <select id={zoneSelId} value={evZone} onChange={(e) => pickZone(e.target.value as ZoneId)}
                      className="tap-lg w-full rounded-card border-2 border-ink/50 bg-paper px-3 font-semibold text-ink">
                {DECK_GROUPS.map((g) => (
                  <optgroup key={g.pl} label={L(lang, g.pl, g.en)}>
                    {g.zones.map((z) => <option key={z} value={z}>{tr(lang, ZONE[z].name)}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="tech-kicker">{L(lang, 'Zablokowana klatka schodowa', 'Blocked stairwell')}</span>
              <Segmented label={L(lang, 'Zablokowana klatka schodowa', 'Blocked stairwell')} value={(evBlocked ?? '') as '' | Stair}
                         onChange={(v) => setEvBlocked(v || null)} options={blockedOptions} tone="danger" />
            </div>
          </div>
        )}
      </div>

      <div className={`min-w-0 lg:order-none lg:col-start-1 lg:row-start-2 ${evac ? 'order-3' : 'order-2'}`}>
        <div className="ship-stage relative h-[52vh] min-h-[300px] w-full overflow-hidden rounded-card border border-line lg:h-[62vh]">
          <p id={descId} className="sr-only">{canvasDesc}</p>
          <div ref={hostRef} className="ship-gl absolute inset-0" aria-hidden="true" />
          <CrewMarkers ref={markerRef} lang={lang} data={crew} show={showCrew && !glFail} sel={crewSel} hl={crewHl} onSelect={pickCrew}>
            {evac && !glFail && <BandDots lang={lang} data={bands} sel={bandSel} onSelect={pickBand} />}
          </CrewMarkers>
          {showCrew && !glFail && <CrewLegend lang={lang} data={crew} />}
          {glFail && (
            <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-ink-2">
              {L(lang, 'Ta przeglądarka nie obsługuje widoku 3D (WebGL). Opis drogi obok jest pełny.', 'This browser cannot show 3D (WebGL). The route description is complete.')}
            </p>
          )}
          {loadingText && (
            <div role="status" className="absolute inset-x-0 top-1/2 mx-auto flex w-[min(20rem,80%)] -translate-y-1/2 flex-col gap-2 rounded-card bg-paper/90 px-4 py-3">
              <span className="text-sm font-semibold text-ink-2">{loadingText}</span>
              <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-paper-2">
                <span className="block h-full bg-gold transition-[width] duration-300" style={{ width: `${progress && progress.pct >= 0 ? progress.pct : 35}%` }} />
              </span>
            </div>
          )}
          {error && (
            <p role="alert" className="absolute inset-x-0 top-0 m-3 flex w-fit items-center gap-2 rounded-card border border-danger bg-paper px-3 py-2 text-sm font-semibold text-danger">
              <span aria-hidden="true" className="mark mark-tri" />
              {L(lang, 'Nie udało się wczytać modelu 3D. Opis drogi obok jest pełny.', 'Could not load the 3D model. The written route is complete.')}
            </p>
          )}
          {mode === 'model' && shownInfo && (
            <div className="panel pointer-events-none absolute bottom-2 left-2 max-w-[80%] px-3 py-2 shadow-sm">
              <p className="tech-kicker">{shownInfo.deck}</p>
              <p className="tech-title text-lg">{shownInfo.name}</p>
              {shownInfo.zone && <p className="text-sm text-ink-2">{L(lang, 'Strefa', 'Zone')}: {tr(lang, ZONE[shownInfo.zone].name)}</p>}
            </div>
          )}
        </div>
        <p className="mt-2 text-sm text-ink-2">
          {mode === 'model'
            ? L(lang, 'Przeciągnij, aby obrócić; kółko lub dwa palce, aby przybliżyć. Kliknij pomieszczenie, aby zobaczyć nazwę.', 'Drag to rotate; scroll or pinch to zoom. Click a room to see its name.')
            : L(lang, 'Kadłub jest półprzezroczysty, aby widać było drogę w środku.', 'The hull is see-through so the route inside is visible.')}
        </p>
        {evac && <div className="mt-3">{modelPicker}</div>}
        {showCrew && <CrewList lang={lang} data={crew} sel={crewSel} onSelect={pickCrew} onHl={setCrewHl} />}
      </div>

      <aside className={`panel flex min-w-0 flex-col gap-4 p-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start ${evac ? 'order-2' : 'order-3'}`}>
        {mode === 'evac' ? (
          <>
            {bandsAlarm && <BandsPanel lang={lang} data={bands} sel={bandSel} onSelect={pickBand} onLogin={() => openLogin('manual')} />}
            <p className="sr-only" role="status">
              {L(lang, `Droga z: ${ZONE[evZone].name.pl}, do: ${MUSTER[r.muster].name.pl}, ${Math.round(r.distance)} m.`,
                `Route from ${ZONE[evZone].name.en} to ${MUSTER[r.muster].name.en}, ${Math.round(r.distance)} m.`)}
            </p>
            <div>
              <p className="tech-kicker">{L(lang, 'Jesteś tutaj', 'You are here')} · {tr(lang, ZONE[evZone].deck)}</p>
              <p className="font-semibold leading-snug">{tr(lang, ZONE[evZone].name)}</p>
            </div>
            <div className="rounded-card border-2 border-ok p-3">
              <p className="tech-kicker flex items-center gap-2 !text-ok">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M7 21V4" /><path d="M7 4.5h9l-2 3 2 3H7" />
                </svg>
                {L(lang, 'Idź do', 'Go to')}
              </p>
              <h3 className="tech-title mt-1 text-[1.75rem] text-ok">{tr(lang, MUSTER[r.muster].name)}</h3>
              <p className="text-sm text-ink-2">{tr(lang, MUSTER[r.muster].where)}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-card bg-paper-2 px-3 py-2">
                  <dt className="tech-kicker">{L(lang, 'Dystans', 'Distance')}</dt>
                  <dd className="tech-title text-xl tabular-nums sm:text-2xl">{Math.round(r.distance)} m</dd>
                </div>
                <div className="rounded-card bg-paper-2 px-3 py-2">
                  <dt className="tech-kicker">{L(lang, 'Czas marszu', 'Walking time')}</dt>
                  <dd className="tech-title text-xl tabular-nums sm:text-2xl">~{fmtTime(r.seconds)}</dd>
                </div>
              </dl>
            </div>
            {r.detour && r.blocked && (
              <p role="status" className="flex items-start gap-2 rounded-card border-2 border-danger px-3 py-2 font-semibold text-danger">
                <span aria-hidden="true" className="mark mark-tri mt-1" />
                {L(lang, `Objazd: ${STAIRS[r.blocked].name.pl} zablokowane.`, `Detour: ${STAIRS[r.blocked].name.en} blocked.`)}
              </p>
            )}
            {evBlocked && !r.detour && (
              <p className="text-sm text-ink-2">
                {L(lang, 'Zablokowana klatka nie leży na tej drodze.', 'The blocked stairwell is not on this route.')}
              </p>
            )}
            <div>
              <h4 className="tech-kicker mb-2">{L(lang, 'Krok po kroku', 'Step by step')}</h4>
              <ol className="flex flex-col gap-2.5">
                {r.steps.map((s, i) => (
                  <li key={i} className="flex gap-3 leading-snug">
                    <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-ok font-display text-[0.95rem] font-bold text-on-strong">{i + 1}</span>
                    <span className="min-w-0 pt-0.5"><span className="sr-only">{i + 1}. </span>{tr(lang, s)}</span>
                  </li>
                ))}
              </ol>
            </div>
            {!bandsAlarm && <BandsPanel lang={lang} data={bands} sel={bandSel} onSelect={pickBand} onLogin={() => openLogin('manual')} />}
            <EvacCrew lang={lang} data={crew} zone={evZone} routeZones={routeZones} />
            <p className="text-sm text-ink-2">
              {L(lang, 'Szacunek dla spokojnego marszu: 1,2 m/s po pokładzie, 0,6 m/s na schodach, bez tłoku.', 'Estimate at a calm pace: 1.2 m/s on deck, 0.6 m/s on stairs, no crowding.')}
            </p>
          </>
        ) : (
          <>
            {showCrew && crewSel && (
              <div id={crewSelId}>
                <CrewDetail lang={lang} data={crew} sel={crewSel} onSelect={setCrewSel} onClose={() => setCrewSel(null)} />
              </div>
            )}
            <div>
              <h3 className="tech-title text-xl">{L(lang, 'Strefy statku', 'Ship zones')}</h3>
              <p className="text-sm text-ink-2">{L(lang, 'Wybierz strefę, aby ją podświetlić na modelu.', 'Pick a zone to highlight it on the model.')}</p>
            </div>
            <ul className="flex flex-col gap-1">
              {ZONES.map((z) => {
                const on = modelZone === z.id;
                return (
                  <li key={z.id} className="flex items-stretch gap-1">
                    <button type="button" aria-pressed={on} onClick={() => { setPicked(null); setModelZone(on ? null : z.id); }}
                            className={`tap flex-1 rounded-card border px-3 py-1.5 text-left text-sm ${on ? 'border-gold bg-paper-2 font-semibold text-ink' : 'border-line text-ink hover:bg-paper-2'}`}>
                      <span className="block">{tr(lang, z.name)}</span>
                      <span className="block text-sm text-ink-2">{tr(lang, z.deck)}</span>
                    </button>
                    {on && onZone && (
                      <button type="button" onClick={() => onZone(z.id)}
                              className="tap rounded-card bg-ok px-3 text-sm font-semibold leading-tight text-on-strong">
                        {L(lang, 'Droga ewakuacji', 'Evacuation route')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="sr-only" aria-live="polite">{picked ? roomName(lang, picked) : ''}</p>
            <p className="sr-only" aria-live="polite">{crewSelLabel}</p>
          </>
        )}
        <p className="mt-auto border-t border-line pt-3 text-sm text-ink-2">{disclaimer}</p>
      </aside>
    </section>
  );
}
