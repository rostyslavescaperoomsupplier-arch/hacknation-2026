# Contract: assistant server upgrade (parallel build, 2026-11-19)

Scope: ONLY the assistant chat (other teammates own alarms, voice control, training, crew). Work on branch `main`; do not commit/push (the lead does).
Do not run `npm install` (lead installs deps), `vite build`, deploy scripts, or long-running servers. Type-check: `cd assistant && npx tsc --noEmit`.

## Endpoints (server/index.ts)
- `GET /api/health` -> `{ ok: true, model, knowledge: { files: number, chars: number }, uptime }`.
- `POST /api/chat` (unchanged JSON, kept for compatibility): body `{ lang, messages: Turn[] }` -> `{ text: string[], sources: Source[], fallback?: boolean, actions?: Action[] }`.
- `POST /api/chat/stream` (new, Server-Sent Events, `content-type: text/event-stream`): same body. Events, each `data:` is JSON:
  - `event: delta` `{ "text": "<new text chunk, markers already removed>" }` (may arrive many times)
  - `event: done` `{ "text": string[], "sources": Source[], "fallback": boolean, "actions": Action[] }` (final, authoritative; paragraphs split like /api/chat)
  - `event: error` `{ "error": "assistant unavailable" | "rate limited" | "bad request" }`
  Markers like `[[ROUTE:...]]`, `[[DRILL:...]]`, `[[KONTAKT]]`, `[[SRC:n]]` must never appear in deltas: hold back any text from `[[` until the marker closes or is clearly not a marker.
- Errors: 400 bad input, 403 bad origin, 429 rate limited (with `retry-after`), 502 upstream failure. Never leak stack traces.

## Guard (server/guard.ts)
Per-IP (use `x-forwarded-for` first hop when the request comes from 127.0.0.1, i.e. behind nginx) token bucket: 20 requests / 10 min and 300 / day per IP; global cap 2000 / day; message limits as now (20 turns, 2000 chars each). Origin check: allow same host, `localhost:*`, and `ALLOWED_ORIGINS` env (comma list). Optional shared secret: if env `ASSISTANT_TOKEN` is set, require header `x-assistant-token` (document it; terminals can set it via `VITE_ASSISTANT_TOKEN`).

## Knowledge (server/knowledge/)
`server/knowledge.md` stays the persona-level summary. New folder `server/knowledge/` holds ship documents (`.md`, `.txt`, `.pdf`). On start the server loads them; each becomes a `document` content block with `citations: { enabled: true }` and a `title` (file name without extension), placed in the FIRST user turn of every request (stable, cached with `cache_control`), and the model is told to answer from them. Citations in the response map to `sources: [{ label: "<doc title> - <short cited text>", href: "#doc:<file>" }]` (dedupe, max 4). If the folder is empty, behave exactly as today. NOTE: citations are incompatible with `output_config.format`; we don't use it.

## Types (src/types.ts) — lead-owned, already has: Answer { text, sources, fallback?, actions? }, Turn, Source, Action.
## Ownership
- SERVER agent: `server/index.ts`, `server/guard.ts`, `server/knowledge/` (add a README.md + one small sample doc clearly marked as sample), `server/claude.ts` (optional: the Claude call factored out so tests can inject a fake client: `export function setClient(c)`).
- CLIENT agent: `src/adapter.ts`, `src/Assistant.tsx`, `src/voice/**`, `src/ui/**`.
- TESTS agent: `tests/**` (node --test with strip-types), `docs/ASSISTANT-API.md` (repo root docs folder), and `package.json` "scripts" entry `"test"` only.
