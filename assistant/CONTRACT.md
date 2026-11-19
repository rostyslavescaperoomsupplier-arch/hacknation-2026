# Contract: Jantar Unity crew assistant (parallel build)

App: `assistant/` (Vite + React 19 + Tailwind v4 + three 0.186 via ../mewka/node_modules, dedupe in vite.config.ts).
Do NOT run `npm install`, `vite build` or start servers. Type-check only: `cd assistant && npx tsc --noEmit`.
No emoji anywhere, no icon libraries (Lucide etc.). Use `src/icons/Icon.tsx` or draw small inline SVG.

## Style ("technical drawing" look of the Jantar Unity renders)
Tokens in `src/styles.css` (use Tailwind names, never raw hex in components):
`bg-page` (blue-grey page), `bg-paper` (white panels), `bg-paper-2`, `text-ink` (navy), `text-ink-2`, `border-line`,
`gold`/`gold-ink` = SAFETY ORANGE (accent, alarms), `ok` = evacuation green, `danger` = fire red, `teal`, `navy`.
Classes: `.tech-title` (Barlow Condensed, bold, UPPERCASE: section/drill titles), `.tech-kicker` (small caps label),
`.panel` (white card with line border), `.tap` (44px min target). Body font Barlow.
POLISH IS THE MAIN LANGUAGE: the app opens in Polish (`?lang=en` only as an option). Write every text in Polish first, English second: `const L = (lang: Lang, pl: string, en: string) => lang === 'pl' ? pl : en` (de/uk fall back to en).
`Lang` from `src/types.ts` ('pl'|'en'|'de'|'uk').

## Ship geometry (public/models/ship.glb, metres, Y up, bow = +Z, port = -X, starboard = +X)
Full table: `ship-anchors.txt`. Key decks (floor Y): engine room -4, vehicle deck D1 1.8, vehicle deck D2 7.0,
cabin deck D3 12.5, public deck D4 16.0, sun/boat deck D5 19.5. Hull z -97.9..97.8, beam ±16.
Stairwells (all decks, y 2..20.5): `stair-aft` x 3..7 z -29..-19; `stair-fwd` x 3..7 z 22..32. Engine-room stair to D1: x 3..7 z -29..-19.
Cabin corridor: x≈0, z -34..50 on D3. Lifeboats y 18.7..21.1 at x ±16, z -56..10. Liferafts x ±13, z -61..23.
Models: `/models/ship.glb` (full, 10.6 MB), `/models/ship-cabins.glb` (cabin deck cutaway), `/models/ship-engine.glb` (engine deck, low walls).

## Shared ids
Zones (`ZoneId`): 'bridge' | 'cabins-fwd' | 'cabins-mid' | 'cabins-aft' | 'restaurant' | 'lounge' | 'reclining-lounge' |
'vehicle-d1' | 'vehicle-d2' | 'engine-room' | 'engine-control' .
Muster stations (`MusterId`): 'muster-a' (boat deck D5 AFT, port+stbd lifeboats z≈-50..-30), 'muster-b' (boat deck D5 FWD, lifeboats z≈-10..10).
Drills (`DrillId`): 'fire' | 'abandon' | 'mob' | 'flooding' | 'pollution' | 'blackout' | 'medical'.

## Modules
- Agent SHIP owns `src/ship/**`: `export default function ShipPanel(props: { lang: Lang; mode: 'model' | 'evac'; zone?: ZoneId | null; blocked?: 'stair-aft' | 'stair-fwd' | null; onZone?(z: ZoneId): void })`
  and exports `ZONES`, `MUSTERS`, types `ZoneId`, `MusterId` from `src/ship/routes.ts`.
- Agent DRILLS owns `src/drills/**`: `export default function DrillsPanel(props: { lang: Lang; drill?: DrillId | null; onShowRoute(zone: ZoneId, blocked?: 'stair-aft' | 'stair-fwd' | null): void })`
  and exports `DRILLS`, `DrillId` from `src/drills/data.ts`. Imports `ZoneId` type from `../ship/routes` (type-only).
- Agent SHELL owns `src/App.tsx`, `src/main.tsx`, `src/Assistant.tsx`, `src/styles.css`, `server/**`.
  Tabs: Asystent | Statek 3D (`ShipPanel mode="model"`) | Ewakuacja (`ShipPanel mode="evac"`) | Ćwiczenia (`DrillsPanel`).
  The assistant can emit actions `[[ROUTE:<zone>]]`, `[[ROUTE:<zone>:<blocked-stair>]]`, `[[DRILL:<id>]]` that open those tabs.

All safety content is TRAINING material based on general SOLAS / IMO practice, not the real ship's Muster List or SMS.
Show that once per panel, short.
