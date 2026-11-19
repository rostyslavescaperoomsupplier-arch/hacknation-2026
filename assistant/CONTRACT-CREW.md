# Contract: assistant <-> crew database (2026-11-19)

The crew database is the teammates' `crew/` server (branch `origin/statystyki`, NOT in main; do not edit it).
It runs locally right now on http://127.0.0.1:8790 (worktree /Users/rostyslav/hacknation-crew/crew) with demo data
(45 crew, 24 rooms, 28 terminals, alerts). Its API (read the source in that worktree: crew/server/index.ts, alerts.ts, README.md):
GET /api/summary, /api/rooms, /api/rooms/:id, /api/crew?q=, /api/terminals, /api/activity, /api/alerts; POST /api/checkin (terminals only).
Room codes like "D1-01"; terminal codes like "T-D1-01-A".

Mapping to our ferry: `assistant/shared/crew-map.ts` (`CREW_ROOM_PLACES`, `terminalAt`, `CrewZone` = our ZoneId + 'boat-deck').
Client imports it as `../../shared/crew-map` (tsconfig/vite already allow ts extensions); server as `../shared/crew-map.ts`.

## Assistant server additions (agent DBLINK)
- env `CREW_API` (default `http://127.0.0.1:8790`).
- Read-only proxy for the browser: `GET /api/crew/summary | rooms | rooms/:id | crew?q= | terminals | activity | alerts` ->
  same JSON as the crew server, PLUS for rooms and terminals add `place: { zone, at }` from the map (null if unmapped).
  2 s timeout, 3 s in-memory cache per path, 503 `{error:"crew database unavailable"}` when down. Same guard origin check as chat, but NOT the chat rate limit (use a separate, generous limit: 120/min per IP). Never proxy POST.
- Claude tools in the chat (both /api/chat and /api/chat/stream), read-only, results as compact JSON:
  `crew_summary()`, `find_crew(query)` (name/rank/badge -> where they are now, since when, cabin, phone ext),
  `room_people(room)` (room code or name fragment -> people inside, capacity, occupancy),
  `safety_alerts()` (staffing, lone workers, stale check-ins), `list_terminals()`.
  System prompt: crew data is live from the terminal check-ins; answer with names/ranks/places; privacy: share only
  on-board info (no birth dates / nationality unless asked by role); if the DB is down say so.
  Mewka may also add `[[ROUTE:zone]]` when she tells where someone is (zone from the map).
- Tests: extend `tests/` with a fake crew server (node http on a random port) + ASSISTANT_FAKE for Claude.

## Map additions (agent MAP)
In `src/ship/**` only: a "Załoga" layer in ShipPanel mode="model" (toggle, default ON) and a small summary in mode="evac":
- poll `/api/crew/terminals`, `/api/crew/rooms`, `/api/crew/alerts` every 5 s while the panel is visible;
- terminal markers (small square reader icon, label = terminal code on hover/focus) at `place.at` via `terminalAt`;
  per-zone headcount badges (sum of room.people per zone), rooms with critical/warning alerts tinted red/orange;
- clicking a terminal or zone badge shows a side panel list: room name, people inside (name, rank, since), alerts;
- evac mode: "Osoby w strefie: N" for the chosen start zone + names, from the same data;
- graceful state when /api/crew/* returns 503 ("Brak połączenia z bazą załogi").
Accessible list equivalent of the markers for screen readers/keyboard. Polish first.
