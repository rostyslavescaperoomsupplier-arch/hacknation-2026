// Action markers for the local engine: the same rules as parseActions() in server/claude.ts (kept in step by
// tests/local.test.ts), so local answers produce exactly the buttons a Claude answer would.
//   [[ROUTE:<zone>]] / [[ROUTE:<zone>:<stair>]] / [[DRILL:<id>]]  -> validated actions (unknown ids dropped, max 4)
//   any other [[WORD]] / [[WORD:args]] marker (KONTAKT ...)         -> removed from the text
import type { Action } from '../types.ts';

const ZONES: Record<string, [string, string]> = {
  'bridge': ['mostek nawigacyjny', 'navigation bridge'],
  'cabins-fwd': ['kabiny na dziobie, pokład 3', 'forward cabins, deck 3'],
  'cabins-mid': ['kabiny na śródokręciu, pokład 3', 'midship cabins, deck 3'],
  'cabins-aft': ['kabiny na rufie, pokład 3', 'aft cabins, deck 3'],
  'restaurant': ['restauracja, pokład 4', 'restaurant, deck 4'],
  'lounge': ['salon, pokład 4', 'lounge, deck 4'],
  'reclining-lounge': ['sala foteli lotniczych, pokład 4', 'reclining seat lounge, deck 4'],
  'vehicle-d1': ['pokład samochodowy 1', 'vehicle deck 1'],
  'vehicle-d2': ['pokład samochodowy 2', 'vehicle deck 2'],
  'engine-room': ['maszynownia', 'engine room'],
  'engine-control': ['centrala manewrowo-kontrolna (CMK)', 'engine control room'],
};
const STAIRS: Record<string, [string, string]> = {
  'stair-aft': ['klatka schodowa rufowa', 'aft stairwell'],
  'stair-fwd': ['klatka schodowa dziobowa', 'forward stairwell'],
};
const DRILLS: Record<string, [string, string]> = {
  'fire': ['pożar', 'fire'],
  'abandon': ['opuszczenie statku', 'abandon ship'],
  'mob': ['człowiek za burtą', 'man overboard'],
  'flooding': ['przeciek i zalanie', 'flooding'],
  'pollution': ['zanieczyszczenie morza olejem', 'oil pollution'],
  'blackout': ['zanik zasilania (blackout)', 'blackout'],
  'medical': ['nagły wypadek medyczny', 'medical emergency'],
};
const ACTION_RE = /\[\[(ROUTE|DRILL):([a-z0-9-]+)(?::([a-z-]+))?\]\]/g;
const ANY_MARKER_RE = /\[\[[A-Z]+(?::[A-Za-z0-9:_-]*)?\]\]/g;
export const CONTACT_MARK = '[[KONTAKT]]';

const name = (pair: [string, string], lang: string) => (lang === 'pl' ? pair[0] : pair[1]);

/** Validated actions out of `text`, and the text without any marker. Markers typed by the user (`userText`) are ignored. */
export function parseActions(text: string, lang: string, userText = ''): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ACTION_RE)) {
    const [key, kind, id, extra] = m;
    if (seen.has(key)) continue;
    seen.add(key);
    if (userText && userText.includes(key)) continue;
    if (kind === 'ROUTE' && ZONES[id]) {
      const blocked = extra && STAIRS[extra] ? (extra as 'stair-aft' | 'stair-fwd') : undefined;
      let label = name(ZONES[id], lang);
      if (blocked) label += lang === 'pl' ? `, zablokowana ${name(STAIRS[blocked], lang)}` : `, ${name(STAIRS[blocked], lang)} blocked`;
      actions.push(blocked ? { type: 'route', zone: id, blocked, label } : { type: 'route', zone: id, label });
    } else if (kind === 'DRILL' && DRILLS[id]) {
      actions.push({ type: 'drill', id, label: name(DRILLS[id], lang) });
    }
  }
  return { text: text.replace(ANY_MARKER_RE, '').replace(/[ \t]+\n/g, '\n'), actions: actions.slice(0, 4) };
}
