/** Login sheet: crew card / wristband (USB reader = keyboard wedge, or the number typed) or person + PIN.
 *  Bottom sheet on phones, centred panel from 640 px. Big targets (PIN keys 64 px) so it works with gloves.
 *  Polish first; errors in plain words. Opened from the header button, or by useAuth().openLogin(reason). */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../types';
import { useAuth, type LoginError, type LoginReason, type LoginResult, type RosterMember } from './AuthProvider';
import RoleBadge, { L } from './RoleBadge';
import './auth.css';

type Step = 'start' | 'pick' | 'pin';

const REASON: Record<LoginReason, [string, string] | null> = {
  manual: null,
  crew: ['Kto jest gdzie na statku widzi tylko zalogowana załoga.', 'Only logged-in crew can see who is where on board.'],
  alarm: ['Alarmy ogłasza i kończy zalogowany oficer mostka albo kapitan.', 'Alarms are raised and ended by a logged-in bridge officer or the master.'],
  comms: ['Łączność między terminalami jest dla zalogowanej załogi.', 'Calls between terminals are for logged-in crew.'],
};

function errorText(lang: Lang, e: LoginError): string {
  const min = (s: number) => Math.max(1, Math.ceil(s / 60));
  switch (e.code) {
    case 'bad-credentials':
      return e.left > 0
        ? L(lang, `Nieprawidłowy PIN. Pozostało prób: ${e.left}.`, `Wrong PIN. Attempts left: ${e.left}.`)
        : L(lang, 'Nieprawidłowy PIN.', 'Wrong PIN.');
    case 'locked':
      return L(lang, `Za dużo błędnych PIN-ów. Konto zablokowane na ${min(e.retryAfter)} min. Użyj karty albo zgłoś się do oficera.`,
        `Too many wrong PINs. Account locked for ${min(e.retryAfter)} min. Use your card or ask an officer.`);
    case 'rate':
      return L(lang, `Za dużo prób z tego terminala. Spróbuj za ${e.retryAfter} s.`, `Too many attempts from this terminal. Try again in ${e.retryAfter} s.`);
    case 'unknown-card':
      return L(lang, 'Nie znamy tej karty ani opaski. Zaloguj się PIN-em albo zgłoś kartę oficerowi.', 'Unknown card or wristband. Log in with your PIN or report the card to an officer.');
    case 'bad-request':
      return L(lang, 'Niepełne dane. PIN ma od 4 do 6 cyfr.', 'Incomplete input. The PIN has 4 to 6 digits.');
    case 'offline':
      return L(lang, 'Brak połączenia z serwerem statku. Spróbuj ponownie.', 'No connection to the ship server. Try again.');
    default:
      return L(lang, 'Logowanie chwilowo niedostępne. Spróbuj ponownie.', 'Login is unavailable right now. Try again.');
  }
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
const DEPT_ORDER = ['Pokład', 'Maszynownia', 'Hotel', 'Medyczny'];

const CardIcon = () => (
  <svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="6" y="18" width="30" height="22" rx="3" />
    <path d="M11 33h10" /><path d="M11 27h5" />
    <path className="auth-wave" d="M41 22a9 9 0 0 1 0 14" />
    <path className="auth-wave auth-wave-2" d="M45.5 17.5a15 15 0 0 1 0 23" />
  </svg>
);

export default function LoginSheet({ lang }: { lang: Lang }) {
  const { sheet, user } = useAuth();
  if (!sheet.open || user) return null;
  return createPortal(<Sheet lang={lang} reason={sheet.reason} />, document.body);
}

function Sheet({ lang, reason }: { lang: Lang; reason: LoginReason }) {
  const { closeLogin, loginPin, loginRfid, loginTest, fetchRoster } = useAuth();
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>('start');
  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [rosterState, setRosterState] = useState<'loading' | 'ok' | 'down'>('loading');
  const [hasRfid, setHasRfid] = useState(true);
  const [testMode, setTestMode] = useState(false);
  const [who, setWho] = useState<RosterMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  const loadRoster = useCallback(() => {
    setRosterState('loading');
    fetchRoster().then((r) => {
      if (r && Array.isArray(r.members) && r.members.length) { setRoster(r.members); setHasRfid(r.rfid); setTestMode(!!r.testMode); setRosterState('ok'); }
      else setRosterState('down');
    });
  }, [fetchRoster]);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  // focus: into the sheet on open, back to where it was on close; Esc closes; Tab stays inside
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); closeLogin(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const finish = useCallback((r: LoginResult) => {
    setBusy(false);
    if (!r.ok) setError(errorText(lang, r.error));
    return r.ok;
  }, [lang]);

  const submitRfid = useCallback(async (uid: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setScanned(true);
    finish(await loginRfid(uid));
    window.setTimeout(() => setScanned(false), 600);
  }, [busy, finish, loginRfid]);

  // USB card readers are keyboards: hex / decimal characters in a quick burst, then Enter
  const buf = useRef({ s: '', t: 0 });
  useEffect(() => {
    if (step !== 'start') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const now = performance.now();
      if (now - buf.current.t > 120) buf.current.s = '';
      buf.current.t = now;
      if (e.key === 'Enter') {
        const s = buf.current.s;
        buf.current.s = '';
        if (s.replace(/[^0-9a-f]/gi, '').length >= 8) { e.preventDefault(); void submitRfid(s); }
        return;
      }
      if (e.key.length === 1 && /[0-9a-f:\- ]/i.test(e.key)) buf.current.s += e.key;
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [step, submitRfid]);

  return (
    <div className="auth-scrim fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6"
         onMouseDown={(e) => { if (e.target === e.currentTarget) closeLogin(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${ids}-t`} tabIndex={-1} onKeyDown={onKeyDown}
           className="auth-sheet panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-b-none sm:max-w-[30rem] sm:rounded-card">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          {step !== 'start' && (
            <button type="button" onClick={() => { setError(null); setStep(step === 'pin' ? 'pick' : 'start'); }}
                    className="tap -ml-2 inline-flex items-center gap-1 rounded-card px-2 font-semibold text-ink-2 hover:text-ink">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
              {L(lang, 'Wstecz', 'Back')}
            </button>
          )}
          <h2 id={`${ids}-t`} className="tech-title mr-auto text-[1.5rem]">
            {step === 'pin' ? L(lang, 'Wpisz PIN', 'Enter PIN') : step === 'pick' ? L(lang, 'Kim jesteś?', 'Who are you?') : L(lang, 'Logowanie załogi', 'Crew login')}
          </h2>
          <button type="button" onClick={closeLogin} aria-label={L(lang, 'Zamknij', 'Close')}
                  className="tap -mr-2 inline-flex items-center justify-center rounded-card text-ink-2 hover:text-ink">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {REASON[reason] && step === 'start' && (
            <p className="mb-3 border-l-4 border-gold pl-3 text-sm">{L(lang, ...REASON[reason]!)}</p>
          )}
          {error && <p role="alert" className="mb-3 rounded-card border-2 border-danger p-3 font-semibold text-danger">{error}</p>}

          {step === 'start' && (
            <StartStep lang={lang} busy={busy} scanned={scanned} hasRfid={hasRfid} onRfid={submitRfid}
                       onPick={() => { setError(null); setStep('pick'); }} />
          )}
          {testMode && step !== 'pin' && (
            <p className="mb-3 rounded-card border-2 border-gold p-3 text-sm font-semibold">
              {L(lang, 'Tryb testowy: wybierz osobę, logowanie bez PIN-u.', 'Test mode: pick a person, no PIN needed.')}
            </p>
          )}
          {step === 'pick' && (
            <PickStep lang={lang} roster={roster} state={rosterState} onRetry={loadRoster}
                      onChoose={(m) => {
                        setWho(m); setError(null);
                        if (testMode) { setBusy(true); void loginTest(m.id).then(finish); } else setStep('pin');
                      }} />
          )}
          {step === 'pin' && who && (
            <PinStep lang={lang} who={who} busy={busy}
                     onSubmit={async (pin) => { setBusy(true); setError(null); return finish(await loginPin(who.id, pin)); }} />
          )}
        </div>
      </div>
    </div>
  );
}

function StartStep({ lang, busy, scanned, hasRfid, onRfid, onPick }: {
  lang: Lang; busy: boolean; scanned: boolean; hasRfid: boolean; onRfid(uid: string): void; onPick(): void;
}) {
  const [manual, setManual] = useState(false);
  const [uid, setUid] = useState('');
  const valid = uid.replace(/[^0-9a-f]/gi, '').length >= 8;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) onRfid(uid);
  }
  return (
    <div className="flex flex-col gap-4">
      <section className="auth-reader flex items-center gap-4 rounded-card border-2 border-dashed border-line p-4" data-busy={busy || scanned || undefined}
               aria-describedby="auth-reader-hint">
        <span className="text-gold-ink"><CardIcon /></span>
        <div className="min-w-0">
          <p className="tech-title text-[1.375rem]">{L(lang, 'Zbliż kartę lub opaskę', 'Tap your card or wristband')}</p>
          <p id="auth-reader-hint" className="text-sm text-ink-2" role="status">
            {busy ? L(lang, 'Sprawdzam…', 'Checking…')
              : hasRfid ? L(lang, 'Czytnik przy terminalu odczyta numer sam.', 'The reader at this terminal reads the number by itself.')
              : L(lang, 'W bazie załogi nie ma jeszcze wydanych kart. Użyj PIN-u.', 'No cards issued in the crew database yet. Use your PIN.')}
          </p>
        </div>
      </section>
      {!manual ? (
        <button type="button" onClick={() => setManual(true)} className="tap self-start text-sm font-semibold text-ink-2 underline underline-offset-4 hover:text-ink">
          {L(lang, 'Czytnik nie działa? Wpisz numer karty', 'Reader not working? Type the card number')}
        </button>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="tech-kicker">{L(lang, 'Numer karty (UID)', 'Card number (UID)')}</span>
            <input autoFocus value={uid} onChange={(e) => setUid(e.target.value.slice(0, 40))} inputMode="text" autoComplete="off" spellCheck={false}
                   placeholder="04:A3:1F:5B:C2:6E:80"
                   className="min-h-[56px] rounded-card border border-line bg-paper px-3 font-mono text-lg uppercase tracking-wider" />
          </label>
          <button type="submit" disabled={!valid || busy} className="tap-lg min-h-[56px] rounded-card bg-navy px-4 font-bold text-on-strong disabled:opacity-50">
            {L(lang, 'Zaloguj kartą', 'Log in with card')}
          </button>
        </form>
      )}
      <div className="flex items-center gap-3 text-ink-2" aria-hidden="true">
        <span className="h-px flex-1 bg-line" /><span className="tech-kicker">{L(lang, 'albo', 'or')}</span><span className="h-px flex-1 bg-line" />
      </div>
      <button type="button" onClick={onPick}
              className="tap-lg flex min-h-[56px] items-center justify-between gap-3 rounded-card border-2 border-ink bg-paper px-4 text-left font-bold hover:bg-paper-2">
        <span>{L(lang, 'Wybierz siebie z listy i wpisz PIN', 'Pick yourself from the list and enter your PIN')}</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </button>
    </div>
  );
}

function PickStep({ lang, roster, state, onRetry, onChoose }: {
  lang: Lang; roster: RosterMember[] | null; state: 'loading' | 'ok' | 'down'; onRetry(): void; onChoose(m: RosterMember): void;
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hits = (roster ?? []).filter((m) => { const h = fold(`${m.name} ${m.rank} ${m.department}`); return words.every((w) => h.includes(w)); });
    const by = new Map<string, RosterMember[]>();
    for (const m of hits) by.set(m.department || '-', [...(by.get(m.department || '-') ?? []), m]);
    return [...by].sort(([a], [b]) => ((DEPT_ORDER.indexOf(a) + 1 || 99) - (DEPT_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b, 'pl'));
  }, [roster, q]);

  if (state === 'loading') return <p role="status" className="py-6 text-center text-ink-2">{L(lang, 'Wczytuję listę załogi…', 'Loading the crew list…')}</p>;
  if (state === 'down') {
    return (
      <div className="flex flex-col items-start gap-3 py-4">
        <p>{L(lang, 'Lista załogi jest teraz niedostępna. Zaloguj się kartą albo spróbuj za chwilę.', 'The crew list is unavailable right now. Use your card or try again shortly.')}</p>
        <button type="button" onClick={onRetry} className="tap min-h-[48px] rounded-card border border-line bg-paper px-4 font-semibold">{L(lang, 'Spróbuj ponownie', 'Try again')}</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <label className="sticky top-0 z-10 -mx-4 bg-paper px-4 pb-2">
        <span className="sr-only">{L(lang, 'Szukaj osoby', 'Search')}</span>
        <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
               placeholder={L(lang, 'Szukaj: nazwisko, stopień…', 'Search: name, rank…')}
               className="min-h-[56px] w-full rounded-card border border-line bg-paper px-3 text-lg" />
      </label>
      {!groups.length && <p className="py-4 text-ink-2">{L(lang, 'Nikogo takiego nie ma na liście.', 'Nobody like that on the list.')}</p>}
      {groups.map(([dept, list]) => (
        <section key={dept} aria-label={dept}>
          <h3 className="tech-kicker mb-1">{dept} · {list.length}</h3>
          <ul className="divide-y divide-line rounded-card border border-line">
            {list.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onChoose(m)}
                        className="auth-row flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{m.name}</span>
                    <span className="block truncate text-sm text-ink-2">{m.rank}</span>
                  </span>
                  <RoleBadge lang={lang} role={m.role} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

function PinStep({ lang, who, busy, onSubmit }: { lang: Lang; who: RosterMember; busy: boolean; onSubmit(pin: string): Promise<boolean> }) {
  const [pin, setPin] = useState('');
  const pinRef = useRef('');
  pinRef.current = pin;
  const ok = pin.length >= 4;
  const send = useCallback(async (p: string) => {
    if (p.length < 4 || busy) return;
    if (!(await onSubmit(p))) setPin('');
  }, [busy, onSubmit]);
  const press = useCallback((k: (typeof KEYS)[number]) => {
    if (busy) return;
    if (k === 'clear') setPin('');
    else if (k === 'back') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length >= 6 ? p : p + k));
  }, [busy]);
  // the generated PINs have 6 digits: the sixth one logs in without an extra tap
  useEffect(() => { if (pin.length === 6) void send(pin); }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps

  // physical keyboard too
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key as (typeof KEYS)[number]); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
      else if (e.key === 'Enter') { e.preventDefault(); void send(pinRef.current); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [press, send]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-card bg-paper-2 p-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{who.name}</span>
          <span className="block truncate text-sm text-ink-2">{who.rank} · {who.department}</span>
        </span>
        <RoleBadge lang={lang} role={who.role} />
      </div>
      <div className="flex justify-center gap-3 py-1" role="status" aria-label={L(lang, `Wpisano cyfr: ${pin.length}`, `Digits entered: ${pin.length}`)}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="auth-dot" data-on={i < pin.length || undefined} data-opt={i >= 4 || undefined} aria-hidden="true" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={L(lang, 'Klawiatura PIN', 'PIN pad')}>
        {KEYS.map((k) => (
          <button key={k} type="button" onClick={() => press(k)} disabled={busy}
                  aria-label={k === 'clear' ? L(lang, 'Wyczyść', 'Clear') : k === 'back' ? L(lang, 'Usuń cyfrę', 'Delete digit') : k}
                  className={`auth-key min-h-[64px] rounded-card border border-line font-bold ${k.length > 1
                    ? 'px-1 text-sm uppercase tracking-[0.04em] text-ink-2' : 'font-display text-[1.75rem]'}`}>
            {k === 'clear' ? L(lang, 'Wyczyść', 'Clear') : k === 'back' ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mx-auto">
                <path d="M9 6h11v12H9l-6-6Z" /><path d="M12.5 9.5l5 5M17.5 9.5l-5 5" />
              </svg>
            ) : k}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => void send(pin)} disabled={!ok || busy}
              className="tap-lg min-h-[56px] rounded-card bg-navy px-4 text-lg font-bold uppercase tracking-[0.06em] text-on-strong disabled:opacity-50">
        {busy ? L(lang, 'Sprawdzam…', 'Checking…') : L(lang, 'Zaloguj', 'Log in')}
      </button>
      <p className="text-xs text-ink-2">{L(lang, 'PIN dostajesz od oficera. 5 błędnych prób blokuje konto na 15 minut.', 'Your PIN comes from an officer. 5 wrong tries lock the account for 15 minutes.')}</p>
    </div>
  );
}
