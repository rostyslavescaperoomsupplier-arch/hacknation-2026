/** "Zadania" tab: the crew task list (server/tasks.ts, rules in shared/tasks.ts).
 *  Everybody logged in sees "Moje" (assigned to them, their role, department or everybody); officers can switch to
 *  "Wszystkie" and hand out new tasks. Alarm tasks (created by the alarm centre) sit on top, grouped per alarm.
 *  Big buttons for gloves: "Biorę" (take), "Zrobione" (done, optional short note), officers also "Anuluj". */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { Lang } from '../types';
import { ZONE, ZONES } from '../ship/routes';
import { ALARM_NAMES, isAlarmZone, type AlarmZone } from '../../shared/alarms';
import {
  DEPARTMENTS, DEPARTMENT_NAMES, DETAILS_MAX, NOTE_MAX, PRIORITY_NAMES, ROLE_NAMES, STATUS_NAMES, TASK_PRIORITIES, TASK_ROLES,
  TITLE_MAX, assignedTo, assigneeLabel, isFinished,
  type Task, type TaskPriority, type TaskViewer, type TasksResponse,
} from '../../shared/tasks';
import { useAuth, type RosterMember, type User } from '../auth/AuthProvider';
import { createTask, patchTask, useTasks } from './useTasks';
import './tasks.css';

const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);
const tx = (lang: Lang, t: { pl: string; en: string }) => (lang === 'pl' ? t.pl : t.en);
const field = 'tap w-full rounded-card border border-line bg-paper px-3 text-base text-ink';
const btn = 'tap-lg min-h-[56px] rounded-card px-4 text-base font-bold uppercase tracking-[0.05em]';

/** "za 20 min" / "spóźnione 5 min" / "za 2 h 10 min" */
function dueText(lang: Lang, due: string, now: number): { text: string; late: boolean; soon: boolean } {
  const min = Math.round((Date.parse(due) - now) / 60_000);
  const span = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  if (min < 0) return { text: L(lang, `spóźnione ${span(-min)}`, `overdue ${span(-min)}`), late: true, soon: false };
  if (min === 0) return { text: L(lang, 'termin teraz', 'due now'), late: false, soon: true };
  return { text: L(lang, `za ${span(min)}`, `in ${span(min)}`), late: false, soon: min <= 15 };
}
const clockTime = (lang: Lang, iso: string) => new Date(iso).toLocaleTimeString(lang === 'pl' ? 'pl-PL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
const zoneName = (lang: Lang, z: AlarmZone) => tx(lang, ZONE[z].name);
function assigneeText(lang: Lang, t: Task) {
  return t.assignee.kind === 'person' ? t.assignee.label : assigneeLabel(t.assignee.kind, t.assignee.value, lang === 'pl' ? 'pl' : 'en');
}

const Svg = ({ d, size = 16 }: { d: string[]; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
    {d.map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const IC = {
  person: ['M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5'],
  pin: ['M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z', 'M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z'],
  clock: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z', 'M12 7.5V12l3 2'],
  plus: ['M12 5v14', 'M5 12h14'],
  lock: ['M5 10.5h14v10H5Z', 'M8 10.5V7.5a4 4 0 0 1 8 0v3', 'M12 14.5v2.5'],
};

// ---------------------------------------------------------------------------------------------------------------
function TaskCard({ lang, task, me, manage, now, onDone }: {
  lang: Lang; task: Task; me: TaskViewer; manage: boolean; now: number; onDone(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<null | 'done' | 'cancelled'>(null);
  const [note, setNote] = useState('');
  const ids = useId();
  const finished = isFinished(task.status);
  const mineToDo = assignedTo(task, me) || task.takenBy?.id === me.id || manage;
  const canCancel = manage || (task.createdBy.id !== null && task.createdBy.id === me.id);
  const takenByMe = task.takenBy?.id === me.id;
  const due = task.due && !finished ? dueText(lang, task.due, now) : null;

  async function set(status: Task['status'], withNote?: string) {
    setBusy(true); setErr(null);
    const r = await patchTask(task.id, { status, ...(withNote ? { note: withNote } : {}) });
    setBusy(false);
    if (!r.ok) {
      setErr(r.status === 409 ? L(lang, 'Zadanie jest już zakończone.', 'The task is already finished.')
        : r.status === 403 ? L(lang, 'Nie masz uprawnień do tej zmiany.', 'You are not allowed to do that.')
        : r.status === 0 ? L(lang, 'Brak połączenia. Spróbuj ponownie.', 'No connection. Try again.')
        : L(lang, 'Nie udało się zapisać.', 'Could not save.'));
    } else { setFinishing(null); setNote(''); }
    onDone();
  }

  return (
    <li className="task-card panel relative flex flex-col gap-3 overflow-hidden p-4 pl-5" data-prio={task.priority}
        data-status={task.status} aria-labelledby={`${ids}-t`}>
      <span className="task-stripe" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="task-prio rounded-card px-2 py-0.5 text-xs font-bold uppercase tracking-[0.08em]">{tx(lang, PRIORITY_NAMES[task.priority])}</span>
        <span className="task-status tech-kicker" data-s={task.status}>{tx(lang, STATUS_NAMES[task.status])}</span>
        {due && (
          <span className={`ml-auto inline-flex items-center gap-1 text-sm font-semibold tabular-nums ${due.late ? 'text-danger' : due.soon ? 'text-gold-ink' : 'text-ink-2'}`}>
            <Svg d={IC.clock} />{due.text}
          </span>
        )}
      </div>
      <h4 id={`${ids}-t`} className={`text-lg font-semibold leading-snug ${finished ? 'text-ink-2 line-through decoration-1' : ''}`}>{task.title}</h4>
      {task.details && !finished && <p className="whitespace-pre-line text-sm text-ink-2">{task.details}</p>}
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="task-chip"><Svg d={IC.person} /><span className="sr-only">{L(lang, 'Dla:', 'For:')} </span>{assigneeText(lang, task)}</span>
        {task.zone && isAlarmZone(task.zone) && <span className="task-chip"><Svg d={IC.pin} />{zoneName(lang, task.zone)}</span>}
      </div>
      {(task.takenBy || finished || task.note) && (
        <p className="text-sm text-ink-2">
          {task.status === 'in-progress' && task.takenBy && <>{L(lang, 'Wziął(a)', 'Taken by')}: <span className="font-semibold text-ink">{takenByMe ? L(lang, 'ty', 'you') : task.takenBy.name}</span></>}
          {finished && task.doneBy && <>{task.status === 'done' ? L(lang, 'Zrobione', 'Done') : L(lang, 'Anulowane', 'Cancelled')}: {task.doneBy.name}{task.doneAt ? `, ${clockTime(lang, task.doneAt)}` : ''}</>}
          {task.note && <><br /><span className="italic">„{task.note}”</span></>}
        </p>
      )}
      {!finished && !task.alarmId && <p className="text-xs text-ink-2">{L(lang, 'Zlecił(a)', 'From')}: {task.createdBy.name}{task.createdBy.rank ? `, ${task.createdBy.rank}` : ''} · {clockTime(lang, task.createdAt)}</p>}

      {!finished && (mineToDo || canCancel) && !finishing && (
        <div className="flex flex-wrap gap-2">
          {mineToDo && task.status === 'open' && (
            <button type="button" disabled={busy} onClick={() => set('in-progress')} className={`${btn} grow basis-32 bg-navy text-on-strong disabled:opacity-50`}>
              {L(lang, 'Biorę', 'On it')}
            </button>
          )}
          {mineToDo && (
            <button type="button" disabled={busy} onClick={() => setFinishing('done')} className={`${btn} grow basis-32 bg-ok text-on-strong disabled:opacity-50`}>
              {L(lang, 'Zrobione', 'Done')}
            </button>
          )}
          {task.status === 'in-progress' && (takenByMe || manage) && (
            <button type="button" disabled={busy} onClick={() => set('open')} className={`${btn} border border-line bg-paper text-ink hover:bg-paper-2 disabled:opacity-50`}>
              {L(lang, 'Oddaj', 'Release')}
            </button>
          )}
          {canCancel && (
            <button type="button" disabled={busy} onClick={() => setFinishing('cancelled')} className={`${btn} border border-line bg-paper text-ink-2 hover:bg-paper-2 hover:text-ink disabled:opacity-50`}>
              {L(lang, 'Anuluj', 'Cancel')}
            </button>
          )}
        </div>
      )}
      {finishing && (
        <form className="flex flex-col gap-2 rounded-card bg-paper-2 p-3"
              onSubmit={(e) => { e.preventDefault(); void set(finishing, note.trim() || undefined); }}>
          <label className="flex flex-col gap-1">
            <span className="tech-kicker">{finishing === 'done' ? L(lang, 'Krótka notatka (opcjonalnie)', 'Short note (optional)') : L(lang, 'Powód anulowania (opcjonalnie)', 'Reason (optional)')}</span>
            <input className={field} value={note} maxLength={NOTE_MAX} autoFocus onChange={(e) => setNote(e.target.value)}
                   placeholder={finishing === 'done' ? L(lang, 'np. brak usterek', 'e.g. no defects') : ''} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy}
                    className={`${btn} grow basis-32 ${finishing === 'done' ? 'bg-ok' : 'bg-danger'} text-on-strong disabled:opacity-50`}>
              {finishing === 'done' ? L(lang, 'Potwierdź: zrobione', 'Confirm: done') : L(lang, 'Potwierdź anulowanie', 'Confirm cancel')}
            </button>
            <button type="button" onClick={() => { setFinishing(null); setNote(''); }}
                    className={`${btn} border border-line bg-paper text-ink hover:bg-paper-2`}>{L(lang, 'Wróć', 'Back')}</button>
          </div>
        </form>
      )}
      {err && <p role="alert" className="text-sm font-semibold text-danger">{err}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function NewTaskForm({ lang, onClose, onSaved }: { lang: Lang; onClose(): void; onSaved(): void }) {
  const { fetchRoster } = useAuth();
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [who, setWho] = useState('all:');
  const [zone, setZone] = useState<AlarmZone | ''>('');
  const [prio, setPrio] = useState<TaskPriority>('normal');
  const [dueIn, setDueIn] = useState('60');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = useId();
  useEffect(() => { void fetchRoster().then((r) => setRoster(r?.members ?? [])); }, [fetchRoster]);
  const byDept = useMemo(() => {
    const m = new Map<string, RosterMember[]>();
    for (const p of roster) m.set(p.department, [...(m.get(p.department) ?? []), p]);
    return [...m];
  }, [roster]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const [kind, value] = [who.slice(0, who.indexOf(':')), who.slice(who.indexOf(':') + 1)];
    setBusy(true); setErr(null);
    const r = await createTask({
      title: title.trim(), details: details.trim() || undefined, assignee: { kind, value }, zone: zone || undefined,
      priority: prio, dueInMin: dueIn ? Number(dueIn) : undefined,
    });
    setBusy(false);
    if (r.ok) { onSaved(); onClose(); }
    else setErr(r.status === 403 ? L(lang, 'Zadania zleca oficer albo kapitan.', 'Tasks are assigned by officers or the master.')
      : r.status === 0 ? L(lang, 'Brak połączenia. Spróbuj ponownie.', 'No connection. Try again.')
      : L(lang, 'Sprawdź pola formularza.', 'Check the form fields.'));
  }

  const groups = new Map<string, typeof ZONES>();
  for (const z of ZONES) { const k = tx(lang, z.deck); groups.set(k, [...(groups.get(k) ?? []), z]); }

  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 p-4" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="tech-title text-xl">{L(lang, 'Nowe zadanie', 'New task')}</h3>
      <label className="flex flex-col gap-1">
        <span className="tech-kicker flex justify-between"><span>{L(lang, 'Co trzeba zrobić', 'What needs doing')}</span>
          <span className="tabular-nums" aria-hidden="true">{[...title].length}/{TITLE_MAX}</span></span>
        <input className={field} value={title} maxLength={TITLE_MAX} required onChange={(e) => setTitle(e.target.value)}
               placeholder={L(lang, 'np. Sprawdzić gaśnice na pokładzie 4', 'e.g. Check the extinguishers on deck 4')} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="tech-kicker">{L(lang, 'Szczegóły (opcjonalnie)', 'Details (optional)')}</span>
        <textarea className={`${field} min-h-[80px] py-2`} value={details} maxLength={DETAILS_MAX} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="tech-kicker">{L(lang, 'Dla kogo', 'Assign to')}</span>
          <select className={field} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all:">{L(lang, 'Wszyscy', 'Everybody')}</option>
            <optgroup label={L(lang, 'Dział', 'Department')}>
              {DEPARTMENTS.map((d) => <option key={d} value={`department:${d}`}>{tx(lang, DEPARTMENT_NAMES[d])}</option>)}
            </optgroup>
            <optgroup label={L(lang, 'Funkcja', 'Role')}>
              {TASK_ROLES.map((r) => <option key={r} value={`role:${r}`}>{tx(lang, ROLE_NAMES[r])}</option>)}
            </optgroup>
            {byDept.map(([d, ps]) => (
              <optgroup key={d} label={`${L(lang, 'Osoba', 'Person')}: ${d}`}>
                {ps.map((p) => <option key={p.id} value={`person:${p.id}`}>{p.name} · {p.rank}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="tech-kicker">{L(lang, 'Miejsce', 'Location')}</span>
          <select className={field} value={zone} onChange={(e) => setZone(e.target.value as AlarmZone | '')}>
            <option value="">{L(lang, 'Bez strefy', 'No zone')}</option>
            {[...groups].map(([deck, zs]) => (
              <optgroup key={deck} label={deck}>{zs.map((z) => <option key={z.id} value={z.id}>{tx(lang, z.name)}</option>)}</optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="tech-kicker">{L(lang, 'Termin', 'Due')}</span>
          <select className={field} value={dueIn} onChange={(e) => setDueIn(e.target.value)}>
            <option value="">{L(lang, 'Bez terminu', 'No due time')}</option>
            {[10, 15, 30, 60, 120, 240, 480, 1440].map((m) => (
              <option key={m} value={m}>{L(lang, 'za ', 'in ')}{m < 60 ? `${m} min` : `${m / 60} h`}</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="tech-kicker mb-1">{L(lang, 'Priorytet', 'Priority')}</legend>
          <div className="grid grid-cols-4 overflow-hidden rounded-card border border-line">
            {[...TASK_PRIORITIES].reverse().map((p, i) => (
              <button key={p} type="button" aria-pressed={prio === p} data-prio={p} onClick={() => setPrio(p)}
                      className={`task-seg tap min-h-[48px] bg-paper px-1 text-sm font-semibold ${i ? 'border-l border-line' : ''}`}>
                {tx(lang, PRIORITY_NAMES[p])}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      {err && <p role="alert" className="font-semibold text-danger">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !title.trim()} className={`${btn} grow basis-32 bg-navy text-on-strong disabled:opacity-50`}>
          {L(lang, 'Zleć zadanie', 'Assign task')}
        </button>
        <button type="button" onClick={onClose} className={`${btn} border border-line bg-paper text-ink hover:bg-paper-2`}>{L(lang, 'Anuluj', 'Cancel')}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function Lists({ lang, res, user, now, refresh }: { lang: Lang; res: TasksResponse; user: User; now: number; refresh(): void }) {
  const me: TaskViewer = { id: user.id, role: user.role, department: user.department };
  const active = res.tasks.filter((t) => !isFinished(t.status));
  const finished = res.tasks.filter((t) => isFinished(t.status));
  const alarmGroups = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of active) if (t.alarmId) m.set(t.alarmId, [...(m.get(t.alarmId) ?? []), t]);
    return [...m];
  }, [active]);
  const normal = active.filter((t) => !t.alarmId);
  const card = (t: Task) => <TaskCard key={t.id} lang={lang} task={t} me={me} manage={res.canManage} now={now} onDone={refresh} />;

  return (
    <>
      {alarmGroups.map(([id, ts]) => (
        <section key={id} className="task-alarm flex flex-col gap-3 rounded-card border-2 border-danger p-3 sm:p-4" aria-labelledby={`ta-${id}`}>
          <h3 id={`ta-${id}`} className="flex flex-wrap items-center gap-2">
            <span className={`rounded-card px-2 py-1 text-xs font-bold uppercase tracking-[0.1em] text-paper ${ts[0].alarmDrill ? 'bg-gold-ink' : 'bg-danger'}`}>
              {ts[0].alarmDrill ? L(lang, 'Ćwiczenie', 'Drill') : L(lang, 'Alarm', 'Alarm')}
            </span>
            <span className="tech-title text-xl text-danger">{ts[0].alarmKind ? tx(lang, ALARM_NAMES[ts[0].alarmKind]) : L(lang, 'Alarm', 'Alarm')}</span>
            <span className="tech-kicker">{L(lang, 'zadania alarmowe', 'alarm tasks')} · {ts.length}</span>
          </h3>
          <ul className="grid gap-3 lg:grid-cols-2">{ts.map(card)}</ul>
        </section>
      ))}
      {normal.length > 0 ? <ul className="grid gap-3 lg:grid-cols-2">{normal.map(card)}</ul> : alarmGroups.length === 0 && (
        <p className="panel p-4 text-ink-2">{res.scope === 'mine' ? L(lang, 'Nie masz teraz żadnych zadań.', 'You have no tasks right now.') : L(lang, 'Brak otwartych zadań.', 'No open tasks.')}</p>
      )}
      {finished.length > 0 && (
        <details className="panel p-4">
          <summary className="tap flex cursor-pointer items-center font-semibold">{L(lang, `Zakończone w ostatniej dobie (${finished.length})`, `Finished in the last 24 h (${finished.length})`)}</summary>
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">{finished.map(card)}</ul>
        </details>
      )}
    </>
  );
}

export default function TasksPanel({ lang, visible }: { lang: Lang; visible: boolean }) {
  const { user, ready, openLogin } = useAuth();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [form, setForm] = useState(false);
  const { data, refresh, skew } = useTasks(visible && !!user, scope);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => { if (!visible) return; const t = window.setInterval(() => setTick(Date.now()), 20_000); return () => clearInterval(t); }, [visible]);
  useEffect(() => { if (!user) { setScope('mine'); setForm(false); } }, [user]);
  const now = tick + skew;
  const res = data.status === 'ok' ? data.res : null;
  // re-render the due times right after each poll
  useEffect(() => { setTick(Date.now()); }, [res]);

  if (ready && (!user || data.status === 'login')) {
    return (
      <div className="panel mx-auto flex max-w-xl flex-col items-start gap-3 p-6">
        <span className="text-gold-ink"><Svg d={IC.lock} size={40} /></span>
        <h2 className="tech-title text-h2">{L(lang, 'Zadania', 'Tasks')}</h2>
        <p>{L(lang, 'Lista zadań jest dla zalogowanej załogi. Zbliż kartę albo zaloguj się PIN-em.', 'The task list is for logged-in crew. Tap your card or log in with your PIN.')}</p>
        <button type="button" onClick={() => openLogin('manual')}
                className="tap-lg min-h-[56px] rounded-card bg-navy px-5 font-bold uppercase tracking-[0.06em] text-on-strong">
          {L(lang, 'Zaloguj', 'Log in')}
        </button>
      </div>
    );
  }

  const active = res?.tasks.filter((t) => !isFinished(t.status)) ?? [];
  const counts = {
    open: active.filter((t) => t.status === 'open').length,
    prog: active.filter((t) => t.status === 'in-progress').length,
    late: active.filter((t) => t.due && Date.parse(t.due) < now).length,
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <p className="tech-kicker">{user ? `${user.name} · ${user.department}` : L(lang, 'Lista zadań', 'Task list')}</p>
          <h2 className="tech-title text-h2">{L(lang, 'Zadania dla załogi', 'Crew tasks')}</h2>
        </div>
        {res?.canAll && (
          <div role="group" aria-label={L(lang, 'Zakres listy', 'List scope')} className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-paper">
            {(['mine', 'all'] as const).map((s, i) => (
              <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}
                      className={`task-seg tap min-h-[48px] px-4 font-semibold ${i ? 'border-l border-line' : ''}`}>
                {s === 'mine' ? L(lang, 'Moje', 'Mine') : L(lang, 'Wszystkie', 'All')}
              </button>
            ))}
          </div>
        )}
        {res?.canCreate && !form && (
          <button type="button" onClick={() => setForm(true)}
                  className="tap inline-flex min-h-[48px] items-center gap-2 rounded-card bg-navy px-4 font-bold uppercase tracking-[0.05em] text-on-strong">
            <Svg d={IC.plus} size={20} />{L(lang, 'Nowe zadanie', 'New task')}
          </button>
        )}
      </header>

      {res && (
        <dl className="grid grid-cols-3 gap-2" aria-live="polite">
          {[
            [L(lang, 'Do zrobienia', 'To do'), counts.open, ''],
            [L(lang, 'W toku', 'In progress'), counts.prog, ''],
            [L(lang, 'Spóźnione', 'Overdue'), counts.late, counts.late ? 'text-danger' : ''],
          ].map(([k, v, c]) => (
            <div key={k as string} className="panel flex flex-col justify-between px-3 py-2">
              <dt className="tech-kicker leading-tight">{k}</dt>
              <dd className={`tech-title text-[1.75rem] tabular-nums ${c}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {form && <NewTaskForm lang={lang} onClose={() => setForm(false)} onSaved={refresh} />}

      {data.status === 'down' && !res && (
        <p role="alert" className="rounded-card border-2 border-danger bg-paper p-3 font-semibold text-danger">
          {L(lang, 'Brak połączenia z serwerem. Ponawiam…', 'No connection to the server. Retrying…')}
        </p>
      )}
      {data.status === 'loading' && <p role="status" className="tech-kicker">{L(lang, 'Wczytywanie…', 'Loading…')}</p>}
      {res && user && <Lists lang={lang} res={res} user={user} now={now} refresh={refresh} />}
    </div>
  );
}
