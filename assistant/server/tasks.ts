/**
 * Crew task list ("Zadania dla załogi"): officers hand out tasks to a person, a role, a department or everybody; the
 * crew take them ("Biorę") and finish them ("Zrobione"). Alarms create their first tasks by themselves.
 * Types and the visibility rules: shared/tasks.ts. Node built-ins only.
 *
 *   GET   /api/tasks?scope=mine|all  -> TasksResponse. Login required (401). mine = assigned to me / my role / my
 *                                       department / everybody, or taken by me; all = officers only (captain, bridge,
 *                                       engine), anyone else silently gets mine. Sorted: active first, urgent/high,
 *                                       nearest due, newest.
 *   POST  /api/tasks                 -> 201 { task }. captain / bridge / engine. Body { title, details?, assignee:
 *                                       { kind, value }, zone?, priority?, due? (ISO) | dueInMin? }
 *   PATCH /api/tasks/:id             -> { task }. { status?, note? } and, for the creator / captain / bridge, also
 *                                       { title?, details?, priority?, due? | dueInMin?, assignee?, zone? }.
 *                                       take (in-progress) / done / release (open): the assignee side (or captain / bridge);
 *                                       cancelled: creator or captain / bridge. Finished tasks are final (409).
 *
 * Auto tasks: server/alarms.ts calls alarmTasksRaised(alarm) when an alarm is raised (bridge console or a fire
 * detector), alarmTasksSensor(alarm, id) when another detector joins an active fire alarm, and alarmTasksEnded(id)
 * when it is ended or replaced: its unfinished auto tasks become 'cancelled' with the note "Alarm zakończony".
 * This module never imports alarms.ts (alarms.ts imports us), only the shared types.
 *
 * Stored in TASKS_FILE (default server/data/tasks.json), debounced writes via tmp + rename, at most 500 tasks; finished
 * tasks stay in the list for 24 h. A missing file is seeded with a few demo tasks (TASKS_SEED=0 turns that off).
 * Same origin / x-assistant-token checks as the other HTTP modules; per-IP rate limits (reads 120/min, writes 30/min).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, corsOrigin, originAllowed, tokenOk } from './guard.ts';
import { getSession, memberInfo, syncRoster, type Session } from './auth.ts';
import { ALARM_NAMES, isAlarmZone, type Alarm, type AlarmKind, type AlarmZone } from '../shared/alarms.ts';
import { SENSOR } from '../shared/sensors.ts';
import {
  DETAILS_MAX, DUE_MIN_MAX, NOTE_MAX, TITLE_MAX, ZONE_SHORT,
  assignedTo, assigneeLabel, canCreate, canManageAll, canSeeAll, isDepartment, isFinished, isMine, isTaskPriority,
  isTaskRole, isTaskStatus, taskOrder,
  type AssigneeKind, type Department, type Task, type TaskAssignee, type TaskPerson, type TaskPriority, type TaskRole,
  type TaskViewer, type TasksResponse,
} from '../shared/tasks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const envNum = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
// under `node --test` (other suites import alarms.ts -> us) never touch the real list
const FILE = process.env.TASKS_FILE
  || (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ? path.join(mkdtempSync(path.join(tmpdir(), 'ju-tasks-')), 'tasks.json') : path.join(here, 'data', 'tasks.json'));
const CAP = 500;
const KEEP_FINISHED_MS = 24 * 3600_000;
const SAVE_DEBOUNCE_MS = envNum('TASKS_SAVE_MS', 500);
const SEED = !/^(0|false|no|off)$/i.test((process.env.TASKS_SEED ?? '').trim());
const READ_PER_MIN = envNum('TASKS_READ_PER_MIN', 120);
const WRITE_PER_MIN = envNum('TASKS_WRITE_PER_MIN', 30);
const UNSAFE_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** newest first is not required: the list is sorted on every read */
let tasks: Task[] = [];

// ---------- persistence ----------
function validStored(t: any): t is Task {
  return t && typeof t === 'object' && typeof t.id === 'string' && typeof t.title === 'string' && isTaskStatus(t.status)
    && isTaskPriority(t.priority) && t.assignee && typeof t.assignee.kind === 'string' && typeof t.createdAt === 'string'
    && t.createdBy && typeof t.createdBy.name === 'string';
}
function load(): boolean {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as { tasks?: unknown };
    tasks = Array.isArray(data.tasks) ? data.tasks.filter(validStored).slice(0, CAP) : [];
    return true;
  } catch { tasks = []; return false; }
}

let saveTimer: NodeJS.Timeout | null = null;
function writeNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 1));
    renameSync(tmp, FILE);
  } catch (e) { console.error('[tasks] save failed:', e instanceof Error ? e.message : e); }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}
/** Write pending changes now (tests, shutdown). */
export function flushTasks() { if (saveTimer) writeNow(); }
process.once('beforeExit', flushTasks);

/** Drop finished tasks older than 24 h; keep at most CAP (oldest finished go first, then the oldest open ones). */
function prune(now = Date.now()) {
  const before = tasks.length;
  tasks = tasks.filter((t) => !isFinished(t.status) || now - Date.parse(t.doneAt ?? t.updatedAt) < KEEP_FINISHED_MS);
  if (tasks.length > CAP) {
    const byAge = [...tasks].sort((a, b) => Number(isFinished(b.status)) - Number(isFinished(a.status)) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const drop = new Set(byAge.slice(0, tasks.length - CAP).map((t) => t.id));
    tasks = tasks.filter((t) => !drop.has(t.id));
  }
  if (tasks.length !== before) scheduleSave();
}

// ---------- demo seed ----------
const PLAN: TaskPerson = { id: null, name: 'Plan dnia', rank: 'mostek' };
function seed(now = Date.now()) {
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  const mk = (title: string, details: string, assignee: TaskAssignee, priority: TaskPriority, dueMin: number, zone?: AlarmZone, ageMin = 30): Task => ({
    id: randomUUID(), title, details, assignee, ...(zone ? { zone } : {}), priority, due: at(dueMin), status: 'open',
    createdBy: PLAN, createdAt: at(-ageMin), updatedAt: at(-ageMin),
  });
  const dept = (d: Department): TaskAssignee => ({ kind: 'department', value: d, label: assigneeLabel('department', d) });
  const role = (r: TaskRole): TaskAssignee => ({ kind: 'role', value: r, label: assigneeLabel('role', r) });
  tasks = [
    mk('Przegląd szalupy nr 2', 'Wciągarka i hamulec, liny, korki spustowe, racje i woda, pławki. Wpis do dziennika LSA.', role('bridge'), 'high', 35, undefined, 50),
    mk('Obchód przeciwpożarowy pokładu 3', 'Korytarze kabin 100-147: drzwi pożarowe zamknięte, gaśnice na miejscu, czujki bez osłon. Usterki zgłosić na mostek.', dept('Pokład'), 'normal', 45, 'cabins-mid', 40),
    mk('Test oświetlenia awaryjnego', 'Przełączyć na zasilanie z akumulatorów na 30 s. Sprawdzić klatki schodowe i pokłady samochodowe, wynik wpisać do dziennika maszynowego.', dept('Maszynownia'), 'high', 90, 'vehicle-d1', 60),
    mk('Sprawdzić kamizelki ratunkowe w kabinach 100-108', 'Liczba zgodna z kartą kabiny, światełka i gwizdki, instrukcja na drzwiach. Braki uzupełnić z magazynu D3.', dept('Hotel'), 'normal', 120, 'cabins-aft', 25),
    mk('Uzupełnić apteczkę w mesie', 'Opatrunki, rękawiczki, sól fizjologiczna, koc termiczny. Sprawdzić daty ważności.', dept('Medyczny'), 'low', 240, undefined, 90),
    mk('Odczyt poziomu zęz i wpis do dziennika maszynowego', 'Zęzy maszynowni i pomieszczenia sterowego. Wartości powyżej normy zgłosić starszemu mechanikowi.', role('engine'), 'normal', -5, 'engine-room', 70),
    mk('Odprawa bezpieczeństwa przed wyjściem z portu', 'Mesa załogowa, 15 min. Temat: drogi ewakuacji przy zablokowanej klatce rufowej.', { kind: 'all', value: '', label: assigneeLabel('all', '') }, 'normal', 180, undefined, 10),
  ];
  scheduleSave();
}

if (!load() && SEED) seed();
prune();

// ---------- helpers ----------
const clean = (v: string) => v.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const oneLine = (v: string) => clean(v).replace(/\s+/g, ' ');
const len = (s: string) => [...s].length;
const cut = (s: string, n: number) => (len(s) <= n ? s : [...s].slice(0, n - 1).join('') + '…');
const person = (s: Session): TaskPerson => ({ id: s.accountId, name: s.name, rank: s.rank });
const viewer = (s: Session): TaskViewer => ({ id: s.accountId, role: s.role, department: s.department });

/** Tasks a user sees. Exported for tests. */
export function listFor(v: TaskViewer, scope: 'mine' | 'all', now = Date.now()): Task[] {
  prune(now);
  const all = scope === 'all' && canSeeAll(v.role);
  return tasks.filter((t) => all || isMine(t, v)).sort(taskOrder);
}
export const mineOpen = (v: TaskViewer) => tasks.filter((t) => !isFinished(t.status) && isMine(t, v)).length;

/** test hook: empty list, no file */
export function resetTasks(list: Task[] = []) { tasks = list; scheduleSave(); }
export const allTasks = () => tasks;

// ---------- auto tasks on alarms ----------
const CENTRAL: TaskPerson = { id: null, name: 'Centrala alarmowa', rank: '' };
interface AutoRow { title: string; details: string; to: { kind: AssigneeKind; value: string }; priority: TaskPriority; dueMin: number }
const D = (value: Department) => ({ kind: 'department' as const, value });
const R = (value: TaskRole) => ({ kind: 'role' as const, value });
// {in} = " w strefie <zone>" (or nothing), {det} = " (czujka C104: Kabina 104)" (fire with a detector, or nothing)
const AUTO: Record<AlarmKind, AutoRow[]> = {
  fire: [
    { title: 'Grupa pożarowa: rozpoznanie{in}{det}', details: 'Aparaty oddechowe, łączność UKF z mostkiem. Przed otwarciem drzwi sprawdzić ich temperaturę wierzchem dłoni. Meldować co 5 min.', to: D('Pokład'), priority: 'urgent', dueMin: 3 },
    { title: 'Zamknąć drzwi pożarowe i klapy wentylacji{in}', details: 'Wyłączyć wentylację strefy z ECR, zamknąć klapy pożarowe i drzwi przeciwpożarowe, zameldować mostkowi.', to: R('engine'), priority: 'urgent', dueMin: 5 },
    { title: 'Uruchomić pompę pożarową, ciśnienie w magistrali', details: 'Główna pompa pożarowa, w razie potrzeby awaryjna. Zameldować ciśnienie na hydrantach.', to: D('Maszynownia'), priority: 'high', dueMin: 5 },
    { title: 'Przygotować listę obecności przy punkcie zbiórki', details: 'Lista z Rozkładu alarmowego, zameldować kapitanowi brakujące osoby.', to: R('bridge'), priority: 'high', dueMin: 10 },
  ],
  abandon: [
    { title: 'Przygotować szalupy do opuszczenia', details: 'Zdjąć mocowania sztormowe, sprawdzić korki spustowe, przygotować drabinki. Czekać na rozkaz kapitana.', to: D('Pokład'), priority: 'urgent', dueMin: 5 },
    { title: 'Lista obecności na stacjach zbiórki A i B', details: 'Policzyć załogę i pasażerów, brakujące osoby zgłosić na mostek.', to: R('bridge'), priority: 'urgent', dueMin: 10 },
    { title: 'Skierować pasażerów do stacji zbiórki, sprawdzić kabiny{in}', details: 'Kamizelki ratunkowe, ciepłe ubranie, bez wind. Sprawdzone kabiny oznaczyć.', to: D('Hotel'), priority: 'urgent', dueMin: 8 },
    { title: 'Zasilanie awaryjne i maszynownia do opuszczenia', details: 'Generator awaryjny w gotowości, zatrzymanie silników na rozkaz mostka, maszynownia pusta.', to: R('engine'), priority: 'high', dueMin: 10 },
  ],
  mob: [
    { title: 'Obserwator: nie tracić z oczu osoby za burtą', details: 'Stale wskazywać ręką miejsce w wodzie, meldować mostkowi kierunek i odległość.', to: D('Pokład'), priority: 'urgent', dueMin: 1 },
    { title: 'Rzucić koło ratunkowe z pławką świetlno-dymną', details: 'Najbliższe koło po stronie burty, z której wypadła osoba.', to: D('Pokład'), priority: 'urgent', dueMin: 1 },
    { title: 'Przygotować łódź ratowniczą do opuszczenia', details: 'Załoga łodzi w kombinezonach i kamizelkach, silnik, radio UKF, sprzęt do podjęcia z wody.', to: R('crew'), priority: 'urgent', dueMin: 5 },
    { title: 'MOB w GPS, manewr Williamsona, PAN-PAN', details: 'Zaznaczyć pozycję, rozpocząć manewr, nadać komunikat i powiadomić MRCC.', to: R('bridge'), priority: 'urgent', dueMin: 2 },
  ],
  medical: [
    { title: 'Udzielić pomocy poszkodowanemu{in}', details: 'Ocena stanu, pierwsza pomoc, decyzja o transporcie do szpitala okrętowego.', to: D('Medyczny'), priority: 'urgent', dueMin: 3 },
    { title: 'Przynieść torbę pierwszej pomocy, AED i nosze{in}', details: 'Najbliższy zestaw z mesy albo z recepcji.', to: D('Pokład'), priority: 'urgent', dueMin: 3 },
    { title: 'Zabezpieczyć miejsce, odsunąć gapiów{in}', details: 'Wolne przejście dla noszy, winda towarowa w gotowości.', to: D('Hotel'), priority: 'high', dueMin: 5 },
    { title: 'Konsultacja TMAS (Radio Medical) w razie potrzeby', details: 'Dane poszkodowanego, objawy, pozycja statku. Rozważyć ewakuację medyczną.', to: R('bridge'), priority: 'high', dueMin: 10 },
  ],
  blackout: [
    { title: 'Uruchomić generator awaryjny, sprawdzić przejęcie zasilania', details: 'Jeśli nie wystartował sam: start ręczny. Zameldować mostkowi.', to: R('engine'), priority: 'urgent', dueMin: 2 },
    { title: 'Ustalić przyczynę zaniku, przywrócić rozdzielnię główną', details: 'Kolejno odbiorniki krytyczne: ster, pompy pożarowe, oświetlenie.', to: D('Maszynownia'), priority: 'high', dueMin: 15 },
    { title: 'Sprawdzić oświetlenie awaryjne w strefach pasażerskich', details: 'Klatki schodowe, korytarze kabin, salony. Pasażerów uspokoić, zostać na miejscach.', to: D('Hotel'), priority: 'high', dueMin: 5 },
    { title: 'Statek bez napędu: światła NUC, komunikat do VTS', details: 'Wystawić światła i znaki NUC, ostrzeżenie dla statków w pobliżu.', to: R('bridge'), priority: 'urgent', dueMin: 3 },
  ],
  flooding: [
    { title: 'Ustalić miejsce przecieku, zamknąć drzwi wodoszczelne{in}', details: 'Zameldować mostkowi miejsce, wielkość otworu i przybór wody.', to: D('Pokład'), priority: 'urgent', dueMin: 3 },
    { title: 'Uruchomić pompy zęzowe, kontrolować poziom w zęzach', details: 'Odczyty co 5 min do mostka.', to: R('engine'), priority: 'urgent', dueMin: 3 },
    { title: 'Ocenić stateczność, przygotować komunikat do VTS', details: 'Przechył, przegłębienie, decyzja o zmianie kursu lub prędkości.', to: R('bridge'), priority: 'high', dueMin: 10 },
  ],
  pollution: [
    { title: 'Zatrzymać źródło wycieku, zamknąć zawory', details: 'Przerwać bunkrowanie lub przepompowywanie, zameldować mostkowi.', to: R('engine'), priority: 'urgent', dueMin: 3 },
    { title: 'Zestaw SOPEP: sorbenty, uszczelnić spływniki pokładowe', details: 'Nie spłukiwać za burtę, zebrane sorbenty do pojemników.', to: D('Pokład'), priority: 'urgent', dueMin: 5 },
    { title: 'Zgłosić wyciek wg SOPEP', details: 'Państwo nadbrzeżne / port, armator. Zapis w dzienniku olejowym.', to: R('bridge'), priority: 'high', dueMin: 15 },
  ],
  security: [
    { title: 'Zabezpieczyć strefy zastrzeżone{in}', details: 'Mostek, maszynownia, sterownia. Nie konfrontować się, meldować SSO.', to: D('Pokład'), priority: 'urgent', dueMin: 3 },
    { title: 'Kontrola dostępu do maszynowni', details: 'Zamknąć wejścia, wpuszczać tylko załogę maszynową.', to: D('Maszynownia'), priority: 'high', dueMin: 5 },
    { title: 'Uspokoić pasażerów, skierować do salonów', details: 'Bez szczegółów zagrożenia, polecenia tylko od SSO.', to: D('Hotel'), priority: 'normal', dueMin: 10 },
    { title: 'Powiadomić CSO i władze portu wg SSP', details: 'Poziom ochrony, opis zdarzenia, dalsze polecenia.', to: R('bridge'), priority: 'high', dueMin: 10 },
  ],
  general: [
    { title: 'Lista obecności na stacjach zbiórki', details: 'Policzyć załogę i pasażerów wg Rozkładu alarmowego, braki zgłosić na mostek.', to: R('bridge'), priority: 'urgent', dueMin: 10 },
    { title: 'Kamizelki ratunkowe dla pasażerów{in}', details: 'Rozdać kamizelki, poprowadzić do stacji zbiórki, bez wind.', to: D('Hotel'), priority: 'urgent', dueMin: 8 },
    { title: 'Maszynownia w gotowości, zasilanie awaryjne', details: 'Generator awaryjny gotowy, czekać na polecenia mostka.', to: R('engine'), priority: 'high', dueMin: 5 },
  ],
};

function detText(id: string | undefined): string {
  const s = id ? SENSOR[id] : undefined;
  return s ? ` (czujka ${s.id}: ${s.name.pl})` : '';
}
function autoTask(alarm: Alarm, row: AutoRow, now: number, sensor?: string): Task {
  const inZone = alarm.zone ? ` w strefie: ${ZONE_SHORT[alarm.zone].pl}` : '';
  const title = cut(row.title.replace('{in}', inZone).replace('{det}', detText(sensor)), TITLE_MAX);
  const iso = new Date(now).toISOString();
  return {
    id: randomUUID(), title, details: row.details, assignee: { ...row.to, label: assigneeLabel(row.to.kind, row.to.value) },
    ...(alarm.zone ? { zone: alarm.zone } : {}), priority: row.priority, due: new Date(now + row.dueMin * 60_000).toISOString(),
    status: 'open', createdBy: { ...CENTRAL, rank: ALARM_NAMES[alarm.kind].pl + (alarm.drill ? ' (ćwiczenie)' : '') },
    createdAt: iso, updatedAt: iso, alarmId: alarm.id, alarmKind: alarm.kind, alarmDrill: alarm.drill,
  };
}

/** An alarm was raised: its first tasks (2-4 per kind). Idempotent per alarm. Returns the new tasks. */
export function alarmTasksRaised(alarm: Alarm, now = Date.now()): Task[] {
  if (tasks.some((t) => t.alarmId === alarm.id)) return [];
  const made = (AUTO[alarm.kind] ?? []).map((row) => autoTask(alarm, row, now, alarm.sensors?.[0]));
  tasks.push(...made);
  prune(now);
  scheduleSave();
  console.log(`[tasks] ${made.length} auto tasks for ${alarm.kind} alarm ${alarm.id.slice(0, 8)}`);
  return made;
}

/** Another detector joined an active fire alarm: one more reconnaissance task for it. */
export function alarmTasksSensor(alarm: Alarm, sensorId: string, now = Date.now()): Task | null {
  const s = SENSOR[sensorId];
  if (!s || alarm.kind !== 'fire') return null;
  const tag = `(czujka ${s.id}:`;
  if (tasks.some((t) => t.alarmId === alarm.id && t.title.includes(tag))) return null;
  const zone = isAlarmZone(s.zone) ? s.zone : alarm.zone;
  const row: AutoRow = { ...AUTO.fire[0], title: 'Grupa pożarowa: sprawdzić kolejną czujkę{det}' };
  const t = autoTask({ ...alarm, zone }, row, now, sensorId);
  tasks.push(t);
  scheduleSave();
  return t;
}

/** The alarm ended or was replaced: its unfinished auto tasks are cancelled. Returns how many. */
export function alarmTasksEnded(alarmId: string, replaced = false, now = Date.now()): number {
  const iso = new Date(now).toISOString();
  let n = 0;
  for (const t of tasks) {
    if (t.alarmId !== alarmId || isFinished(t.status)) continue;
    t.status = 'cancelled';
    t.note = replaced ? 'Alarm zakończony (zastąpiony nowym)' : 'Alarm zakończony';
    t.doneBy = CENTRAL;
    t.doneAt = iso;
    t.updatedAt = iso;
    n++;
  }
  if (n) scheduleSave();
  return n;
}

/** After a restart: auto tasks of alarms that are no longer active are closed. */
export function alarmTasksSync(activeAlarmId: string | null) {
  const ids = new Set(tasks.filter((t) => t.alarmId && t.alarmId !== activeAlarmId && !isFinished(t.status)).map((t) => t.alarmId!));
  for (const id of ids) alarmTasksEnded(id);
}

// ---------- validation ----------
type Fail = { error: string };
const fail = (error: string): Fail => ({ error });
const isFail = (v: unknown): v is Fail => !!v && typeof v === 'object' && 'error' in v;

function readText(v: unknown, max: number, what: string, required: boolean, multiline = false): string | undefined | Fail {
  if (v == null || v === '') return required ? fail(`${what} required`) : undefined;
  if (typeof v !== 'string') return fail(`${what} must be text`);
  const s = multiline ? clean(v) : oneLine(v);
  if (!s) return required ? fail(`${what} required`) : undefined;
  if (len(s) > max) return fail(`${what}: at most ${max} characters`);
  return s;
}
async function readAssignee(v: unknown): Promise<TaskAssignee | Fail> {
  if (!v || typeof v !== 'object') return fail('assignee: { kind, value }');
  const { kind, value } = v as { kind?: unknown; value?: unknown };
  if (kind === 'all') return { kind, value: '', label: assigneeLabel('all', '') };
  if (kind === 'role') return isTaskRole(value) ? { kind, value, label: assigneeLabel('role', value) } : fail('assignee: unknown role');
  if (kind === 'department') return isDepartment(value) ? { kind, value, label: assigneeLabel('department', value) } : fail('assignee: unknown department');
  if (kind === 'person') {
    const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(id) || id < 1) return fail('assignee: person id');
    let m = memberInfo(id);
    if (!m) { await syncRoster(true).catch(() => {}); m = memberInfo(id); }
    if (!m) return fail('assignee: unknown person');
    return { kind, value: String(id), label: `${m.name}, ${m.rank}` };
  }
  return fail('assignee.kind: person | role | department | all');
}
function readDue(b: Record<string, unknown>, now: number): string | null | undefined | Fail {
  if (b.dueInMin !== undefined && b.dueInMin !== null && b.dueInMin !== '') {
    const n = Number(b.dueInMin);
    if (!Number.isInteger(n) || n < 1 || n > DUE_MIN_MAX) return fail(`dueInMin: 1-${DUE_MIN_MAX}`);
    return new Date(now + n * 60_000).toISOString();
  }
  if (b.due === null || b.due === '') return null;
  if (b.due === undefined) return undefined;
  const t = typeof b.due === 'string' ? Date.parse(b.due) : NaN;
  if (!Number.isFinite(t) || t < now - 24 * 3600_000 || t > now + DUE_MIN_MAX * 60_000) return fail('due: ISO time within a week');
  return new Date(t).toISOString();
}
function readZone(v: unknown): AlarmZone | null | undefined | Fail {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return isAlarmZone(v) ? v : fail('zone: unknown zone');
}

/** Create a task (POST). Exported for tests. */
export async function createTask(s: Session, b: Record<string, unknown>, now = Date.now()): Promise<{ status: number; body: unknown }> {
  if (!canCreate(s.role)) return { status: 403, body: { error: 'forbidden' } };
  const title = readText(b.title, TITLE_MAX, 'title', true);
  if (isFail(title)) return { status: 400, body: title };
  const details = readText(b.details, DETAILS_MAX, 'details', false, true);
  if (isFail(details)) return { status: 400, body: details };
  const assignee = await readAssignee(b.assignee);
  if (isFail(assignee)) return { status: 400, body: assignee };
  const zone = readZone(b.zone);
  if (isFail(zone)) return { status: 400, body: zone };
  const priority = b.priority === undefined ? 'normal' : b.priority;
  if (!isTaskPriority(priority)) return { status: 400, body: fail('priority: low | normal | high | urgent') };
  const due = readDue(b, now);
  if (isFail(due)) return { status: 400, body: due };
  const iso = new Date(now).toISOString();
  const t: Task = {
    id: randomUUID(), title: title!, ...(details ? { details } : {}), assignee, ...(zone ? { zone } : {}), priority,
    ...(due ? { due } : {}), status: 'open', createdBy: person(s), createdAt: iso, updatedAt: iso,
  };
  tasks.push(t);
  prune(now);
  scheduleSave();
  console.log(`[tasks] NEW "${t.title}" -> ${t.assignee.label} by ${s.name} #${s.accountId}`);
  return { status: 201, body: { task: t } };
}

/** Change a task (PATCH). Exported for tests. */
export async function updateTask(s: Session, id: string, b: Record<string, unknown>, now = Date.now()): Promise<{ status: number; body: unknown }> {
  const t = tasks.find((x) => x.id === id);
  const v = viewer(s);
  if (!t || !(isMine(t, v) || canSeeAll(s.role))) return { status: 404, body: { error: 'not found' } };
  if (isFinished(t.status)) return { status: 409, body: { error: 'task already finished' } };
  const manager = canManageAll(s.role) || (t.createdBy.id !== null && t.createdBy.id === s.accountId);
  const doer = assignedTo(t, v) || t.takenBy?.id === s.accountId || canManageAll(s.role);
  const editKeys = ['title', 'details', 'priority', 'due', 'dueInMin', 'assignee', 'zone'].filter((k) => b[k] !== undefined);
  for (const k of Object.keys(b)) if (!['status', 'note', ...editKeys].includes(k)) return { status: 400, body: fail(`unknown field: ${k.slice(0, 20)}`) };
  if (editKeys.length && !manager) return { status: 403, body: { error: 'forbidden' } };
  if (b.status === undefined && !editKeys.length) return { status: 400, body: fail('nothing to change') };
  if (b.status !== undefined && !isTaskStatus(b.status)) return { status: 400, body: fail('status: open | in-progress | done | cancelled') };
  const note = readText(b.note, NOTE_MAX, 'note', false);
  if (isFail(note)) return { status: 400, body: note };

  // validate everything before changing anything
  const patch: Partial<Task> = {};
  if (b.title !== undefined) {
    const v2 = readText(b.title, TITLE_MAX, 'title', true);
    if (isFail(v2)) return { status: 400, body: v2 };
    patch.title = v2;
  }
  let dropDetails = false, dropDue = false, dropZone = false;
  if (b.details !== undefined) {
    const v2 = readText(b.details, DETAILS_MAX, 'details', false, true);
    if (isFail(v2)) return { status: 400, body: v2 };
    if (v2) patch.details = v2; else dropDetails = true;
  }
  if (b.priority !== undefined) {
    if (!isTaskPriority(b.priority)) return { status: 400, body: fail('priority: low | normal | high | urgent') };
    patch.priority = b.priority;
  }
  if (b.due !== undefined || b.dueInMin !== undefined) {
    const v2 = readDue(b, now);
    if (isFail(v2)) return { status: 400, body: v2 };
    if (v2) patch.due = v2; else dropDue = true;
  }
  if (b.assignee !== undefined) {
    const v2 = await readAssignee(b.assignee);
    if (isFail(v2)) return { status: 400, body: v2 };
    patch.assignee = v2;
  }
  if (b.zone !== undefined) {
    const v2 = readZone(b.zone);
    if (isFail(v2)) return { status: 400, body: v2 };
    if (v2) patch.zone = v2; else dropZone = true;
  }

  const status = b.status as Task['status'] | undefined;
  if (status) {
    if (status === 'cancelled' && !manager) return { status: 403, body: { error: 'forbidden' } };
    if (status !== 'cancelled' && !doer) return { status: 403, body: { error: 'forbidden' } };
    // giving a task back: only who took it, or a manager
    if (status === 'open' && t.takenBy && t.takenBy.id !== s.accountId && !manager) return { status: 403, body: { error: 'forbidden' } };
  }

  Object.assign(t, patch);
  if (dropDetails) delete t.details;
  if (dropDue) delete t.due;
  if (dropZone) delete t.zone;
  if (status && status !== t.status) {
    if (status === 'in-progress') t.takenBy = person(s);
    if (status === 'open') delete t.takenBy;
    if (status === 'done' || status === 'cancelled') { t.doneBy = person(s); t.doneAt = new Date(now).toISOString(); if (status === 'done' && !t.takenBy) t.takenBy = person(s); }
    t.status = status;
    console.log(`[tasks] ${status.toUpperCase()} "${t.title}" by ${s.name} #${s.accountId}`);
  } else if (status === 'in-progress' && t.takenBy?.id !== s.accountId) {
    t.takenBy = person(s); // somebody else takes over
  }
  if (note !== undefined) t.note = note;
  t.updatedAt = new Date(now).toISOString();
  scheduleSave();
  return { status: 200, body: { task: t } };
}

// ---------- HTTP ----------
function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage, max = 4096): Promise<string | null> {
  return new Promise((resolve) => {
    let n = 0; const parts: Buffer[] = []; let done = false;
    req.on('data', (c: Buffer) => { if (done) return; n += c.length; if (n > max) { done = true; resolve(null); req.resume(); return; } parts.push(c); });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}
const buckets = new Map<string, { n: number; t: number }>();
function allow(key: string, perMin: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60_000) { if (buckets.size > 20_000) buckets.clear(); buckets.set(key, b = { n: 0, t: now }); }
  return ++b.n <= perMin;
}
/** test hook */
export function resetTaskLimits() { buckets.clear(); }

/** /api/tasks and /api/tasks/:id; false for any other URL. */
export async function handleTasksHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let u: URL;
  try { u = new URL(req.url || '/', 'http://x'); } catch { return false; }
  const p = u.pathname;
  if (p !== '/api/tasks' && !p.startsWith('/api/tasks/')) return false;
  const cors = corsOrigin(req);
  if (cors) { res.setHeader('access-control-allow-origin', cors); res.setHeader('vary', 'origin'); res.setHeader('access-control-allow-credentials', 'true'); }
  if (req.method === 'OPTIONS') {
    if (!cors) { send(res, 403, { error: 'forbidden' }); return true; }
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PATCH', 'access-control-allow-headers': 'content-type, x-assistant-token', 'access-control-max-age': '600' });
    res.end();
    return true;
  }
  const id = p === '/api/tasks' ? null : p.slice('/api/tasks/'.length);
  if (id !== null && !ID_RE.test(id)) { send(res, 404, { error: 'not found' }); return true; }
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const allowed = id === null ? ['GET', 'POST'] : ['PATCH'];
  if (!allowed.includes(method ?? '')) { send(res, 405, { error: `${allowed.join(', ')} only` }, { allow: allowed.join(', ') }); return true; }
  if (!originAllowed(req) || !tokenOk(req)) { send(res, 403, { error: 'forbidden' }); return true; }
  const s = getSession(req);
  if (!s) { send(res, 401, { error: 'login required' }); return true; }
  const ip = clientIp(req);

  if (method === 'GET') {
    if (!allow('r:' + ip, READ_PER_MIN)) { send(res, 429, { error: 'rate limited' }, { 'retry-after': '5' }); return true; }
    const raw = u.searchParams.get('scope') ?? 'mine';
    if (raw !== 'mine' && raw !== 'all') { send(res, 400, { error: 'scope: mine | all' }); return true; }
    const scope = raw === 'all' && canSeeAll(s.role) ? 'all' : 'mine';
    const v = viewer(s);
    const body: TasksResponse = {
      tasks: listFor(v, scope), scope, canAll: canSeeAll(s.role), canCreate: canCreate(s.role), canManage: canManageAll(s.role),
      mineOpen: mineOpen(v), now: new Date().toISOString(),
    };
    send(res, 200, body);
    return true;
  }

  // writes: JSON only (a cross-site form cannot send it), stricter limit
  if (!allow('w:' + ip, WRITE_PER_MIN)) { send(res, 429, { error: 'rate limited' }, { 'retry-after': '10' }); return true; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { send(res, 415, { error: 'JSON body required' }); return true; }
  const raw = await readBody(req);
  let b: unknown = null;
  try { b = raw ? JSON.parse(raw) : null; } catch { /* below */ }
  if (!b || typeof b !== 'object' || Array.isArray(b)) { send(res, 400, { error: 'bad request' }); return true; }
  const r = id === null ? await createTask(s, b as Record<string, unknown>) : await updateTask(s, id, b as Record<string, unknown>);
  send(res, r.status, r.body);
  return true;
}
