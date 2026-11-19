// The chat talks to the assistant server (server/index.ts), which calls Claude with the API key kept on the server.
//  - askStream(history, lang, { onDelta, signal }): POST /api/chat/stream (Server-Sent Events). onDelta gets the
//    whole visible text so far after every chunk; the promise resolves with the final, authoritative answer
//    from the `done` event. On a network error / non-SSE reply / `error` event it falls back ONCE to the JSON
//    endpoint, then to the offline answer.
//  - ask(history, lang): the plain JSON endpoint (kept for compatibility, also the fallback).
// HTTP 429 gives a short "too many questions" answer (no contact buttons); HTTP 503 "assistant not configured" (no API
// key on the server) gives a short "not configured yet" answer (no contact buttons, no fallback to the JSON endpoint).
// If VITE_ASSISTANT_TOKEN is set it is sent as `x-assistant-token` to both endpoints. It is NOT a secret: Vite builds
// it into the public bundle, so it only filters casual bots (see docs/ASSISTANT-API.md).
import type { Answer, Lang, Turn } from './types';
import { STR } from './i18n';

// `?? {}` keeps this module importable outside Vite (node tests); Vite replaces import.meta.env statically.
const ENV: Record<string, string | boolean | undefined> = import.meta.env ?? {};
const str = (k: string) => (typeof ENV[k] === 'string' && ENV[k] ? (ENV[k] as string) : undefined);

const URL_JSON = str('VITE_ASSISTANT_URL') || '/api/chat';
const URL_STREAM = str('VITE_ASSISTANT_STREAM_URL') || URL_JSON.replace(/\/+$/, '') + '/stream';
const TOKEN = str('VITE_ASSISTANT_TOKEN');
/** JSON: whole request; stream: max silence between two chunks (the server sends heartbeats) */
const TIMEOUT_MS = 60000;

/** what the chat gets back */
export type Reply = Answer & {
  /** the server was not reached / failed: the question is not kept in the history */
  remoteFailed?: boolean;
  /** stopped by the user (Stop / Escape / clear); text = what had arrived so far */
  aborted?: boolean;
  /** HTTP 429 */
  rateLimited?: boolean;
  /** HTTP 503 "assistant not configured": the server has no API key */
  notConfigured?: boolean;
};

export interface StreamOpts {
  /** whole visible answer text so far ('' = start again, e.g. before the JSON fallback) */
  onDelta?(textSoFar: string): void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- helpers

function headers(sse: boolean): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (sse) h.accept = 'text/event-stream';
  if (TOKEN) h['x-assistant-token'] = TOKEN;
  return h;
}

function body(history: Turn[], lang: Lang) {
  return JSON.stringify({ lang, messages: history.slice(-20) });
}

/** split on blank lines, like the server does for `text: string[]` */
export function paragraphs(t: string): string[] {
  return t.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
}

/** defensive: never show (or read aloud) a marker, even a half-received one */
export function visibleText(t: string): string {
  return t.replace(/\[\[[^\]\n]*\]\]/g, '').replace(/\[\[[^\]\n]*\]?$/, '').replace(/\[$/, '');
}

function normalize(r: Partial<Answer> | null | undefined, lang: Lang): Reply {
  const text = Array.isArray(r?.text) ? r!.text.filter((t) => typeof t === 'string' && t.trim()) : [];
  if (!text.length) return offline(lang);
  return {
    text,
    sources: Array.isArray(r?.sources) ? r!.sources : [],
    fallback: !!r?.fallback,
    actions: Array.isArray(r?.actions) ? r!.actions : [],
  };
}

function offline(lang: Lang): Reply {
  return { text: [STR[lang].offline], sources: [], fallback: true, remoteFailed: true };
}

function rateLimited(lang: Lang, retryAfter: string | null): Reply {
  const sec = Number(retryAfter);
  const wait = Number.isFinite(sec) && sec > 0 && sec <= 3600 ? Math.ceil(sec) : 0;
  const pl = lang === 'pl';
  const msg = pl
    ? `Zbyt wiele pytań, spróbuj za chwilę${wait ? ` (ok. ${wait < 120 ? `${wait} s` : `${Math.ceil(wait / 60)} min`})` : ''}.`
    : `Too many questions, please try again in a moment${wait ? ` (about ${wait < 120 ? `${wait} s` : `${Math.ceil(wait / 60)} min`})` : ''}.`;
  return { text: [msg], sources: [], fallback: false, actions: [], remoteFailed: true, rateLimited: true };
}

const NOT_CONFIGURED = 'assistant not configured';

function notConfigured(lang: Lang): Reply {
  const msg = lang === 'pl'
    ? 'Asystent nie jest jeszcze skonfigurowany na serwerze (brak klucza API). Pozostałe zakładki działają.'
    : 'The assistant is not configured on the server yet (no API key). The other tabs work.';
  return { text: [msg], sources: [], fallback: false, actions: [], remoteFailed: true, notConfigured: true };
}

/** a 503 whose body (JSON or one SSE `error` event) says "assistant not configured" */
async function isNotConfigured(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try { return (await res.text()).includes(NOT_CONFIGURED); } catch { return false; }
}

function aborted(soFar: string): Reply {
  return { text: paragraphs(visibleText(soFar)), sources: [], actions: [], aborted: true, remoteFailed: true };
}

/** one controller fed by the caller's signal and an (idle) timeout; bump() restarts the timeout */
function linked(outer: AbortSignal | undefined, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  let t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (outer?.aborted) ctrl.abort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    bump() { clearTimeout(t); t = setTimeout(() => ctrl.abort(), ms); },
    done() { clearTimeout(t); outer?.removeEventListener('abort', onAbort); },
  };
}

function parseJson(s: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------- SSE

export interface SseEvent { event: string; data: string }

/** Minimal Server-Sent Events reader (WHATWG rules): `event:` / multi-line `data:` / `:` comments, CRLF / LF / CR
 *  line ends, events and lines (and UTF-8 characters) split across chunks. `onChunk` is called per received chunk. */
export async function* sseEvents(stream: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) buf += dec.decode();
      else { onChunk?.(); buf += dec.decode(value, { stream: true }); }
      // a trailing lone \r may be the first half of \r\n: keep it unless the stream ended
      const lines = buf.split(done ? /\r\n|\n|\r/ : /\r\n|\n|\r(?!$)/);
      buf = lines.pop() ?? '';
      if (done && buf) { lines.push(buf); buf = ''; }
      for (const line of lines) {
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = ''; data = [];
          continue;
        }
        if (line.startsWith(':')) continue; // comment / heartbeat
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        let val = i < 0 ? '' : line.slice(i + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
      if (done) {
        // lenient: a last event without the closing blank line still counts
        if (data.length) yield { event: event || 'message', data: data.join('\n') };
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------- public

/** Plain JSON endpoint. */
export async function ask(history: Turn[], lang: Lang, signal?: AbortSignal): Promise<Reply> {
  const l = linked(signal);
  try {
    const res = await fetch(URL_JSON, {
      method: 'POST', headers: headers(false), body: body(history, lang), signal: l.signal, credentials: 'omit',
    });
    if (res.status === 429) return rateLimited(lang, res.headers.get('retry-after'));
    if (await isNotConfigured(res)) return notConfigured(lang);
    if (!res.ok) throw new Error(String(res.status));
    return normalize((await res.json()) as Answer, lang);
  } catch {
    return signal?.aborted ? aborted('') : offline(lang);
  } finally {
    l.done();
  }
}

/** Streaming endpoint with one JSON fallback. */
export async function askStream(history: Turn[], lang: Lang, opts: StreamOpts = {}): Promise<Reply> {
  const { onDelta, signal } = opts;
  let soFar = '';
  let shown = '';
  const l = linked(signal);
  try {
    const res = await fetch(URL_STREAM, {
      method: 'POST', headers: headers(true), body: body(history, lang), signal: l.signal, credentials: 'omit',
    });
    if (res.status === 429) return rateLimited(lang, res.headers.get('retry-after'));
    if (await isNotConfigured(res)) return notConfigured(lang);
    const sse = (res.headers.get('content-type') || '').includes('text/event-stream');
    if (res.ok && sse && res.body) {
      for await (const ev of sseEvents(res.body, l.bump)) {
        if (ev.event === 'delta') {
          const d = parseJson(ev.data);
          if (typeof d?.text !== 'string' || !d.text) continue;
          soFar += d.text;
          const vis = visibleText(soFar);
          if (vis !== shown) { shown = vis; onDelta?.(vis); }
        } else if (ev.event === 'done') {
          const d = parseJson(ev.data);
          if (d && Array.isArray(d.text)) return normalize(d, lang);
          break; // malformed: fall back
        } else if (ev.event === 'error') {
          const d = parseJson(ev.data);
          if (d?.error === 'rate limited') return rateLimited(lang, null);
          if (d?.error === NOT_CONFIGURED) return notConfigured(lang);
          break;
        }
      }
    } else {
      res.body?.cancel().catch(() => {});
    }
  } catch {
    if (signal?.aborted) return aborted(soFar);
  } finally {
    l.done();
  }
  if (signal?.aborted) return aborted(soFar);
  // network error, non-SSE reply, error event or a stream without `done`: the JSON endpoint, once
  if (shown) onDelta?.('');
  return ask(history, lang, signal);
}
