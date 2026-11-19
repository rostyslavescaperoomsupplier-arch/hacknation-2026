// Crew task list ("Zadania dla załogi"): types, labels and the visibility / ordering rules shared by the assistant
// server (server/tasks.ts) and the panel (src/tasks/**). Dependency-free apart from type imports, like shared/alarms.ts.
// Client imports it as `../../shared/tasks`, the server as `../shared/tasks.ts`.
import type { AlarmKind, AlarmZone } from './alarms.ts';

export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const isTaskPriority = (v: unknown): v is TaskPriority => typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v);

export const TASK_STATUSES = ['open', 'in-progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const isTaskStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
export const isFinished = (s: TaskStatus) => s === 'done' || s === 'cancelled';

/** Same ids as Role in server/auth.ts. */
export const TASK_ROLES = ['captain', 'bridge', 'engine', 'crew'] as const;
export type TaskRole = (typeof TASK_ROLES)[number];
export const isTaskRole = (v: unknown): v is TaskRole => typeof v === 'string' && (TASK_ROLES as readonly string[]).includes(v);

/** Departments of the crew database (crew/server/db.ts). */
export const DEPARTMENTS = ['Pokład', 'Maszynownia', 'Hotel', 'Medyczny'] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const isDepartment = (v: unknown): v is Department => typeof v === 'string' && (DEPARTMENTS as readonly string[]).includes(v);

export type AssigneeKind = 'person' | 'role' | 'department' | 'all';
/** person: value = crew account id (as text); role: TaskRole; department: Department; all: value ''. label = display text (PL). */
export interface TaskAssignee { kind: AssigneeKind; value: string; label: string }
/** who did something; id null = the system (alarm centre, the day plan) */
export interface TaskPerson { id: number | null; name: string; rank: string }

export interface Task {
  id: string;
  title: string;
  details?: string;
  assignee: TaskAssignee;
  zone?: AlarmZone;
  priority: TaskPriority;
  /** ISO time the task should be done by */
  due?: string;
  status: TaskStatus;
  createdBy: TaskPerson;
  createdAt: string;
  updatedAt: string;
  takenBy?: TaskPerson;
  doneBy?: TaskPerson;
  /** when it was finished (done or cancelled) */
  doneAt?: string;
  /** auto task created for this alarm */
  alarmId?: string;
  alarmKind?: AlarmKind;
  alarmDrill?: boolean;
  /** short completion / cancellation note */
  note?: string;
}

export const TITLE_MAX = 120;
export const DETAILS_MAX = 500;
export const NOTE_MAX = 200;
/** due in minutes from now, accepted range */
export const DUE_MIN_MAX = 7 * 24 * 60;

/** Who is asking (subset of server/auth.ts Session / src/auth User). */
export interface TaskViewer { id: number; role: TaskRole; department: string }

/** Officers may see the whole list (scope=all) and create tasks. */
export const canSeeAll = (role: TaskRole | null | undefined) => role === 'captain' || role === 'bridge' || role === 'engine';
export const canCreate = canSeeAll;
/** Cancel / edit any task: the master and the bridge (the creator may also do it for their own tasks). */
export const canManageAll = (role: TaskRole | null | undefined) => role === 'captain' || role === 'bridge';

/** Assigned to this person: to them by name, to their role (the master also gets the bridge's), department or everybody. */
export function assignedTo(t: Pick<Task, 'assignee'>, v: TaskViewer): boolean {
  const a = t.assignee;
  switch (a.kind) {
    case 'all': return true;
    case 'person': return a.value === String(v.id);
    case 'role': return a.value === v.role || (a.value === 'bridge' && v.role === 'captain');
    case 'department': return fold(a.value) === fold(v.department);
    default: return false;
  }
}
/** "Moje": assigned to me, or a task I have taken. */
export const isMine = (t: Task, v: TaskViewer) => assignedTo(t, v) || t.takenBy?.id === v.id;

const fold = (s: string) => s.normalize('NFC').trim().toLowerCase();
const PRIO_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK: Record<TaskStatus, number> = { 'in-progress': 0, open: 0, done: 1, cancelled: 1 };
/** Active before finished; urgent/high first; then the nearest due time; then newest. Finished: last finished first. */
export function taskOrder(a: Task, b: Task): number {
  const fin = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (fin) return fin;
  if (isFinished(a.status)) return Date.parse(b.doneAt ?? b.updatedAt) - Date.parse(a.doneAt ?? a.updatedAt);
  return PRIO_RANK[a.priority] - PRIO_RANK[b.priority]
    || (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity)
    || (Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export interface TasksResponse {
  tasks: Task[];
  scope: 'mine' | 'all';
  /** this user may ask for scope=all / create / cancel any task */
  canAll: boolean;
  canCreate: boolean;
  canManage: boolean;
  /** my active (open + in progress) tasks, whatever the scope */
  mineOpen: number;
  now: string;
}

// ---------- labels (Polish first) ----------
type Txt = { pl: string; en: string };
export const PRIORITY_NAMES: Record<TaskPriority, Txt> = {
  urgent: { pl: 'Pilne', en: 'Urgent' },
  high: { pl: 'Wysoki', en: 'High' },
  normal: { pl: 'Normalny', en: 'Normal' },
  low: { pl: 'Niski', en: 'Low' },
};
export const STATUS_NAMES: Record<TaskStatus, Txt> = {
  open: { pl: 'Do zrobienia', en: 'To do' },
  'in-progress': { pl: 'W toku', en: 'In progress' },
  done: { pl: 'Zrobione', en: 'Done' },
  cancelled: { pl: 'Anulowane', en: 'Cancelled' },
};
export const ROLE_NAMES: Record<TaskRole, Txt> = {
  captain: { pl: 'Kapitan', en: 'Master' },
  bridge: { pl: 'Oficerowie mostka', en: 'Bridge officers' },
  engine: { pl: 'Mechanicy', en: 'Engineers' },
  crew: { pl: 'Załoga', en: 'Crew' },
};
export const DEPARTMENT_NAMES: Record<Department, Txt> = {
  'Pokład': { pl: 'Dział pokładowy', en: 'Deck department' },
  Maszynownia: { pl: 'Dział maszynowy', en: 'Engine department' },
  Hotel: { pl: 'Dział hotelowy', en: 'Hotel department' },
  Medyczny: { pl: 'Służba medyczna', en: 'Medical' },
};
/** Short zone names for task titles (the client has the full ones in src/ship/routes.ts). */
export const ZONE_SHORT: Record<AlarmZone, Txt> = {
  bridge: { pl: 'mostek', en: 'bridge' },
  'cabins-fwd': { pl: 'kabiny dziobowe', en: 'forward cabins' },
  'cabins-mid': { pl: 'kabiny śródokręcie', en: 'midship cabins' },
  'cabins-aft': { pl: 'kabiny rufowe', en: 'aft cabins' },
  restaurant: { pl: 'restauracja', en: 'restaurant' },
  lounge: { pl: 'salon (bar)', en: 'lounge (bar)' },
  'reclining-lounge': { pl: 'salon z fotelami', en: 'reclining lounge' },
  'vehicle-d1': { pl: 'pokład samochodowy 1', en: 'vehicle deck 1' },
  'vehicle-d2': { pl: 'pokład samochodowy 2', en: 'vehicle deck 2' },
  'engine-room': { pl: 'maszynownia', en: 'engine room' },
  'engine-control': { pl: 'centrum kontroli maszynowni', en: 'engine control room' },
};

/** Display label of an assignee (Polish; person labels come from the roster). */
export function assigneeLabel(kind: AssigneeKind, value: string, lang: 'pl' | 'en' = 'pl'): string {
  if (kind === 'all') return lang === 'pl' ? 'Wszyscy' : 'Everybody';
  if (kind === 'role' && isTaskRole(value)) return ROLE_NAMES[value][lang];
  if (kind === 'department' && isDepartment(value)) return DEPARTMENT_NAMES[value][lang];
  return value;
}
