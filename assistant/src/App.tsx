// App shell: header (wordmark, language toggle), tabs with hash routing, shared state between the panels.
// Tabs: #asystent (chat) | #statek (ShipPanel model) | #ewakuacja (ShipPanel evac) | #cwiczenia (DrillsPanel)
//       | #lacznosc (crew voice / video calls between terminals, src/crew/).
// One ShipPanel instance serves both ship tabs (only its mode changes), so the 10 MB model loads once;
// it stays mounted under `hidden` and pauses itself when not visible.
// The comms panel is mounted from the start (not lazily): a configured terminal must be reachable from every tab,
// its incoming-call dialog is a portal above the whole app.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Assistant from './Assistant';
import { STR } from './i18n';
import type { Lang, Stair } from './types';
import type { ZoneId } from './ship/routes';
import type { DrillId } from './drills/data';
// System anty-rzyg: kropki ruchu przy krawędziach ekranu przeciw chorobie morskiej (jak Vehicle Motion Cues w iOS).
// Zawsze włączony na każdej karcie, bez wyłącznika; sam dobiera intensywność do ruchu statku. Szczegóły: src/motion-cues/.
import MotionCues from './motion-cues/MotionCues';
import CrewVideoChat from './crew/CrewVideoChat';
// Ship alarm system (docs/ALARMS.md): provider = live connection, overlay = full-screen alarm + post-ack banner.
import { AlarmProvider, AlarmOverlay } from './alarm';

const ShipPanel = lazy(() => import('./ship/ShipPanel'));
const DrillsPanel = lazy(() => import('./drills/DrillsPanel'));
const AlarmPanel = lazy(() => import('./alarm/AlarmPanel'));

type Tab = 'asystent' | 'alarmy' | 'statek' | 'ewakuacja' | 'cwiczenia' | 'lacznosc';
// Alarmy right after Asystent: safety-critical
const TABS: Tab[] = ['asystent', 'alarmy', 'statek', 'ewakuacja', 'cwiczenia', 'lacznosc'];

// Phone bottom bar: 6 tabs at 360 px = 60 px each (>= 48 px), so an icon above a short label (desktop: label only).
const TAB_ICON: Record<Tab, string[]> = {
  asystent: ['M4 5h16v11H9l-4 3.5V16H4Z', 'M8 9.5h8', 'M8 12.5h5'],
  alarmy: ['M12 3.5 21 19.5H3Z', 'M12 9.5v4.5', 'M12 16.8v.2'],
  statek: ['M2.5 14.5h19l-2.5 5h-14Z', 'M6 14.5v-4h12v4', 'M9 10.5V7h5v3.5', 'M11.5 7V4'],
  ewakuacja: ['M13.5 4.5a1.5 1.5 0 1 0 0.01 0', 'M10 20l2-5.5 2.5 2.5V20', 'M8 11l3-3h3l2 3.5 2.5 1', 'M12 14.5 11 8'],
  cwiczenia: ['M6 4h12v16H6Z', 'M9 8.5l1.2 1.2L12.5 7.5', 'M9 13.5l1.2 1.2 2.3-2.2', 'M14.5 9h1.5', 'M14.5 14h1.5'],
  lacznosc: ['M5 3.5h4l1.5 4.5-2.5 2 6 6 2-2.5 4.5 1.5v4l-2 1.5h-2L3.5 7.5v-2Z', 'M15 3.5a5.5 5.5 0 0 1 5.5 5.5', 'M14.5 7a2.5 2.5 0 0 1 2.5 2.5'],
};

// Theme: 'auto' follows the device (light, or the dim dark palette when it prefers dark); 'night' = red-on-black
// bridge mode. Stored in localStorage; index.html applies it before the first paint so there is no white flash.
type Theme = 'auto' | 'night';
const THEME_KEY = 'ju-theme';
function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === 'night' ? 'night' : 'auto'; } catch { return 'auto'; }
}

const MoonIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
  </svg>
);

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#/, '');
  return (TABS as string[]).includes(h) ? (h as Tab) : 'asystent';
}

export default function App({ initialLang }: { initialLang: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const s = STR[lang];
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [zone, setZone] = useState<ZoneId | null>(null);
  const [blocked, setBlocked] = useState<Stair | null>(null);
  const [drill, setDrill] = useState<DrillId | null>(null);
  // panels mount on first visit and then stay (hidden) so their state survives tab switches
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set([tabFromHash()]));
  const [typing, setTyping] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [themeLive, setThemeLive] = useState('');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ asystent: null, alarmy: null, statek: null, ewakuacja: null, cwiczenia: null, lacznosc: null });

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    setSeen((prev) => (prev.has(t) ? prev : new Set(prev).add(t)));
    if (location.hash !== '#' + t) history.pushState(null, '', '#' + t);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      setTabState(t);
      setSeen((prev) => (prev.has(t) ? prev : new Set(prev).add(t)));
    };
    addEventListener('hashchange', onHash);
    addEventListener('popstate', onHash);
    return () => { removeEventListener('hashchange', onHash); removeEventListener('popstate', onHash); };
  }, []);

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'night') root.dataset.theme = 'night';
    else if (root.dataset.theme === 'night') delete root.dataset.theme;
    try { if (theme === 'night') localStorage.setItem(THEME_KEY, 'night'); else localStorage.removeItem(THEME_KEY); } catch { /* private mode */ }
    // browser chrome (address bar, status bar) follows the page colour
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--c-page').trim() || '#e6edf1');
  }, [theme]);

  function toggleNight() {
    const next: Theme = theme === 'night' ? 'auto' : 'night';
    setTheme(next);
    setThemeLive(next === 'night' ? s.night_on : s.night_off);
  }

  function changeLang(l: Lang) {
    setLang(l);
    const url = new URL(location.href);
    if (l === 'pl') url.searchParams.delete('lang'); else url.searchParams.set('lang', l);
    history.replaceState(null, '', url);
  }

  // phones: while the chat field has focus the bottom tab bar steps aside for the composer + keyboard
  useEffect(() => {
    const on = (e: FocusEvent) => setTyping(!!(e.target as Element | null)?.closest?.('.asst-dock'));
    const off = () => setTyping(false);
    addEventListener('focusin', on);
    addEventListener('focusout', off);
    return () => { removeEventListener('focusin', on); removeEventListener('focusout', off); };
  }, []);

  const showRoute = useCallback((z: ZoneId, b?: Stair | null) => {
    setZone(z);
    setBlocked(b ?? null);
    setTab('ewakuacja');
  }, [setTab]);
  const openDrill = useCallback((id: DrillId) => {
    setDrill(id);
    setTab('cwiczenia');
  }, [setTab]);

  const label: Record<Tab, string> = {
    asystent: s.tab_assistant, alarmy: s.tab_alarms, statek: s.tab_ship, ewakuacja: s.tab_evac, cwiczenia: s.tab_drills,
    lacznosc: s.tab_comms,
  };
  // shorter phone labels where the desktop one does not fit 72 px
  const short: Partial<Record<Tab, string>> = lang === 'pl' ? { statek: 'Statek' } : { statek: 'Ship', ewakuacja: 'Evac' };
  const openComms = useCallback(() => setTab('lacznosc'), [setTab]);

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.indexOf(tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    setTab(TABS[n]);
    tabRefs.current[TABS[n]]?.focus();
  }

  const shipTab = tab === 'statek' || tab === 'ewakuacja';
  const shipSeen = seen.has('statek') || seen.has('ewakuacja');
  const fallback = (
    <div role="status" className="flex min-h-[40vh] items-center justify-center gap-3 text-ink-2">
      <span aria-hidden="true" className="asst-dots"><i /><i /><i /></span>
      <span className="tech-kicker">{s.loading}</span>
    </div>
  );

  return (
    <AlarmProvider>
    <div className="app min-h-dvh" data-typing={typing || undefined}>
      <header className="app-header sticky top-0 z-30 border-b border-line bg-page">
        <div className="gutter mx-auto flex max-w-6xl items-center gap-3 py-2 lg:gap-4 lg:py-0 lg:pt-1">
          <a href="#asystent" onClick={(e) => { e.preventDefault(); setTab('asystent'); }}
             className="flex min-w-0 flex-col py-1 no-underline lg:py-3">
            <span className="tech-title whitespace-nowrap text-[1.5rem] tracking-[0.06em]">Jantar Unity</span>
            <span className="tech-kicker hidden truncate sm:block lg:hidden xl:block">{s.app_kicker}</span>
          </a>

          <div role="tablist" aria-label={s.tabs_label}
               className="app-tabs fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)]
                          lg:static lg:ml-4 lg:flex lg:self-stretch lg:border-t-0 lg:bg-transparent lg:pb-0">
            {TABS.map((t) => (
              <button key={t} ref={(el) => { tabRefs.current[t] = el; }} type="button" role="tab" id={`tab-${t}`}
                      aria-selected={tab === t} aria-controls={t === 'statek' || t === 'ewakuacja' ? 'panel-ship' : `panel-${t}`}
                      tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={onTabKey}
                      aria-label={short[t] ? label[t] : undefined}
                      className="app-tab relative flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-0.5 px-0.5
                                 text-[0.8125rem] font-semibold leading-tight text-ink-2
                                 hover:text-ink aria-selected:text-ink lg:min-h-[64px] lg:flex-row lg:px-3 lg:text-[0.875rem] lg:uppercase lg:tracking-[0.05em] xl:px-4 xl:text-[0.9375rem]">
                <span className="app-tab-ic lg:hidden">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
                    {TAB_ICON[t].map((d, i) => <path key={i} d={d} />)}
                  </svg>
                </span>
                <span className="max-w-full truncate lg:hidden">{short[t] ?? label[t]}</span>
                <span className="hidden lg:inline">{label[t]}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" aria-pressed={theme === 'night'} onClick={toggleNight} title={s.night}
                    aria-label={s.night}
                    className="hdr-btn tap inline-flex items-center justify-center gap-2 rounded-card border border-line bg-paper px-3 text-sm font-semibold uppercase text-ink-2 hover:text-ink">
              <MoonIcon />
              <span className="hidden sm:inline lg:hidden xl:inline" aria-hidden="true">{s.night_short}</span>
            </button>
            <div role="group" aria-label={s.lang_label} className="flex overflow-hidden rounded-card border border-line bg-paper">
              {(['pl', 'en'] as Lang[]).map((l) => {
                const on = l === 'pl' ? lang === 'pl' : lang !== 'pl';
                return (
                  <button key={l} type="button" aria-pressed={on} lang={l} onClick={() => changeLang(l)}
                          className={`hdr-btn tap px-3 text-sm font-semibold uppercase ${on ? '' : 'text-ink-2 hover:text-ink'}`}>
                    {l}
                  </button>
                );
              })}
            </div>
          </div>
          <p role="status" aria-live="polite" className="sr-only">{themeLive}</p>
        </div>
      </header>

      <main className="app-main">
        <section id="panel-asystent" role="tabpanel" aria-labelledby="tab-asystent" hidden={tab !== 'asystent'}
                 className="gutter mx-auto max-w-3xl pt-4">
          <Assistant lang={lang}
                     onRoute={(z, b) => showRoute(z as ZoneId, b)}
                     onDrill={(id) => openDrill(id as DrillId)} />
        </section>

        <section id="panel-alarmy" role="tabpanel" aria-labelledby="tab-alarmy" hidden={tab !== 'alarmy'}
                 className="gutter mx-auto max-w-6xl py-4">
          {seen.has('alarmy') && (
            <Suspense fallback={fallback}>
              <AlarmPanel lang={lang} />
            </Suspense>
          )}
        </section>

        <section id="panel-ship" role="tabpanel" aria-labelledby={tab === 'ewakuacja' ? 'tab-ewakuacja' : 'tab-statek'}
                 hidden={!shipTab} className="gutter mx-auto max-w-6xl py-4">
          {shipSeen && (
            <Suspense fallback={fallback}>
              <ShipPanel lang={lang} mode={tab === 'ewakuacja' ? 'evac' : 'model'}
                         zone={zone} blocked={blocked}
                         onZone={(z: ZoneId) => { setZone(z); }} />
            </Suspense>
          )}
        </section>

        <section id="panel-cwiczenia" role="tabpanel" aria-labelledby="tab-cwiczenia" hidden={tab !== 'cwiczenia'}
                 className="gutter mx-auto max-w-6xl py-4">
          {seen.has('cwiczenia') && (
            <Suspense fallback={fallback}>
              <DrillsPanel lang={lang} drill={drill} onShowRoute={(z: ZoneId, b?: Stair | null) => showRoute(z, b ?? null)} />
            </Suspense>
          )}
        </section>

        <section id="panel-lacznosc" role="tabpanel" aria-labelledby="tab-lacznosc" hidden={tab !== 'lacznosc'}
                 className="gutter mx-auto max-w-6xl py-4">
          <CrewVideoChat lang={lang} onOpen={openComms} />
        </section>
      </main>

      <AlarmOverlay lang={lang} onShowRoute={(z, b) => showRoute(z, b)} onOpenPanel={() => setTab('alarmy')} />
      <MotionCues lang={lang} />
    </div>
    </AlarmProvider>
  );
}
