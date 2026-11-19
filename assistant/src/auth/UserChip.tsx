/** Header control: "Zaloguj" when nobody is logged in; otherwise a chip (name, rank, role) that opens a small menu
 *  with the details and "Wyloguj". After the 30 min idle auto-logout it says so for a moment. */
import { useEffect, useId, useRef, useState } from 'react';
import type { Lang } from '../types';
import { IDLE_MS, useAuth } from './AuthProvider';
import RoleBadge, { L } from './RoleBadge';
import './auth.css';

const PersonIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
    <path d="M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
  </svg>
);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export default function UserChip({ lang }: { lang: Lang }) {
  const { user, ready, openLogin, logout, loggedOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ids = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!user) setOpen(false); }, [user]);
  useEffect(() => {
    if (loggedOut !== 'idle' && loggedOut !== 'expired') return;
    setNotice(loggedOut === 'idle'
      ? L(lang, `Wylogowano po ${IDLE_MS / 60_000} min bezczynności.`, `Logged out after ${IDLE_MS / 60_000} min of inactivity.`)
      : L(lang, 'Sesja wygasła. Zaloguj się ponownie.', 'Session expired. Please log in again.'));
    const t = window.setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(t);
  }, [loggedOut, lang]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc); };
  }, [open]);

  if (!user) {
    return (
      <div className="relative">
        <button type="button" onClick={() => openLogin('manual')} disabled={!ready}
                className="hdr-btn tap inline-flex items-center justify-center gap-2 rounded-card border border-ink bg-paper px-3 text-sm font-bold uppercase text-ink hover:bg-paper-2">
          <PersonIcon />
          <span className="hidden sm:inline">{L(lang, 'Zaloguj', 'Log in')}</span>
          <span className="sr-only sm:hidden">{L(lang, 'Zaloguj', 'Log in')}</span>
        </button>
        {notice && (
          <p role="status" className="panel absolute right-0 top-full z-40 mt-2 w-64 p-3 text-sm font-semibold">{notice}</p>
        )}
      </div>
    );
  }
  return (
    <div ref={wrap} className="relative">
      <button type="button" aria-expanded={open} aria-controls={`${ids}-m`} onClick={() => setOpen((v) => !v)}
              aria-label={L(lang, `Zalogowany: ${user.name}, ${user.rank}`, `Logged in: ${user.name}, ${user.rank}`)}
              className="auth-chip tap inline-flex max-w-[16rem] items-center gap-2 rounded-card border border-line bg-paper px-2 text-left hover:bg-paper-2">
        <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-paper-2 font-display text-base font-bold">{initials(user.name)}</span>
        {/* name + rank where the header has room: tablets (tabs at the bottom) and wide desktops; initials + role in between */}
        <span className="hidden min-w-0 flex-col leading-tight sm:flex lg:hidden 2xl:flex">
          <span className="truncate text-sm font-semibold">{user.name}</span>
          <span className="truncate text-xs text-ink-2">{user.rank}</span>
        </span>
        <RoleBadge lang={lang} role={user.role} className="hidden md:inline-flex" />
      </button>
      {open && (
        <div id={`${ids}-m`} className="auth-menu panel absolute right-0 top-full z-40 mt-2 flex w-72 flex-col gap-3 p-4">
          <div>
            <p className="font-bold">{user.name}</p>
            <p className="text-sm text-ink-2">{user.rank} · {user.department}</p>
            <p className="mt-2 flex items-center gap-2 text-sm"><RoleBadge lang={lang} role={user.role} />
              <span className="text-ink-2">{user.method === 'rfid' ? L(lang, 'kartą', 'by card') : L(lang, 'PIN-em', 'by PIN')}</span>
            </p>
          </div>
          <p className="text-xs text-ink-2">
            {L(lang, `Na wspólnym terminalu wylogujesz się sam po ${IDLE_MS / 60_000} min bez dotyku.`, `On a shared terminal you are logged out after ${IDLE_MS / 60_000} min without a touch.`)}
          </p>
          <button type="button" onClick={() => { setOpen(false); void logout(); }}
                  className="tap-lg min-h-[56px] rounded-card bg-navy px-4 font-bold uppercase tracking-[0.06em] text-on-strong">
            {L(lang, 'Wyloguj', 'Log out')}
          </button>
        </div>
      )}
    </div>
  );
}
