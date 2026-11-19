/** "Statystyki" tab: gym ranking (who spent how much time in the ship's gym) and general ship statistics.
 *  Data: GET /api/stats/gym?period=7d|30d|all and GET /api/stats/ship (server/stats.ts, docs/STATS.md).
 *  Charts are hand-drawn inline SVG; every chart has a visible text list or a table next to it.
 *  Refreshes every 30 s while the tab and the page are visible. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Lang } from '../types';

const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);
const REFRESH_MS = 30_000;
/** ranking rows shown before "show everyone" */
const SHORT_LIST = 10;
const TOKEN = (import.meta.env?.VITE_ASSISTANT_TOKEN as string | undefined) || '';

// ---------- API types (mirror of server/stats.ts) ----------
type Period = '7d' | '30d' | 'all';
interface GymPerson { rank: number; name: string; department: string; minutes: number; sessions: number; avgMinutes: number; lastVisit: string | null; ongoing: boolean }
interface GymStats {
  period: Period; room: { code: string; name: string } | null; capMinutes: number;
  totals: { minutes: number; sessions: number; people: number; crew: number };
  ranking: GymPerson[]; top3: GymPerson[];
  departments: { department: string; minutes: number; sessions: number; people: number }[];
}
type Status = 'good' | 'warning' | 'critical';
interface ShipStats {
  now: string;
  crew: { total: number; onboard: number; ashore: number };
  checkins24h: number;
  departments: { department: string; total: number; onboard: number }[];
  decks: { deck: number; name: string; people: number; rooms: number }[];
  watches: { shift: string; total: number; onboard: number }[];
  rooms: {
    total: number; occupied: number;
    busy: { code: string; name: string; deck: number; people: number; capacity: number; occupancy: number }[];
    overCapacity: { code: string; name: string; people: number; capacity: number; occupancy: number }[];
  };
  checkinsPerHour: { start: string; count: number }[];
  staffing: { code: string; name: string; deck: number; minStaff: number; hours: string; active: boolean; people: number; status: Status; coverage24h: number }[];
  alerts: { staffing: { critical: number; warning: number }; lone: { critical: number; warning: number }; lastCheckin: { critical: number; warning: number }; total: number };
  alarms: {
    days: number; total: number; real: number; drill: number; active: boolean;
    ack: { count: number; avgSec: number | null; medianSec: number | null; maxSec: number | null };
    slowestTerminal: { name: string; avgSec: number; acks: number } | null;
  };
  embarked: { last7d: number; last30d: number; medianDaysOnBoard: number | null };
}

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T; at: number } | { state: 'error'; code: number; data?: T };

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (TOKEN) headers['x-assistant-token'] = TOKEN;
  const r = await fetch(url, { headers, signal, credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { code: r.status });
  return (await r.json()) as T;
}

/** Fetch now, then every 30 s while the page is visible and the panel is on screen (App hides inactive tabs). */
function usePoll<T>(url: string, root: RefObject<HTMLElement | null>) {
  const [st, setSt] = useState<Load<T>>({ state: 'loading' });
  const ctl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    try {
      const data = await getJson<T>(url, ac.signal);
      if (!ac.signal.aborted) setSt({ state: 'ok', data, at: Date.now() });
    } catch (e: any) {
      if (ac.signal.aborted) return;
      setSt((prev) => ({ state: 'error', code: typeof e?.code === 'number' ? e.code : 0, data: prev.state === 'loading' ? undefined : prev.data }));
    }
  }, [url]);
  useEffect(() => {
    setSt((prev) => (prev.state === 'ok' ? prev : { state: 'loading' }));
    void load();
    const visible = () => !document.hidden && !!root.current && root.current.offsetParent !== null;
    const id = setInterval(() => { if (visible()) void load(); }, REFRESH_MS);
    const onVis = () => { if (visible()) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); ctl.current?.abort(); };
  }, [load, root]);
  return [st, load] as const;
}

// ---------- formatting ----------
const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const hmLong = (lang: Lang, min: number) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? L(lang, `${h} godz. ${m} min`, `${h} h ${m} min`) : `${m} min`;
};
const locale = (lang: Lang) => (lang === 'pl' ? 'pl-PL' : 'en-GB');
const when = (lang: Lang, iso: string) => new Date(iso).toLocaleString(locale(lang), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hourOf = (lang: Lang, iso: string) => new Date(iso).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' });
const secs = (lang: Lang, s: number | null) => (s === null ? '–' : s < 90 ? `${Math.round(s)} s` : L(lang, `${(s / 60).toFixed(1).replace('.', ',')} min`, `${(s / 60).toFixed(1)} min`));
const pct = (lang: Lang, x: number) => (lang === 'pl' ? `${String(Math.round(x * 10) / 10).replace('.', ',')}%` : `${Math.round(x * 10) / 10}%`);
const plural = (n: number, one: string, few: string, many: string) => {
  if (n === 1) return one;
  const d = n % 10, t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
};
const sessionsTxt = (lang: Lang, n: number) => L(lang, `${n} ${plural(n, 'wizyta', 'wizyty', 'wizyt')}`, `${n} ${n === 1 ? 'session' : 'sessions'}`);
const peopleTxt = (lang: Lang, n: number) => L(lang, `${n} ${plural(n, 'osoba', 'osoby', 'osób')}`, `${n} ${n === 1 ? 'person' : 'people'}`);

const DEPT_EN: Record<string, string> = { 'Pokład': 'Deck', 'Maszynownia': 'Engine', 'Hotel': 'Hotel', 'Medyczny': 'Medical' };
const dept = (lang: Lang, d: string) => (lang === 'pl' ? d : DEPT_EN[d] ?? d);
const watchName = (lang: Lang, s: string) => (s === 'dzienna' ? L(lang, 'dzienna (08–17)', 'day work (08–17)')
  : /^\d\d-\d\d$/.test(s) ? L(lang, `wachta ${s.replace('-', '–')}`, `watch ${s.replace('-', '–')}`) : s);

// ---------- small building blocks ----------
/** One horizontal bar as inline SVG; the number is always written next to it. */
function Bar({ value, max, tone = 'teal', over }: { value: number; max: number; tone?: 'teal' | 'gold' | 'danger'; over?: boolean }) {
  const w = max > 0 ? Math.max(value > 0 ? 1.5 : 0, Math.min(100, (value / max) * 100)) : 0;
  const fill = tone === 'danger' ? 'fill-danger' : tone === 'gold' ? 'fill-gold' : 'fill-teal';
  return (
    <svg className="block h-2.5 w-full" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="100" height="10" rx="2" className="fill-paper-2" />
      {w > 0 && <rect x="0" y="0" width={w} height="10" rx="2" className={fill} />}
      {over && <rect x="99" y="0" width="1" height="10" className="fill-danger" />}
    </svg>
  );
}

function Section({ id, title, kicker, children, aside }: { id: string; title: string; kicker: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="tech-kicker">{kicker}</p>
          <h2 id={id} className="tech-title text-[1.75rem] sm:text-[2rem]">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`panel flex min-w-0 flex-col gap-3 p-4 ${className}`}>
      <h3 id={id} className="tech-title text-lg">{title}</h3>
      {children}
    </section>
  );
}

function StatusMark({ status }: { status: Status }) {
  if (status === 'critical') return <span className="mark mark-tri" aria-hidden="true" />;
  if (status === 'warning') return <span className="mark mark-sq" aria-hidden="true" />;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" className="flex-none">
      <circle cx="7" cy="7" r="6" className="fill-ok" />
    </svg>
  );
}

function Problem({ lang, code, onRetry, what }: { lang: Lang; code: number; onRetry(): void; what: string }) {
  const msg = code === 401
    ? L(lang, 'Statystyki są dostępne po zalogowaniu.', 'Statistics are available after you sign in.')
    : code === 503
      ? L(lang, 'Baza załogi jest teraz niedostępna.', 'The crew database is unavailable right now.')
      : code === 429
        ? L(lang, 'Za dużo zapytań. Spróbuj za chwilę.', 'Too many requests. Try again in a moment.')
        : L(lang, `Nie udało się wczytać: ${what}.`, `Could not load: ${what}.`);
  return (
    <div role="alert" className="panel flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="flex items-center gap-2 text-ink"><span className="mark mark-tri" aria-hidden="true" />{msg}</p>
      {code !== 401 && (
        <button type="button" onClick={onRetry} className="tap rounded-card border border-line bg-paper px-4 font-semibold text-ink hover:bg-paper-2">
          {L(lang, 'Spróbuj ponownie', 'Try again')}
        </button>
      )}
    </div>
  );
}

const Loading = ({ lang }: { lang: Lang }) => (
  <p role="status" className="panel p-4 text-ink-2">{L(lang, 'Wczytywanie…', 'Loading…')}</p>
);

// ---------- gym ----------
const PERIODS: { id: Period; pl: string; en: string }[] = [
  { id: '7d', pl: '7 dni', en: '7 days' },
  { id: '30d', pl: '30 dni', en: '30 days' },
  { id: 'all', pl: 'wszystko', en: 'all time' },
];

function Podium({ lang, top }: { lang: Lang; top: GymPerson[] }) {
  // visual order 2-1-3 from tablet up (podium), 1-2-3 on phones; DOM order stays 1-2-3 for screen readers
  const order = ['sm:order-2', 'sm:order-1', 'sm:order-3'];
  const lift = ['sm:pt-8', 'sm:pt-4', 'sm:pt-2'];
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end" aria-label={L(lang, 'Podium: trzy pierwsze miejsca', 'Podium: top three')}>
      {top.map((p, i) => (
        <li key={i} className={`${order[i]} panel flex flex-col gap-1 p-4 ${lift[i]} ${p.rank === 1 ? 'border-2 border-gold' : ''}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="tech-title text-[2.5rem] leading-none" aria-label={L(lang, `Miejsce ${p.rank}`, `Place ${p.rank}`)}>{p.rank}</span>
            <span className="tech-title text-2xl tabular-nums" aria-label={hmLong(lang, p.minutes)}>{hm(p.minutes)}</span>
          </div>
          <p className="truncate text-lg font-semibold text-ink">{p.name}</p>
          <p className="text-sm text-ink-2">{dept(lang, p.department)} · {sessionsTxt(lang, p.sessions)}</p>
        </li>
      ))}
    </ol>
  );
}

function GymSection({ lang, root }: { lang: Lang; root: RefObject<HTMLElement | null> }) {
  const [period, setPeriod] = useState<Period>('7d');
  const [showAll, setShowAll] = useState(false);
  const [st, reload] = usePoll<GymStats>(`/api/stats/gym?period=${period}`, root);
  const data = st.state === 'ok' ? st.data : st.state === 'error' ? st.data : undefined;
  const max = data?.ranking[0]?.minutes ?? 0;
  const deptMax = Math.max(0, ...(data?.departments.map((d) => d.minutes) ?? [0]));

  const switcher = (
    <div role="group" aria-label={L(lang, 'Okres', 'Period')} className="flex overflow-hidden rounded-card border border-line bg-paper">
      {PERIODS.map((p) => (
        <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}
                className={`tap px-4 text-sm font-semibold ${period === p.id ? 'bg-navy text-on-strong' : 'text-ink-2 hover:text-ink'}`}>
          {L(lang, p.pl, p.en)}
        </button>
      ))}
    </div>
  );

  return (
    <Section id="stats-gym" kicker={L(lang, 'Rekreacja', 'Recreation')} title={L(lang, 'Ranking siłowni', 'Gym ranking')} aside={switcher}>
      <p className="text-sm text-ink-2">
        {L(lang,
          'Udział jest dobrowolny. Ranking pokazuje wyłącznie czas spędzony w siłowni (z odbić kart przy wejściu), bez innych danych osobowych (RODO).',
          'Taking part is voluntary. The ranking shows only time spent in the gym (from card check-ins), no other personal data (GDPR).')}
      </p>
      {st.state === 'loading' && <Loading lang={lang} />}
      {st.state === 'error' && <Problem lang={lang} code={st.code} onRetry={reload} what={L(lang, 'ranking siłowni', 'gym ranking')} />}
      {data && !data.room && (
        <p className="panel p-4 text-ink-2">{L(lang, 'W bazie nie ma pomieszczenia „Siłownia”.', 'There is no gym room in the crew database.')}</p>
      )}
      {data && data.room && data.ranking.length === 0 && (
        <p className="panel p-4 text-ink-2">{L(lang, 'Nikt nie odwiedził siłowni w tym okresie.', 'Nobody used the gym in this period.')}</p>
      )}
      {data && data.ranking.length > 0 && (
        <>
          <p className="text-ink" aria-live="polite">
            {L(lang,
              `Razem ${hmLong(lang, data.totals.minutes)} w ${data.totals.sessions} ${plural(data.totals.sessions, 'wizycie', 'wizytach', 'wizytach')}; trenowało ${data.totals.people} z ${data.totals.crew} osób załogi.`,
              `In total ${hmLong(lang, data.totals.minutes)} over ${data.totals.sessions} sessions; ${data.totals.people} of ${data.totals.crew} crew trained.`)}
          </p>
          <Podium lang={lang} top={data.top3} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={L(lang, 'Cała załoga', 'Whole crew')} className="lg:col-span-2">
              <ol className="flex flex-col divide-y divide-line">
                {data.ranking.slice(0, showAll ? undefined : SHORT_LIST).map((p, i) => (
                  <li key={i} className="grid grid-cols-[2.25rem_1fr_auto] items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="tech-title text-xl tabular-nums text-ink-2" aria-label={L(lang, `Miejsce ${p.rank}`, `Place ${p.rank}`)}>{p.rank}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ink">{p.name}</span>
                      <span className="block text-xs text-ink-2">
                        {dept(lang, p.department)} · {sessionsTxt(lang, p.sessions)} · {L(lang, 'śr.', 'avg')} {p.avgMinutes} min
                        {p.lastVisit && <> · {p.ongoing ? L(lang, 'teraz w siłowni', 'in the gym now') : `${L(lang, 'ostatnio', 'last')} ${when(lang, p.lastVisit)}`}</>}
                      </span>
                    </span>
                    <span className="text-right text-lg font-semibold tabular-nums text-ink" aria-label={hmLong(lang, p.minutes)}>{hm(p.minutes)}</span>
                    <span className="col-start-2 col-end-4"><Bar value={p.minutes} max={max} tone={p.rank === 1 ? 'gold' : 'teal'} /></span>
                  </li>
                ))}
              </ol>
              {data.ranking.length > SHORT_LIST && (
                <button type="button" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}
                        className="tap self-start rounded-card border border-line bg-paper px-4 font-semibold text-ink hover:bg-paper-2">
                  {showAll ? L(lang, `Pokaż pierwsze ${SHORT_LIST}`, `Show top ${SHORT_LIST}`)
                    : L(lang, `Pokaż wszystkich (${data.ranking.length})`, `Show everyone (${data.ranking.length})`)}
                </button>
              )}
              <p className="text-xs text-ink-2">
                {L(lang,
                  `Czas w godzinach:minutach. Wizyta trwa od odbicia w siłowni do następnego odbicia gdziekolwiek; jedna wizyta liczy się najwyżej ${data.capMinutes / 60} godz.`,
                  `Time in hours:minutes. A session lasts from the gym check-in to the next check-in anywhere; one session counts at most ${data.capMinutes / 60} h.`)}
              </p>
            </Card>
            <Card title={L(lang, 'Działy', 'Departments')}>
              <ul className="flex flex-col gap-3">
                {data.departments.map((d) => (
                  <li key={d.department} className="flex flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-ink">{dept(lang, d.department)}</span>
                      <span className="tabular-nums text-ink" aria-label={hmLong(lang, d.minutes)}>{hm(d.minutes)}</span>
                    </span>
                    <Bar value={d.minutes} max={deptMax} />
                    <span className="text-xs text-ink-2">{peopleTxt(lang, d.people)} · {sessionsTxt(lang, d.sessions)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </Section>
  );
}

// ---------- ship ----------
function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'danger' | 'gold' }) {
  return (
    <div className="panel flex min-w-0 flex-col gap-1 p-4">
      <span className="tech-kicker">{label}</span>
      <span className={`tech-title text-[2.25rem] leading-none tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'gold' ? 'text-gold-ink' : ''}`} style={{ textTransform: 'none' }}>{value}</span>
      {note && <span className="text-xs text-ink-2">{note}</span>}
    </div>
  );
}

/** Check-ins per hour: 24 vertical bars, hour ticks every 6 h, peak + total in the caption, full table on demand. */
function HourChart({ lang, buckets }: { lang: Lang; buckets: ShipStats['checkinsPerHour'] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const peak = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
  const quiet = buckets.slice(0, -1).reduce((a, b) => (b.count < a.count ? b : a), buckets[0]);
  const W = 240, H = 104, top = 12, base = 80, bw = W / 24;
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" focusable="false"
           aria-label={L(lang, `Odbicia na godzinę, ostatnie 24 godziny. Razem ${total}.`, `Check-ins per hour, last 24 hours. Total ${total}.`)}>
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={base - (base - top) * f} y2={base - (base - top) * f} className="stroke-line" strokeWidth="0.5" strokeDasharray="2 2" />
        ))}
        <text x="1" y={top - 2} className="fill-ink-2" fontSize="10">{max}</text>
        {buckets.map((b, i) => {
          const h = ((base - top) * b.count) / max;
          const current = i === buckets.length - 1;
          return (
            <g key={b.start}>
              <title>{`${hourOf(lang, b.start)}: ${b.count}${current ? L(lang, ' (bieżąca godzina)', ' (current hour)') : ''}`}</title>
              <rect x={i * bw} y={top} width={bw} height={base - top} fill="transparent" />
              {b.count > 0 && <rect x={i * bw + 1} y={base - h} width={bw - 2} height={h} rx="1" className={current ? 'fill-gold' : 'fill-teal'} />}
              {i % 6 === 0 && <text x={i * bw + bw / 2} y={base + 14} textAnchor="middle" className="fill-ink-2" fontSize="10">{hourOf(lang, b.start).slice(0, 2)}</text>}
            </g>
          );
        })}
        <line x1="0" x2={W} y1={base} y2={base} className="stroke-ink-2" strokeWidth="0.75" />
      </svg>
      <figcaption className="text-sm text-ink-2">
        {L(lang,
          `Razem ${total} odbić. Najwięcej o ${hourOf(lang, peak.start)} (${peak.count}), najmniej o ${hourOf(lang, quiet.start)} (${quiet.count}). Pomarańczowy słupek to bieżąca, niepełna godzina.`,
          `${total} check-ins in total. Busiest at ${hourOf(lang, peak.start)} (${peak.count}), quietest at ${hourOf(lang, quiet.start)} (${quiet.count}). The orange bar is the current, unfinished hour.`)}
      </figcaption>
      <details className="text-sm">
        <summary className="tap inline-flex cursor-pointer items-center font-semibold text-ink">{L(lang, 'Pokaż tabelę', 'Show table')}</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead><tr className="text-ink-2"><th className="py-1 font-semibold">{L(lang, 'Godzina', 'Hour')}</th><th className="py-1 text-right font-semibold">{L(lang, 'Odbicia', 'Check-ins')}</th></tr></thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.start} className="border-t border-line"><td className="py-1">{hourOf(lang, b.start)}</td><td className="py-1 text-right">{b.count}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function BarList({ rows }: { rows: { key: string; label: string; value: number; max: number; text: string; note?: string; tone?: 'teal' | 'gold' | 'danger'; over?: boolean }[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-semibold text-ink">{r.label}</span>
            <span className="flex-none tabular-nums text-ink">{r.text}</span>
          </span>
          <Bar value={r.value} max={r.max} tone={r.tone} over={r.over} />
          {r.note && <span className="text-xs text-ink-2">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function ShipSection({ lang, root }: { lang: Lang; root: RefObject<HTMLElement | null> }) {
  const [st, reload] = usePoll<ShipStats>('/api/stats/ship', root);
  const data = st.state === 'ok' ? st.data : st.state === 'error' ? st.data : undefined;
  const updated = st.state === 'ok' ? new Date(st.at).toLocaleTimeString(locale(lang)) : null;
  return (
    <Section id="stats-ship" kicker="MF Jantar Unity" title={L(lang, 'Statystyki statku', 'Ship statistics')}
             aside={updated && <p className="text-xs text-ink-2" aria-live="off">{L(lang, 'Aktualizacja', 'Updated')} {updated}</p>}>
      {st.state === 'loading' && <Loading lang={lang} />}
      {st.state === 'error' && <Problem lang={lang} code={st.code} onRetry={reload} what={L(lang, 'statystyki statku', 'ship statistics')} />}
      {data && <ShipBody lang={lang} d={data} />}
    </Section>
  );
}

function ShipBody({ lang, d }: { lang: Lang; d: ShipStats }) {
  const a = d.alarms;
  const deptMax = Math.max(1, ...d.departments.map((x) => x.total));
  const deckMax = Math.max(1, ...d.decks.map((x) => x.people));
  const watchMax = Math.max(1, ...d.watches.map((x) => x.total));
  const statusWord = (s: Status) => (s === 'good' ? L(lang, 'obsada pełna', 'fully staffed') : s === 'warning' ? L(lang, 'niepełna obsada', 'understaffed') : L(lang, 'brak obsady', 'unstaffed'));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={L(lang, 'Na pokładzie', 'On board')} value={String(d.crew.onboard)} note={L(lang, `z ${d.crew.total} osób załogi`, `of ${d.crew.total} crew`)} />
        <Kpi label={L(lang, 'Na lądzie', 'Ashore')} value={String(d.crew.ashore)} note={L(lang, 'ostatnie odbicie: wyjście lub brak', 'last check-in: out or none')} />
        <Kpi label={L(lang, 'Aktywne alerty', 'Active alerts')} value={String(d.alerts.total)} tone={d.alerts.total ? 'gold' : undefined}
             note={L(lang,
               `obsada ${d.alerts.staffing.critical + d.alerts.staffing.warning} · samotna praca ${d.alerts.lone.critical + d.alerts.lone.warning} · brak odbicia ${d.alerts.lastCheckin.critical + d.alerts.lastCheckin.warning}`,
               `staffing ${d.alerts.staffing.critical + d.alerts.staffing.warning} · lone work ${d.alerts.lone.critical + d.alerts.lone.warning} · no check-in ${d.alerts.lastCheckin.critical + d.alerts.lastCheckin.warning}`)} />
        <Kpi label={L(lang, 'Śr. czas potwierdzenia', 'Avg. alarm ack time')} value={secs(lang, a.ack.avgSec)}
             note={a.ack.count ? L(lang, `mediana ${secs(lang, a.ack.medianSec)} · ${a.ack.count} potwierdzeń`, `median ${secs(lang, a.ack.medianSec)} · ${a.ack.count} acks`)
               : L(lang, `brak potwierdzeń w ${a.days} dniach`, `no acks in ${a.days} days`)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={L(lang, 'Odbicia na godzinę (24 h)', 'Check-ins per hour (24 h)')} className="lg:col-span-2">
          <HourChart lang={lang} buckets={d.checkinsPerHour} />
        </Card>
        <Card title={L(lang, 'Obsada kluczowych pomieszczeń', 'Key room staffing')}>
          {d.staffing.length === 0 ? <p className="text-ink-2">{L(lang, 'Brak pomieszczeń z wymaganą obsadą.', 'No rooms with required staffing.')}</p> : (
            <ul className="flex flex-col gap-3">
              {d.staffing.map((s) => (
                <li key={s.code} className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 font-semibold text-ink"><StatusMark status={s.status} />{s.name}</span>
                  <span className="text-sm text-ink">
                    {statusWord(s.status)}: {s.people} / {L(lang, 'min.', 'min')} {s.minStaff}
                    {!s.active && L(lang, ' (poza godzinami obsady)', ' (outside staffed hours)')}
                  </span>
                  <Bar value={s.coverage24h} max={100} tone={s.coverage24h < 90 ? 'gold' : 'teal'} />
                  <span className="text-xs text-ink-2">{L(lang, `pełna obsada przez ${pct(lang, s.coverage24h)} ostatnich 24 h (godz. ${s.hours})`, `fully staffed ${pct(lang, s.coverage24h)} of the last 24 h (hours ${s.hours})`)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card title={L(lang, 'Załoga według działów', 'Crew by department')}>
          <BarList rows={d.departments.map((x) => ({
            key: x.department, label: dept(lang, x.department), value: x.onboard, max: deptMax,
            text: `${x.onboard} / ${x.total}`, note: L(lang, `${x.onboard} na pokładzie z ${x.total}`, `${x.onboard} on board of ${x.total}`),
          }))} />
        </Card>
        <Card title={L(lang, 'Osoby na pokładach teraz', 'People per deck now')}>
          <BarList rows={d.decks.map((x) => ({
            key: String(x.deck), label: `${L(lang, 'Pokład', 'Deck')} ${x.deck}`, value: x.people, max: deckMax,
            text: String(x.people), note: x.name,
          }))} />
        </Card>
        <Card title={L(lang, 'Najbardziej zajęte pomieszczenia', 'Busiest rooms')}>
          {d.rooms.overCapacity.length > 0 && (
            <p role="status" className="flex items-start gap-2 text-sm font-semibold text-danger">
              <span className="mark mark-tri mt-1" aria-hidden="true" />
              {L(lang, 'Przekroczona pojemność: ', 'Over capacity: ')}{d.rooms.overCapacity.map((r) => `${r.name} (${r.people}/${r.capacity})`).join(', ')}
            </p>
          )}
          {d.rooms.busy.length === 0 ? <p className="text-ink-2">{L(lang, 'Nikt nie jest teraz odbity w pomieszczeniach.', 'Nobody is checked in anywhere right now.')}</p> : (
            <BarList rows={d.rooms.busy.map((r) => ({
              key: r.code, label: r.name, value: Math.min(r.occupancy, 100), max: 100,
              text: `${r.people}/${r.capacity}`,
              note: `${r.code} · ${L(lang, 'obłożenie', 'occupancy')} ${pct(lang, r.occupancy)}${r.occupancy >= 100 ? L(lang, ' · przekroczone', ' · over capacity') : r.occupancy >= 70 ? L(lang, ' · wysokie', ' · high') : ''}`,
              tone: r.occupancy >= 100 ? 'danger' : r.occupancy >= 70 ? 'gold' : 'teal', over: r.occupancy > 100,
            }))} />
          )}
          <p className="text-xs text-ink-2">{L(lang, `Zajęte ${d.rooms.occupied} z ${d.rooms.total} pomieszczeń.`, `${d.rooms.occupied} of ${d.rooms.total} rooms occupied.`)}</p>
        </Card>
        <Card title={L(lang, `Alarmy (${a.days} dni)`, `Alarms (${a.days} days)`)}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-ink">
            <dt>{L(lang, 'Wszystkie', 'All')}</dt><dd className="text-right font-semibold tabular-nums">{a.total}</dd>
            <dt>{L(lang, 'Prawdziwe', 'Real')}</dt><dd className="text-right font-semibold tabular-nums">{a.real}</dd>
            <dt>{L(lang, 'Ćwiczenia', 'Drills')}</dt><dd className="text-right font-semibold tabular-nums">{a.drill}</dd>
            <dt>{L(lang, 'Średni czas potwierdzenia', 'Average ack time')}</dt><dd className="text-right font-semibold tabular-nums">{secs(lang, a.ack.avgSec)}</dd>
            <dt>{L(lang, 'Mediana', 'Median')}</dt><dd className="text-right font-semibold tabular-nums">{secs(lang, a.ack.medianSec)}</dd>
            <dt>{L(lang, 'Najdłuższy', 'Slowest')}</dt><dd className="text-right font-semibold tabular-nums">{secs(lang, a.ack.maxSec)}</dd>
          </dl>
          <p className="text-sm text-ink-2">
            {a.slowestTerminal
              ? L(lang, `Najwolniej potwierdza: ${a.slowestTerminal.name} (śr. ${secs(lang, a.slowestTerminal.avgSec)}, ${a.slowestTerminal.acks}×).`,
                  `Slowest terminal: ${a.slowestTerminal.name} (avg ${secs(lang, a.slowestTerminal.avgSec)}, ${a.slowestTerminal.acks}×).`)
              : L(lang, 'Brak potwierdzeń do porównania.', 'No acknowledgements to compare.')}
            {a.active && <strong className="ml-1 text-danger">{L(lang, 'Alarm trwa teraz.', 'An alarm is active now.')}</strong>}
          </p>
        </Card>
        <Card title={L(lang, 'Wachty', 'Watches')}>
          <BarList rows={d.watches.map((w) => ({
            key: w.shift, label: watchName(lang, w.shift), value: w.total, max: watchMax,
            text: String(w.total), note: L(lang, `${w.onboard} na pokładzie`, `${w.onboard} on board`),
          }))} />
        </Card>
        <Card title={L(lang, 'Zaokrętowania', 'Embarkations')}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-ink">
            <dt>{L(lang, 'Ostatnie 7 dni', 'Last 7 days')}</dt><dd className="text-right font-semibold tabular-nums">{d.embarked.last7d}</dd>
            <dt>{L(lang, 'Ostatnie 30 dni', 'Last 30 days')}</dt><dd className="text-right font-semibold tabular-nums">{d.embarked.last30d}</dd>
            <dt>{L(lang, 'Mediana dni na statku', 'Median days on board')}</dt><dd className="text-right font-semibold tabular-nums">{d.embarked.medianDaysOnBoard ?? '–'}</dd>
            <dt>{L(lang, 'Odbicia w 24 h', 'Check-ins in 24 h')}</dt><dd className="text-right font-semibold tabular-nums">{d.checkins24h}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

export default function StatsPanel({ lang }: { lang: Lang }) {
  const root = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={root} className="flex flex-col gap-8 pb-6" lang={lang === 'pl' ? 'pl' : 'en'}>
      <GymSection lang={lang} root={root} />
      <ShipSection lang={lang} root={root} />
    </div>
  );
}
