// Crew task list, client side (server: server/tasks.ts, rules: shared/tasks.ts).
// useTasks polls GET /api/tasks every 5 s while enabled and the page is visible; 401 = not logged in.
// useTaskBadge polls the count of my active tasks every 20 s for the tab badge.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TasksResponse } from '../../shared/tasks';

export type TasksData =
  | { status: 'loading' | 'down' | 'login'; res: null }
  | { status: 'ok'; res: TasksResponse };

const POLL_MS = 5000;
const TOKEN = (import.meta.env?.VITE_ASSISTANT_TOKEN as string | undefined) || '';
const headers = (json = false): Record<string, string> => ({
  accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...(TOKEN ? { 'x-assistant-token': TOKEN } : {}),
});

export type WriteResult = { ok: true; task: Task } | { ok: false; status: number; error: string };
async function write(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<WriteResult> {
  try {
    const r = await fetch(url, { method, headers: headers(true), credentials: 'same-origin', body: JSON.stringify(body) });
    const j = await r.json().catch(() => null) as { task?: Task; error?: string } | null;
    if (r.ok && j?.task) return { ok: true, task: j.task };
    return { ok: false, status: r.status, error: j?.error ?? String(r.status) };
  } catch { return { ok: false, status: 0, error: 'offline' }; }
}
/** window event after a local change, so the tab badge updates at once */
export const TASKS_CHANGED = 'ju-tasks-changed';
const changed = (r: WriteResult) => { if (r.ok) dispatchEvent(new Event(TASKS_CHANGED)); return r; };
export const createTask = (body: unknown) => write('/api/tasks', 'POST', body).then(changed);
export const patchTask = (id: string, body: unknown) => write(`/api/tasks/${id}`, 'PATCH', body).then(changed);

export function useTasks(enabled: boolean, scope: 'mine' | 'all'): { data: TasksData; refresh(): void; skew: number } {
  const [data, setData] = useState<TasksData>({ status: 'loading', res: null });
  const [skew, setSkew] = useState(0);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer = 0, fails = 0;
    const ctl = new AbortController();
    const tick = async () => {
      clearTimeout(timer);
      if (document.hidden) { timer = window.setTimeout(tick, POLL_MS); return; }
      try {
        const r = await fetch(`/api/tasks?scope=${scope}`, { signal: ctl.signal, credentials: 'same-origin', headers: headers() });
        if (r.status === 401) { setData({ status: 'login', res: null }); fails = 0; }
        else if (!r.ok) throw new Error(String(r.status));
        else {
          const res = (await r.json()) as TasksResponse;
          if (stop) return;
          setSkew(Date.parse(res.now) - Date.now());
          setData({ status: 'ok', res });
          fails = 0;
        }
      } catch {
        if (stop) return;
        fails++;
        if (fails > 1) setData((d) => (d.status === 'ok' ? d : { status: 'down', res: null }));
      }
      if (!stop) timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** Math.max(0, fails - 1), 30_000));
    };
    kick.current = () => { void tick(); };
    const onVis = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVis);
    void tick();
    return () => { stop = true; ctl.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); kick.current = () => {}; };
  }, [enabled, scope]);
  const refresh = useCallback(() => kick.current(), []);
  return { data, refresh, skew };
}

/** Number of my active tasks (open + in progress), null when unknown / logged out. */
export function useTaskBadge(enabled: boolean): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) { setN(null); return; }
    let stop = false, timer = 0;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await fetch('/api/tasks?scope=mine', { credentials: 'same-origin', headers: headers() });
          if (r.ok) { const j = (await r.json()) as TasksResponse; if (!stop) setN(j.mineOpen); }
          else if (r.status === 401 && !stop) setN(null);
        } catch { /* keep the last count */ }
      }
      if (!stop) timer = window.setTimeout(tick, 20_000);
    };
    const again = () => { clearTimeout(timer); void tick(); };
    addEventListener(TASKS_CHANGED, again);
    void tick();
    return () => { stop = true; clearTimeout(timer); removeEventListener(TASKS_CHANGED, again); };
  }, [enabled]);
  return n;
}
