// Local answer engine of Mewka: deterministic retrieval + templates, no LLM, no API key, works offline.
// Pure TS (no DOM, no Node APIs): the browser runs it by default (src/adapter.ts), the server can run the very same
// code (server/local.ts, ASSISTANT_ENGINE=local or auto without credentials). Node imports it directly
// (--experimental-strip-types), so every relative import carries its .ts extension and client-only imports are type-only.
//
// Pipeline: normalise (lowercase, Polish diacritics folded, ł -> l) -> tokens -> features (stem / fuzzy keyword matches
// and phrase regexes, Polish and English) -> one intent -> short plain-text paragraphs with the same action markers
// Claude uses ([[ROUTE:zone(:stair)]], [[DRILL:id]], [[KONTAKT]]) -> parseActions() (actions.ts, same rules as the
// server) -> { text, sources, fallback, actions, engine: "local" }, the shape of /api/chat.
//
// Knowledge: drill cards (src/drills/data.ts), evacuation routes (src/ship/routes.ts) and, for crew questions, a
// CrewSource (crew.ts): the browser reads the /api/crew/* proxy, the server calls its crew tools.
// Follow-ups: earlier user turns are classified the same way; a short "a jeśli ..." / "what if ..." question, or one with
// only a zone / stairwell / rank in it, reuses the previous intent (drill, zone, crew query) with the new detail.
import type { Action, Lang, Source, Turn } from '../types.ts';
import { DRILL_BY_ID, type DrillId, type Txt } from '../drills/data.ts';
import { ZONE, route, fmtTime, type Stair, type ZoneId } from '../ship/routes.ts';
import { CREW_ROOM_PLACES } from '../../shared/crew-map.ts';
import { norm, fold, countStems } from './text.ts';
import { parseActions, CONTACT_MARK } from './actions.ts';
import { CrewError, type CrewPerson, type CrewSource } from './crew.ts';

export type L2 = 'pl' | 'en';
export type Kind = DrillId | 'general';
export type IntentType =
  | 'emergency' | 'signal' | 'frequency' | 'roles' | 'route' | 'muster'
  | 'crew-where' | 'crew-room' | 'crew-alerts' | 'crew-summary'
  | 'equipment' | 'help' | 'voice' | 'greeting' | 'thanks' | 'identity' | 'fallback';

export interface Intent {
  type: IntentType;
  kind?: Kind;
  zone?: ZoneId;
  blocked?: Stair;
  /** crew-where: find_crew query; crew-room: room code(s) */
  query?: string;
  rank?: boolean;
  rooms?: string[];
  roomLabel?: string;
}


// ---------------------------------------------------------------- text

const toks = (n: string) => n.trim().split(' ').filter(Boolean);
const tr = (l: L2, t: Txt) => (l === 'pl' ? t.pl : t.en);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stop = (s: string) => (/[.!?…]$/.test(s) ? s : s + '.');

// ---------------------------------------------------------------- language

const PL_WORDS = new Set(['jest', 'gdzie', 'co', 'jak', 'czy', 'kto', 'sie', 'na', 'w', 'z', 'do', 'robic', 'zrobic', 'jaki', 'jaka',
  'jakie', 'ile', 'nie', 'przy', 'dla', 'po', 'od', 'mam', 'mi', 'mnie', 'jesli', 'gdy', 'teraz', 'sa', 'pokaz', 'droga', 'drogi',
  'pozar', 'pozaru', 'kabin', 'kabiny', 'kabinach', 'statku', 'zaloga', 'zalogi', 'dzien', 'dobry', 'czesc', 'dziekuje', 'prosze',
  'potrafisz', 'umiesz', 'ze', 'tak', 'albo', 'lub', 'oraz', 'ktory', 'ktora', 'jestes', 'sygnal', 'alarm', 'ewakuacji', 'zablokowane']);
const EN_WORDS = new Set(['the', 'is', 'where', 'what', 'how', 'who', 'do', 'in', 'on', 'if', 'are', 'can', 'you', 'my', 'from', 'to',
  'there', 'which', 'should', 'many', 'people', 'board', 'fire', 'cabin', 'cabins', 'room', 'deck', 'route', 'show', 'me', 'does',
  'hello', 'hi', 'thanks', 'thank', 'signal', 'alarm', 'general', 'blocked', 'abandon', 'ship', 'man', 'overboard', 'and', 'of',
  'evacuation', 'when', 'help', 'i', 'a', 'an', 'it', 'its', 'whats', 'wheres', 'whos', 'now', 'right', 'with', 'at', 'about']);
const AMBIGUOUS = new Set(['alarm', 'signal', 'a', 'i']);

/** pl / en from the question text; `fallback` (the UI language) wins a tie. */
export function detectLang(text: string, fallback: Lang): L2 {
  let pl = /[ąćęłńóśźż]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const t of toks(norm(text))) {
    if (AMBIGUOUS.has(t)) continue;
    if (PL_WORDS.has(t)) pl++;
    if (EN_WORDS.has(t)) en++;
  }
  if (pl > en) return 'pl';
  if (en > pl) return 'en';
  return fallback === 'pl' ? 'pl' : 'en';
}

// ---------------------------------------------------------------- lexicon

/** drill kinds: token prefixes (stems) and phrase regexes on the normalised text */
const KIND_LEX: Record<Kind, { pre: string[]; re: RegExp[] }> = {
  fire: {
    pre: ['pozar', 'ogien', 'ognia', 'ogniu', 'plomie', 'plomien', 'dym', 'gasnic', 'gaszen', 'fire', 'smoke', 'flame', 'extinguish'],
    re: [/ pali sie /, / plonie /, / burning /],
  },
  abandon: {
    pre: ['abandon', 'szalup', 'tratw', 'lifeboat', 'liferaft'],
    re: [/ opuszcz\w* (statk|prom)/, / (lodz|lodzi|lodzie|lodziach) ratunk/, / leave the ship /],
  },
  mob: {
    pre: ['overboard'],
    re: [/ za burt/, / (czlowiek|osoba|ktos) w wodzie /, / wypadl\w* (za|do wody)/, / mob /, / (person|man|someone) in the water /],
  },
  flooding: {
    pre: ['przeciek', 'zalan', 'zalew', 'zaton', 'tonie', 'tonac', 'wodoszczel', 'przebic', 'flood', 'leak', 'sinking', 'zez'],
    re: [/ (wejsci\w*|wyciek\w*|wdziera\w*|przybywa\w*) wod/, / wod[ay]? (w|na|wchodzi|sie wdziera|przybywa|leje)/, / water (in|ingress|coming|rising)/, / hull (breach|damage)/, / dziur\w* w (kadlub|burc)/],
  },
  pollution: {
    pre: ['rozlew', 'olej', 'sopep', 'oil', 'spill', 'pollut', 'bunkr', 'bunker', 'zanieczyszcz', 'paliw'],
    re: [/ wyciek\w* (paliw|olej)/, / plam\w* (olej|paliw)/],
  },
  blackout: {
    pre: ['blackout', 'zasilan', 'prad', 'ciemno', 'ciemn'],
    re: [/ (zanik|brak|utrat\w*) (pradu|zasilania|energii)/, / power (failure|loss|cut|outage)/, / (lost|no|loss of) (main )?power /, / (generator|agregat) awaryjn/, / emergency generator /, / lights? (went )?out /],
  },
  medical: {
    pre: ['medyczn', 'zawal', 'uraz', 'nieprzytom', 'krwaw', 'krwotok', 'omdl', 'rann', 'zlaman', 'oparzen', 'reanim', 'rko', 'aed',
      'defibryl', 'udar', 'duszn', 'zaslab', 'medical', 'injur', 'unconscious', 'bleed', 'cpr', 'collaps', 'faint', 'wounded', 'choking', 'hurt'],
    re: [/ pierwsz\w* pomoc/, / first aid /, / heart attack /, / nie oddycha /, / not breathing /, / stroke /],
  },
  general: {
    pre: [],
    re: [/ alarm\w* ogoln/, / ogoln\w* alarm/, / general (emergency )?alarm/, / (7|siedem) krotk/, / seven short /, / muster alarm /],
  },
};
const KIND_ORDER: Kind[] = ['mob', 'fire', 'flooding', 'medical', 'blackout', 'pollution', 'abandon', 'general'];

const ROUTE_RE = / (drog\w*|tras\w*|ewakuac\w*|ewakuowac|ewakuuj\w*|uciecz\w*|wyjsci\w*|dojsc|dojde|dostac|dostane|route|routes|evacuat\w*|escape|way out|get out|get to|exit) /;
const MUSTER_RE = / (punkt\w*|miejsc\w*|stanowisk\w*|stacj\w*) zbiork| zbiork\w* | muster (station|point)s? | assembly (station|point) /;
const WHERE_RE = / (gdzie|where|wheres|znajde|znalezc|szukam|locate|find) /;
const WHO_RE = / (kto|who|whos|ile (osob|ludzi|czlonkow)|how many (people|crew|persons)) /;
const SIGNAL_RE = / (sygnal\w*|signal\w*|dzwiek\w*|brzmi\w*|sound\w*|gwizd\w*|syren\w*|dzwonk\w*|blasts?|whistle) /;
const FREQ_RE = / (jak czesto|co ile|how often|czestotliw\w*|frequency|ile razy) /;
const ROLES_RE = / (rol[ae]?|role|roles|zadani\w*|obowiazk\w*|duties|kto (co )?robi|who does|kto odpowiada|responsib\w*) /;
const ALERTS_RE = / (alert\w*|samotn\w*|sam w|sama w|lone\w*|alone|pracuje sam\w*|obsad\w*|staffing|understaff\w*|ostrzezen\w*|warnings?|dawno nie|nieaktualn\w*|overdue|stale) /;
const SUMMARY_RE = / (ile (osob|ludzi|czlonkow)\w*( zalogi)? (jest )?(na (pokladzie|statku|promie)|w sumie|lacznie|razem|obecnie|teraz)|how many (people|crew)( members)? (are )?(on board|aboard)|podsumowan\w*|summary|stan zalogi|crew (summary|status|count)|ile jest zalogi) /;
const EQUIP_RE = / (gasnic\w*|extinguishers?|aed|defibrylator\w*|defibrillator|kamizel\w*|lifejackets?|life jackets?|apteczk\w*|first aid kit|kol[ao] ratunk\w*|lifebuoys?|hydrant\w*|aparat\w* oddech\w*|breathing apparatus|tlen|oxygen|nosze|stretcher) /;
const GREET_RE = /^ (czesc|hej|hejka|witaj|witam|dzien dobry|dobry wieczor|siema|halo|hello|hi|hey|good (morning|afternoon|evening)|ahoj)( mewka| mewko)? $/;
const GREET_START_RE = /^ (czesc|hej|witaj|witam|dzien dobry|dobry wieczor|siema|hello|hi|hey|good (morning|afternoon|evening))( mewka| mewko)? /;
const THANKS_RE = / (dzieki|dziekuje|dziekujemy|dzieks|thanks|thank you|thx|cheers) /;
const HELP_RE = / (co (potrafisz|umiesz|mozesz|wiesz)|w czym (mi )?(mozesz )?pomoc|jak (mam )?(z toba )?(rozmawiac|korzystac|uzywac)|what can you|how (do|can) i use|how does this work|what do you know|help me|pomocy) |^ (pomoc|help) $/;
const VOICE_RE = / (glos\w*|mikrofon\w*|mow(ic|ienie)|voice|microphone|speak|speech|talk to you|odsluch\w*|czyta\w* na glos|read aloud) /;
const IDENTITY_RE = / (kim jestes|kto ty|czym jestes|jestes (ai|botem|czlowiekiem|robotem|sztuczn\w*)|who are you|what are you|are you (an? )?(ai|bot|human|robot)) /;
const FOLLOW_RE = /^ (a|i|oraz|to|and|what if|what about|how about|and if) | (a jesli|a gdyby|a co jesli|a co gdy|a gdy|a jak|a teraz|what if|and if|what about) /;
const BLOCK_RE = / (zablok\w*|blok\w*|odciet\w*|zadymion\w*|zamkniet\w*|niedostep\w*|nieprzejezdn\w*|w ogniu|plon\w*|pali sie|nie da sie|nie mozna|blocked|cut off|closed|smoke|smoky|on fire|unusable|impassable) /;

/** zones of OUR ship model; first match wins (ECR before engine room, reclining lounge before lounge) */
function findZone(n: string): ZoneId | undefined {
  if (/ (kabin\w*|cabins?|kajut\w*) /.test(n)) {
    if (/ (ruf\w*|aft|stern) /.test(n)) return 'cabins-aft';
    if (/ (srodo\w*|srodk\w*|mid\w*|midship\w*|amidships) /.test(n)) return 'cabins-mid';
    if (/ (dziob\w*|forward|fwd|bow|fore) /.test(n)) return 'cabins-fwd';
    const num = / (1\d\d) /.exec(n);
    if (num) {
      const c = Number(num[1]);
      if ((c >= 100 && c <= 108) || (c >= 124 && c <= 132)) return 'cabins-aft';
      if ((c >= 112 && c <= 118) || (c >= 136 && c <= 142)) return 'cabins-mid';
      if ([122, 123, 146, 147].includes(c)) return 'cabins-fwd';
    }
  }
  if (/ (centrala|centrali|centrale|ecr|cmk|engine control|control room|centrum kontroli|manewrow\w*) /.test(n)) return 'engine-control';
  if (/ (maszynown\w*|engine rooms?|silnik\w*|engines) /.test(n)) return 'engine-room';
  if (/ (fotel\w*|reclining|lotnicz\w*|seat lounge) /.test(n)) return 'reclining-lounge';
  if (/ (restaurac\w*|restaurant) /.test(n)) return 'restaurant';
  if (/ (salon\w*|bar|barze|baru|lounge) /.test(n)) return 'lounge';
  if (/ (samochod\w*|garaz\w*|car decks?|vehicle\w*|ro ro|ciezarow\w*|aut[ao]?) /.test(n) || /pokla\w* (ladunk\w*)/.test(n))
    return / (2|drugi\w*|gorn\w*|upper|two) /.test(n) ? 'vehicle-d2' : 'vehicle-d1';
  if (/ (mostek|mostku|mostka|bridge|sterowk\w*|sterowni\w*) /.test(n)) return 'bridge';
  return undefined;
}

/** explicitly mentioned stairwell (with or without a "blocked" word next to it) */
function stairMention(n: string): Stair | undefined {
  const aft = / (schod\w*|klat\w*|stair\w*) (\w+ ){0,2}(ruf\w*|aft|stern)|(ruf\w*|aft|stern) (\w+ )?(schod\w*|klat\w*|stair\w*)/.test(n);
  const fwd = / (schod\w*|klat\w*|stair\w*) (\w+ ){0,2}(dziob\w*|forward|fwd|bow|fore)|(dziob\w*|forward|fwd|bow|fore) (\w+ )?(schod\w*|klat\w*|stair\w*)/.test(n);
  if (aft && !fwd) return 'stair-aft';
  if (fwd && !aft) return 'stair-fwd';
  return undefined;
}

/** crew ranks of the crew database: phrase regex -> find_crew query (most specific first) */
const RANKS: [RegExp, string][] = [
  [/ (starsz\w* mechanik\w*|chief engineer|chief eng) /, 'starszy mechanik'],
  [/ (starsz\w* oficer\w*|chief (officer|mate)|pierwsz\w* oficer\w*) /, 'starszy oficer'],
  [/ (iv|czwart\w*) mechanik\w* | fourth engineer /, 'iv mechanik'],
  [/ (iii|trzec\w*) mechanik\w* | third engineer /, 'iii mechanik'],
  [/ (ii|drug\w*) mechanik\w* | second engineer /, 'ii mechanik'],
  [/ (iii|trzec\w*) oficer\w* | third (officer|mate) /, 'iii oficer'],
  [/ (ii|drug\w*) oficer\w* | second (officer|mate) /, 'ii oficer'],
  [/ (oficer\w* radiow\w*|radio officer|radiooficer\w*) /, 'oficer radiowy'],
  [/ (szef\w* kuchni|chef|chief cook) /, 'szef kuchni'],
  [/ (kapitan\w*|captain|master|kapitana) /, 'kapitan'],
  [/ (bosman\w*|bosun|boatswain) /, 'bosman'],
  [/ (elektryk\w*|electrician|eto) /, 'elektryk'],
  [/ (motorzyst\w*|motorman|oiler) /, 'motorzysta'],
  [/ (slusarz\w*|fitter) /, 'slusarz'],
  [/ (lekarz\w*|doctor|doktor\w*|medyk\w*) /, 'lekarz'],
  [/ (ratownik\w* medyczn\w*|ratownik\w*|paramedic) /, 'ratownik'],
  [/ (kucharz\w*|cook) /, 'kucharz'],
  [/ (steward\w*|stewardess) /, 'steward'],
  [/ (kadet\w*|cadet) /, 'kadet'],
  [/ (marynarz\w*|sailor|seaman|deckhand|ab seaman) /, 'marynarz'],
  [/ (mechanik\w*|engineer) /, 'mechanik'],
  [/ (oficer\w*|officer) /, 'oficer'],
];

/** crew database rooms (codes from shared/crew-map.ts) by name fragments */
const ROOMS: [RegExp, string, Txt][] = [
  [/ (kabin\w* radiow\w*|radiow\w*|gmdss|radio room) /, 'D4-02', { pl: 'w kabinie radiowej', en: 'in the radio room' }],
  [/ (sal\w* odpraw|briefing room) /, 'D4-03', { pl: 'w sali odpraw', en: 'in the briefing room' }],
  [/ (biur\w* kapitan\w*|captain s office|captains office) /, 'D3-06', { pl: 'w biurze kapitana', en: "in the captain's office" }],
  [/ (stacj\w* ratunk\w*|rescue station) /, 'D4-04', { pl: 'na stacji ratunkowej', en: 'at the rescue station' }],
  [/ (kabin\w* oficer\w*|officers? cabins) /, 'D3-01', { pl: 'w kabinach oficerskich', en: "in the officers' cabins" }],
  [/ blok\w* a /, 'D3-02', { pl: 'w kabinach załogi, blok A', en: 'in crew cabins block A' }],
  [/ blok\w* b /, 'D3-03', { pl: 'w kabinach załogi, blok B', en: 'in crew cabins block B' }],
  [/ (swietlic\w*|day room|recreation room) /, 'D3-04', { pl: 'w świetlicy', en: 'in the day room' }],
  [/ (silowni\w*|silownia|gym) /, 'D3-05', { pl: 'w siłowni', en: 'in the gym' }],
  [/ (biur\w* ladunk\w*|cargo office) /, 'D2-02', { pl: 'w biurze ładunkowym', en: 'in the cargo office' }],
  [/ (poklad\w* ladunk\w*|cargo deck) /, 'D2-01', { pl: 'na pokładzie ładunkowym', en: 'on the cargo deck' }],
  [/ (kuchni\w*|galley|kitchen) /, 'D2-03', { pl: 'w kuchni', en: 'in the galley' }],
  [/ (mes\w* zalog\w*|crew mess) /, 'D2-04', { pl: 'w mesie załogi', en: 'in the crew mess' }],
  [/ (mes\w* oficer\w*|officers? mess) /, 'D2-05', { pl: 'w mesie oficerskiej', en: "in the officers' mess" }],
  [/ (pralni\w*|laundry) /, 'D2-06', { pl: 'w pralni', en: 'in the laundry' }],
  [/ (szpital\w*|hospital|sick bay|ambulatori\w*) /, 'D2-07', { pl: 'w szpitalu okrętowym', en: 'in the ship hospital' }],
  [/ (magazyn\w* bosman\w*|bosun s store|bosuns store) /, 'D2-08', { pl: 'w magazynie bosmańskim', en: "in the bosun's store" }],
  [/ (magazyn\w* czesci|spare parts) /, 'D1-05', { pl: 'w magazynie części', en: 'in the spare parts store' }],
  [/ (chlodni\w*|cold stores?|provision stores?) /, 'D1-06', { pl: 'w chłodniach', en: 'in the cold stores' }],
  [/ (warsztat\w*|workshop) /, 'D1-03', { pl: 'w warsztacie', en: 'in the workshop' }],
  [/ (pompowni\w*|pump room) /, 'D1-04', { pl: 'w pompowni', en: 'in the pump room' }],
  [/ (centrala|centrali|ecr|cmk|engine control|centrum kontroli) /, 'D1-02', { pl: 'w centrali manewrowej (ECR)', en: 'in the engine control room' }],
  [/ (maszynown\w*|engine room) /, 'D1-01', { pl: 'w maszynowni', en: 'in the engine room' }],
  [/ (mostek|mostku|mostka|bridge) /, 'D4-01', { pl: 'na mostku', en: 'on the bridge' }],
];

/** words that are never a person's name in "gdzie jest X" */
const NOT_NAME = new Set(['gdzie', 'jest', 'sa', 'teraz', 'obecnie', 'aktualnie', 'przebywa', 'znajduje', 'sie', 'znajde', 'moge', 'mozna',
  'znalezc', 'szukam', 'find', 'where', 'wheres', 'is', 'are', 'the', 'now', 'currently', 'right', 'a', 'i', 'oraz', 'pan', 'pani', 'pana',
  'pania', 'mr', 'mrs', 'ms', 'can', 'please', 'prosze', 'powiedz', 'tell', 'me', 'czy', 'wiesz', 'do', 'you', 'know', 'on', 'ona', 'mewka',
  'mewko', 'hej', 'czesc', 'nasz', 'nasza', 'naszego', 'our', 'my', 'moj', 'moja', 'locate', 'w', 'na', 'z', 'jak', 'to', 'ten', 'ta',
  'ktory', 'ktora', 'who', 'what', 'of', 'in', 'at', 'ze', 'dzis', 'dzisiaj', 'today', 'ship', 'statku', 'pokladzie', 'board', 'jesli',
  'if', 'and', 'about', 'lub', 'albo', 'or', 'zalogi', 'crew', 'member', 'czlonek', 'osoba', 'person', 'someone', 'ktos']);

// ---------------------------------------------------------------- features + intent

export interface Features {
  n: string;
  kinds: Kind[];
  zone?: ZoneId;
  stair?: Stair;
  blockWord: boolean;
  route: boolean; muster: boolean; where: boolean; who: boolean; signal: boolean; freq: boolean; roles: boolean;
  alerts: boolean; summary: boolean; equip: boolean;
  greet: boolean; greetOnly: boolean; thanks: boolean; help: boolean; voice: boolean; identity: boolean; followup: boolean;
  rank?: string;
  room?: { code: string; label: Txt };
  names: string[];
}

export function features(text: string): Features {
  const n = norm(text);
  const tk = toks(n);
  const scored = KIND_ORDER.map((k) => {
    const lex = KIND_LEX[k];
    let s = countStems(tk, lex.pre);
    for (const re of lex.re) if (re.test(n)) s += 2;
    return [k, s] as const;
  }).filter(([, s]) => s > 0);
  // a "wyciek wody" is flooding, not pollution
  const kinds = scored.sort((a, b) => b[1] - a[1] || KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0])).map(([k]) => k);
  const roomHit = ROOMS.find(([re]) => re.test(n));
  // rank detection on the text without the room phrase ("magazyn bosmański" is a room, not the bosun)
  const nNoRoom = roomHit ? n.replace(roomHit[0], ' ') : n;
  const rankHit = RANKS.find(([re]) => re.test(nNoRoom));
  const where = WHERE_RE.test(n);
  let names: string[] = [];
  if (where && !rankHit) {
    names = toks(nNoRoom).filter((t) => t.length >= 3 && !NOT_NAME.has(t) && !/^\d+$/.test(t)).slice(0, 3);
  }
  const greet = GREET_START_RE.test(n) || GREET_RE.test(n);
  return {
    n,
    kinds,
    zone: findZone(n),
    stair: stairMention(n),
    blockWord: BLOCK_RE.test(n),
    route: ROUTE_RE.test(n),
    muster: MUSTER_RE.test(n),
    where,
    who: WHO_RE.test(n),
    signal: SIGNAL_RE.test(n),
    freq: FREQ_RE.test(n),
    roles: ROLES_RE.test(n),
    alerts: ALERTS_RE.test(n),
    summary: SUMMARY_RE.test(n),
    equip: EQUIP_RE.test(n),
    greet,
    greetOnly: GREET_RE.test(n),
    thanks: THANKS_RE.test(n),
    help: HELP_RE.test(n),
    voice: VOICE_RE.test(n),
    identity: IDENTITY_RE.test(n),
    followup: FOLLOW_RE.test(n) || tk.length <= 4,
    rank: rankHit?.[1],
    room: roomHit ? { code: roomHit[1], label: roomHit[2] } : undefined,
    names,
  };
}

/** blocked stairwell: an explicit "schody rufowe zablokowane", or a fire with aft / forward wording (as the fire drill) */
function blockedFrom(f: Features, kind?: Kind): Stair | undefined {
  if (f.stair && (f.blockWord || kind === 'fire')) return f.stair;
  if (kind === 'fire') {
    if (/ (ruf\w*|aft|stern) /.test(f.n)) return 'stair-aft';
    if (/ (dziob\w*|forward|fwd|bow) /.test(f.n)) return 'stair-fwd';
  }
  return undefined;
}

const roomsOfZone = (zone: ZoneId) => Object.entries(CREW_ROOM_PLACES).filter(([, p]) => p.zone === zone).map(([code]) => code);

/** One intent from the features of a single question (no history). */
export function decide(f: Features): Intent {
  const kind = f.kinds[0];
  const nothingElse = !kind && !f.zone && !f.rank && !f.room && !f.route && !f.muster && !f.alerts && !f.summary && !f.signal;
  if (f.identity) return { type: 'identity' };
  if (f.voice && (f.help || / (jak|how|czy|can|mozna) /.test(f.n)) && !kind) return { type: 'voice' };
  if (f.help && nothingElse) return { type: 'help' };
  if (f.where && f.equip && !f.rank) return { type: 'equipment', kind };
  if (f.alerts && (!kind || f.who) && !f.freq && !f.roles) return { type: 'crew-alerts' };
  if (f.summary && !f.room && !f.zone) return { type: 'crew-summary' };
  if (f.where && f.rank && !kind) return { type: 'crew-where', query: f.rank, rank: true };
  if (f.who && !f.roles && (f.room || f.zone) && !kind) {
    if (f.room) return { type: 'crew-room', rooms: [f.room.code], roomLabel: f.room.label.pl + '|' + f.room.label.en };
    const rooms = roomsOfZone(f.zone!);
    if (rooms.length) return { type: 'crew-room', rooms, zone: f.zone };
  }
  if (f.who && /( na (pokladzie|statku)| on board| aboard)/.test(f.n) && !kind && !f.zone) return { type: 'crew-summary' };
  if (f.signal && (kind || / alarm\w* /.test(f.n))) return { type: 'signal', kind: kind ?? 'general' };
  if (f.freq && (kind || / cwicz\w* | drills? /.test(f.n))) return { type: 'frequency', kind: kind ?? 'general' };
  if (f.roles && kind) return { type: 'roles', kind };
  if (kind) return { type: 'emergency', kind, zone: f.zone, blocked: blockedFrom(f, kind) };
  if (f.zone && (f.route || f.where || f.blockWord || f.followup)) return { type: 'route', zone: f.zone, blocked: blockedFrom(f) };
  if (f.muster || (f.route && !f.zone)) return { type: 'muster' };
  if (f.where && f.names.length) return { type: 'crew-where', query: f.names.join(' '), rank: false };
  if (f.zone) return { type: 'route', zone: f.zone, blocked: blockedFrom(f) };
  if (f.thanks) return { type: 'thanks' };
  if (f.greet) return { type: 'greeting' };
  if (f.help) return { type: 'help' };
  return { type: 'fallback' };
}

/** Intent of the last user turn, using the earlier user turns for follow-ups. */
export function resolve(userTexts: string[]): Intent {
  let ctx: Intent | null = null;
  let out: Intent = { type: 'fallback' };
  for (const text of userTexts) {
    const f = features(text);
    let it = decide(f);
    if (ctx) it = followUp(it, f, ctx);
    out = it;
    if (!['fallback', 'greeting', 'thanks', 'help', 'voice', 'identity'].includes(it.type)) ctx = it;
  }
  return out;
}

function followUp(it: Intent, f: Features, ctx: Intent): Intent {
  const scenario = ctx.type === 'emergency' || ctx.type === 'route';
  const weak = it.type === 'fallback' || it.type === 'muster' || it.type === 'greeting' || it.type === 'thanks';
  // "a jeśli schody rufowe są zablokowane?" -> same drill / zone, the new stairwell blocked
  if (scenario && f.stair && !f.zone && !f.kinds.length && (weak || it.type === 'route')) {
    const zone = ctx.zone;
    if (zone) return { ...ctx, blocked: f.stair };
  }
  // "a z restauracji?" -> same scenario from another zone
  if (scenario && f.followup && f.zone && !f.kinds.length && (weak || it.type === 'route')) {
    const blocked = f.stair ? f.stair : ctx.type === 'emergency' ? blockedFrom(f, ctx.kind) : blockedFrom(f);
    return ctx.type === 'emergency'
      ? { type: 'emergency', kind: ctx.kind, zone: f.zone, blocked }
      : { type: 'route', zone: f.zone, blocked };
  }
  // "a jeśli to przeciek?" -> new drill, same zone
  if (scenario && f.followup && it.type === 'emergency' && !it.zone && ctx.zone) {
    return { ...it, zone: ctx.zone, blocked: it.blocked ?? (it.kind === 'fire' ? ctx.blocked : undefined) };
  }
  // "a jak brzmi jego sygnał?" / "a jak często?" -> same drill
  if (ctx.kind && f.followup && !f.kinds.length) {
    if (f.signal) return { type: 'signal', kind: ctx.kind };
    if (f.freq) return { type: 'frequency', kind: ctx.kind };
    if (f.roles) return { type: 'roles', kind: ctx.kind };
  }
  // "a starszy mechanik?" -> another person
  if (ctx.type === 'crew-where' && f.followup && f.rank && (weak || it.type === 'crew-where')) return { type: 'crew-where', query: f.rank, rank: true };
  if (ctx.type === 'crew-where' && f.followup && weak && !f.kinds.length) {
    const names = toks(f.n).filter((t) => t.length >= 3 && !NOT_NAME.has(t)).slice(0, 3);
    if (names.length) return { type: 'crew-where', query: names.join(' '), rank: false };
  }
  // "a w kuchni?" -> who is in another room
  if (ctx.type === 'crew-room' && f.followup && (f.room || f.zone) && (weak || it.type === 'route')) {
    if (f.room) return { type: 'crew-room', rooms: [f.room.code], roomLabel: f.room.label.pl + '|' + f.room.label.en };
    const rooms = roomsOfZone(f.zone!);
    if (rooms.length) return { type: 'crew-room', rooms, zone: f.zone };
  }
  return it;
}

// ---------------------------------------------------------------- answers

const NUM: Record<L2, string[]> = {
  pl: ['Jeden', 'Dwa', 'Trzy', 'Cztery', 'Pięć'],
  en: ['One', 'Two', 'Three', 'Four', 'Five'],
};
const KIND_NAME: Record<Kind, Txt> = {
  fire: { pl: 'Pożar', en: 'Fire' },
  abandon: { pl: 'Opuszczenie statku', en: 'Abandon ship' },
  mob: { pl: 'Człowiek za burtą', en: 'Man overboard' },
  flooding: { pl: 'Przeciek / wejście wody', en: 'Flooding / leak' },
  pollution: { pl: 'Rozlew olejowy', en: 'Oil spill' },
  blackout: { pl: 'Zanik zasilania', en: 'Blackout' },
  medical: { pl: 'Nagły wypadek medyczny', en: 'Medical emergency' },
  general: { pl: 'Alarm ogólny', en: 'General alarm' },
};
const drillOf = (k: Kind): DrillId => (k === 'general' ? 'abandon' : k);
const ORDERS: Txt = {
  pl: 'Obowiązują polecenia kapitana i Muster List (rozkład alarmowy) statku; to materiał szkoleniowy.',
  en: "The master's orders and the ship's Muster List apply; this is training material.",
};

/** immediate actions: the drill's alarm + first-action items, without the bridge's own lines, at most 5 */
function immediate(k: Kind, l: L2): string[] {
  const d = DRILL_BY_ID[drillOf(k)];
  const pool = [...d.phases.find((p) => p.id === 'alarm')!.items, ...d.phases.find((p) => p.id === 'first')!.items];
  const own = pool.filter((t) => !/^(Mostek|Bridge)\b/.test(t.pl) && !/^Mostek|^Bridge/.test(t.en));
  if (k === 'general') {
    return [
      { pl: 'Alarm ogólny to wezwanie na stanowiska zbiórki, nie rozkaz opuszczenia statku', en: 'The general alarm calls everyone to muster; it is not the order to abandon ship' },
      ...own,
    ].slice(0, 5).map((t) => tr(l, t));
  }
  return own.slice(0, 5).map((t) => tr(l, t));
}

const numbered = (items: string[], l: L2) => items.map((s, i) => `${NUM[l][i] ?? i + 1}. ${stop(s)}`).join(' ');

const marker = (zone?: ZoneId, blocked?: Stair) => (zone ? `[[ROUTE:${zone}${blocked ? ':' + blocked : ''}]]` : '');

function routeShort(zone: ZoneId, blocked: Stair | undefined, l: L2): string {
  const r = route(zone, blocked ?? null);
  const z = ZONE[zone];
  const letter = r.muster === 'muster-a' ? 'A' : 'B';
  const via = r.stair === null
    ? (l === 'pl' ? 'schodami mostka na pokład 5' : 'by the bridge stairs to deck 5')
    : (l === 'pl' ? (r.stair === 'stair-fwd' ? 'schodami dziobowymi' : 'schodami rufowymi') : (r.stair === 'stair-fwd' ? 'by the forward stairwell' : 'by the aft stairwell'));
  const det = r.detour && blocked
    ? (l === 'pl' ? `, omijając zablokowane ${blocked === 'stair-aft' ? 'schody rufowe' : 'schody dziobowe'},` : `, avoiding the blocked ${blocked === 'stair-aft' ? 'aft' : 'forward'} stairwell,`)
    : '';
  return l === 'pl'
    ? `Droga ewakuacji z miejsca: ${z.name.pl.toLowerCase()}, ${z.deck.pl.toLowerCase()}, prowadzi ${via}${det} do punktu zbiórki ${letter}, około ${fmtTime(r.seconds)}. Przycisk niżej pokaże ją na modelu.`
    : `The evacuation route from the ${z.name.en.toLowerCase()}, ${z.deck.en.toLowerCase()}, goes ${via}${det} to muster station ${letter}, about ${fmtTime(r.seconds)}. The button below shows it on the model.`;
}

function routeLong(zone: ZoneId, blocked: Stair | undefined, l: L2): string[] {
  const r = route(zone, blocked ?? null);
  const z = ZONE[zone];
  const steps = r.steps.map((s) => stop(tr(l, s)));
  const head = l === 'pl'
    ? `Droga ewakuacji: ${z.name.pl}, ${z.deck.pl.toLowerCase()}.`
    : `Evacuation route: ${z.name.en}, ${z.deck.en.toLowerCase()}.`;
  const half = Math.ceil(steps.length / 2);
  const tail = l === 'pl'
    ? `Razem około ${Math.round(r.distance)} m, ${fmtTime(r.seconds)} marszu. To trasa szkoleniowa na modelu; obowiązuje Muster List statku.`
    : `About ${Math.round(r.distance)} m in total, ${fmtTime(r.seconds)} on foot. This is a training route on the model; the ship's Muster List applies.`;
  const blockedNote = blocked && !r.detour && (zone === 'bridge' || (zone.startsWith('engine') && blocked === 'stair-fwd'))
    ? (l === 'pl' ? ' Ta trasa i tak nie prowadzi przez zablokowaną klatkę.' : ' This route does not use the blocked stairwell anyway.')
    : '';
  return [`${head} ${steps.slice(0, half).join(' ')}`, steps.slice(half).join(' '), tail + blockedNote];
}

function emergencyText(it: Intent, l: L2): string[] {
  const k = it.kind!;
  const d = DRILL_BY_ID[drillOf(k)];
  const intro = l === 'pl' ? `${KIND_NAME[k].pl}: działania natychmiastowe.` : `${KIND_NAME[k].en}: immediate actions.`;
  const items = immediate(k, l);
  // 1-4 sentences per paragraph: the first three steps, then the rest
  const out = [`${intro} ${numbered(items.slice(0, 3), l)}`];
  if (items.length > 3) out.push(numbered(items, l).split(/ (?=(?:Cztery|Four)\. )/)[1] ?? '');
  out.push(`${l === 'pl' ? 'Sygnał' : 'Signal'}: ${stop(tr(l, d.signal))} ${ORDERS[l]}`);
  if (it.zone) out.push(routeShort(it.zone, it.blocked, l));
  out.push(`${marker(it.zone, it.blocked)} [[DRILL:${d.id}]]`);
  return out;
}

function signalText(it: Intent, l: L2): string[] {
  const k = it.kind!;
  const d = DRILL_BY_ID[drillOf(k)];
  const out = [`${l === 'pl' ? 'Sygnał' : 'Signal'} (${tr(l, KIND_NAME[k]).toLowerCase()}): ${stop(tr(l, d.signal))}`];
  if (k === 'general' || k === 'abandon') {
    out.push(l === 'pl'
      ? 'Alarm ogólny oznacza zbiórkę: załoga idzie na stanowiska wg Muster List, pasażerowie do miejsc zbiórki. Opuszczenie statku zarządza wyłącznie kapitan, ustnie.'
      : 'The general alarm means muster: crew go to their Muster List stations, passengers to the muster stations. Only the master orders abandon ship, verbally.');
  } else {
    out.push(l === 'pl' ? 'Dokładny sygnał statku jest w Rozkładzie alarmowym (Muster List).' : "The ship's exact signal is in the Muster List.");
  }
  out.push(`[[DRILL:${d.id}]]`);
  return out;
}

function frequencyText(it: Intent, l: L2): string[] {
  const k = it.kind!;
  const d = DRILL_BY_ID[drillOf(k)];
  const head = k === 'general'
    ? (l === 'pl' ? 'Ćwiczenia opuszczenia statku i pożarowe' : 'Abandon ship and fire drills')
    : (l === 'pl' ? `Ćwiczenie: ${KIND_NAME[k].pl.toLowerCase()}` : `Drill: ${KIND_NAME[k].en.toLowerCase()}`);
  return [`${head}. ${stop(tr(l, d.frequency))}`, l === 'pl' ? 'Plan ćwiczeń statku jest w SMS.' : "The ship's drill plan is in the SMS.", `[[DRILL:${d.id}]]`];
}

function rolesText(it: Intent, l: L2): string[] {
  const d = DRILL_BY_ID[drillOf(it.kind!)];
  const roles = d.roles.slice(0, 4).map((r) => `${tr(l, r.name)}: ${stop(tr(l, r.task))}`);
  return [
    `${l === 'pl' ? 'Role' : 'Roles'} (${tr(l, KIND_NAME[it.kind!]).toLowerCase()}). ${roles.slice(0, 2).join(' ')}`,
    roles.slice(2).join(' '),
    l === 'pl' ? 'Twój przydział jest w Muster List i na karcie alarmowej.' : 'Your own assignment is in the Muster List and on your muster card.',
    `[[DRILL:${d.id}]]`,
  ].filter(Boolean);
}

const MUSTER_TEXT: Record<L2, string[]> = {
  pl: [
    'Punkty zbiórki w modelu są na pokładzie 5 (szalupowym), przy łodziach ratunkowych. A: część rufowa, B: część dziobowa.',
    'Z kabin i salonów idziesz najbliższą klatką schodową w górę; gdy jedna klatka jest zablokowana, drugą. Twoje stanowisko jest w Muster List.',
    'Powiedz, skąd idziesz (na przykład maszynownia, kabiny na rufie, restauracja), a pokażę trasę.',
  ],
  en: [
    'In the model the muster stations are on deck 5 (boat deck), by the lifeboats. A: aft part, B: forward part.',
    'From cabins and lounges take the nearest stairwell up; if one is blocked, use the other. Your own station is in the Muster List.',
    'Tell me where you start (for example engine room, aft cabins, restaurant) and I will show the route.',
  ],
};

// ---------------------------------------------------------------- crew answers

function ago(min: number | null | undefined, l: L2): string {
  if (min == null) return '';
  if (min < 1) return l === 'pl' ? 'przed chwilą' : 'just now';
  if (min < 60) return l === 'pl' ? `${min} min temu` : `${min} min ago`;
  const h = Math.floor(min / 60), m = min % 60;
  return l === 'pl' ? `${h} godz.${m ? ` ${m} min` : ''} temu` : `${h} h${m ? ` ${m} min` : ''} ago`;
}
const hoursAgo = (h: number, l: L2) => ago(Math.round(h * 60), l);
/** Polish noun form for a count: 1 osoba, 2-4 osoby (not 12-14), 5+ osób */
function osob(n: number, one = 'osoba'): string {
  if (n === 1) return one;
  return n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'osoby' : 'osób';
}

/** crew database down / off, or (browser) the crew proxy wants a login */
function crewFail(e: unknown, l: L2): string[] {
  if (e instanceof CrewError && e.kind === 'auth') {
    return [l === 'pl' ? 'Zaloguj się, żeby zobaczyć dane załogi.' : 'Log in to see crew data.'];
  }
  return [
    l === 'pl'
      ? 'Baza załogi jest teraz niedostępna, więc nie powiem, kto gdzie jest. Zapytaj mostek albo oficera wachtowego.'
      : 'The crew database is unavailable right now, so I cannot tell who is where. Ask the bridge or the officer on watch.',
    CONTACT_MARK,
  ];
}

/** "Kapitan" -> "kapitan", but "III oficer" and "Marynarz AB" keep their capitals where they matter */
const rankLc = (r: unknown) => String(r ?? '').split(' ').map((w) => (/^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]/.test(w) ? w.toLowerCase() : w)).join(' ');
const nameStem = (w: string) => (w.length > 5 ? w.slice(0, Math.max(4, w.length - 3)) : w);

async function crewWhere(it: Intent, l: L2, crewSrc: CrewSource): Promise<string[]> {
  const q = it.query!;
  let found = await crewSrc.find(q);
  if (!found.total && !it.rank) { // inflected names ("Melnyka", "Kozłowskiego"): retry with stems
    const stems = q.split(' ').map(nameStem).join(' ');
    if (stems !== q) found = await crewSrc.find(stems);
  }
  let crew: CrewPerson[] = found.crew;
  if (it.rank) { // prefer people whose rank matches (the search also hits room names, e.g. "Biuro kapitana")
    const byRank = crew.filter((c) => norm(c.rank).includes(` ${q} `));
    if (byRank.length) crew = byRank;
  }
  if (!crew.length) {
    if (it.rank) {
      return [l === 'pl' ? `Nie znalazłam w bazie załogi nikogo ze stopniem: ${q}.` : `I found no one with the rank "${q}" in the crew database.`];
    }
    return [l === 'pl'
      ? `Nie znalazłam w bazie załogi osoby: ${q}, i nie znam takiego miejsca w trybie lokalnym. Podaj imię i nazwisko albo stopień, albo zapytaj oficera wachtowego.`
      : `I found no one called "${q}" in the crew database and I do not know such a place in local mode. Give a name or rank, or ask the officer on watch.`,
    CONTACT_MARK];
  }
  const line = (c: CrewPerson) => {
    if (!c.room) {
      return l === 'pl' ? `${c.name}, ${rankLc(c.rank)}, nie ma teraz check-inu na statku (poza statkiem albo nie odbił karty).`
        : `${c.name}, ${rankLc(c.rank)}, has no current check-in on board (ashore, or the card was not tapped).`;
    }
    const when = ago(c.minutesAgo, l);
    const code = c.code ? ` (${c.code})` : '';
    return l === 'pl'
      ? `${c.name}, ${rankLc(c.rank)}, jest w pomieszczeniu ${c.room}${code}${when ? `, ostatni check-in ${when}` : ''}.`
      : `${c.name}, ${rankLc(c.rank)}, is in ${c.room}${code}${when ? `, last check-in ${when}` : ''}.`;
  };
  const total = it.rank ? crew.length : Math.max(found.total, crew.length);
  const shown = crew.slice(0, 4);
  const out: string[] = [];
  if (shown.length === 1) out.push((l === 'pl' ? 'Z bazy załogi: ' : 'From the crew database: ') + line(shown[0]));
  else {
    out.push((l === 'pl' ? `Znalazłam ${total} ${osob(total, 'osobę')}. ` : `I found ${total} people. `) + shown.map(line).join(' ')
      + (total > shown.length ? (l === 'pl' ? ` I jeszcze ${total - shown.length}; zawęź pytanie.` : ` And ${total - shown.length} more; narrow the question.`) : ''));
  }
  out.push(l === 'pl' ? 'Miejsce to pomieszczenie ostatniego odbicia karty w terminalu.' : 'The place is the room of the last card tap at a terminal.');
  const zones = new Set(shown.map((c) => c.zone ?? null));
  const z = shown[0].zone;
  if (zones.size === 1 && z && z !== 'boat-deck') out.push(`[[ROUTE:${z}]]`); // one place: show it on the model
  return out;
}

async function crewRoom(it: Intent, l: L2, crewSrc: CrewSource): Promise<string[]> {
  const found = (await Promise.all(it.rooms!.map((code) => crewSrc.room(code)))).filter((r) => r !== null);
  if (!found.length) return [l === 'pl' ? 'Nie znalazłam tego pomieszczenia w bazie załogi.' : 'I could not find that room in the crew database.'];
  const people = found.flatMap((r) => r.people.map((c) => ({ ...c, room: c.room ?? r.name })));
  const where = it.roomLabel
    ? (l === 'pl' ? it.roomLabel.split('|')[0] : it.roomLabel.split('|')[1])
    : (l === 'pl' ? `w strefie „${ZONE[it.zone!].name.pl}”` : `in the zone "${ZONE[it.zone!].name.en}"`);
  const out: string[] = [];
  if (!people.length) {
    out.push(l === 'pl' ? `${cap(where)} nie ma teraz nikogo według check-inów.` : `${cap(where)}: no one is checked in right now.`);
  } else {
    const multi = found.length > 1;
    const list = people.slice(0, 6).map((c) => `${c.name} (${rankLc(c.rank)}${multi ? `, ${c.room}` : ''}${c.minutesAgo != null ? `, ${ago(c.minutesAgo, l)}` : ''})`);
    const more = people.length > 6 ? (l === 'pl' ? `, i jeszcze ${people.length - 6}` : `, and ${people.length - 6} more`) : '';
    out.push(l === 'pl'
      ? `${cap(where)} ${osob(people.length) === 'osoby' ? 'są' : 'jest'} teraz ${people.length} ${osob(people.length)}: ${list.join(', ')}${more}.`
      : `${cap(where)} there ${people.length === 1 ? 'is 1 person' : `are ${people.length} people`} now: ${list.join(', ')}${more}.`);
  }
  if (found.length === 1) {
    const one = found[0];
    const notes: string[] = [];
    if (one.minStaff) notes.push(l === 'pl' ? `Minimalna obsada: ${one.minStaff}${one.staffHours ? ` (godz. ${one.staffHours})` : ''}.` : `Minimum staffing: ${one.minStaff}${one.staffHours ? ` (hours ${one.staffHours})` : ''}.`);
    if (one.hazardous && people.length === 1) notes.push(l === 'pl' ? 'To pomieszczenie niebezpieczne, a ktoś pracuje sam: sprawdź łączność.' : 'This is a hazardous room and someone works alone: check in with them.');
    if (notes.length) out.push(notes.join(' '));
  }
  const z = it.zone ?? found.map((r) => r.zone).find((x) => x && x !== 'boat-deck');
  if (z) out.push(`[[ROUTE:${z}]]`);
  return out;
}

const ZONE_LABEL = (z: string, l: L2) => (z in ZONE ? tr(l, ZONE[z as ZoneId].name) : z === 'boat-deck' ? (l === 'pl' ? 'pokład szalupowy' : 'boat deck') : (l === 'pl' ? 'poza mapą' : 'unmapped'));

async function crewSummary(l: L2, crewSrc: CrewSource): Promise<string[]> {
  const s = await crewSrc.summary();
  const zones = Object.entries(s.byZone).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const last = ago(s.lastMinutesAgo, l);
  const out = [l === 'pl'
    ? `W bazie załogi ${osob(s.crew) === 'osoby' ? 'są' : 'jest'} ${s.crew} ${osob(s.crew)}: ${s.onboard} na statku, ${s.ashore} na lądzie.${last ? ` Ostatni check-in ${last}.` : ''}`
    : `The crew database lists ${s.crew} people: ${s.onboard} on board, ${s.ashore} ashore.${last ? ` Last check-in ${last}.` : ''}`];
  if (zones.length) out.push((l === 'pl' ? 'Najwięcej osób teraz: ' : 'Most people right now: ') + zones.map(([z, n]) => `${ZONE_LABEL(z, l).toLowerCase()} ${n}`).join(', ') + '.');
  return out;
}

async function crewAlerts(l: L2, crewSrc: CrewSource): Promise<string[]> {
  const { lone, under, stale } = await crewSrc.alerts();
  if (!lone.length && !under.length && !stale.length) {
    return [l === 'pl'
      ? 'Brak alertów: obsada pomieszczeń jest w normie, nikt nie pracuje sam w pomieszczeniu niebezpiecznym, check-iny są aktualne.'
      : 'No alerts: room staffing is fine, no one works alone in a hazardous room, check-ins are current.'];
  }
  const st = (s: string) => (s === 'critical' ? (l === 'pl' ? 'krytyczne' : 'critical') : (l === 'pl' ? 'ostrzeżenie' : 'warning'));
  const out: string[] = [];
  if (!lone.length) out.push(l === 'pl' ? 'Nikt nie pracuje teraz sam w pomieszczeniu niebezpiecznym.' : 'No one is working alone in a hazardous room right now.');
  if (lone.length) out.push((l === 'pl' ? 'Praca w pojedynkę: ' : 'Lone workers: ') + lone.slice(0, 3).map((x) => l === 'pl'
    ? `${x.person ?? 'ktoś'} sam w: ${x.room}, od ${x.minutes} min (${st(x.status)})`
    : `${x.person ?? 'someone'} alone in ${x.room} for ${x.minutes} min (${st(x.status)})`).join('; ') + '.');
  if (under.length) out.push((l === 'pl' ? 'Za mała obsada: ' : 'Understaffed: ') + under.slice(0, 3).map((x) => l === 'pl'
    ? `${x.room} ${x.people} z wymaganych ${x.min}`
    : `${x.room} ${x.people} of the required ${x.min}`).join('; ') + '.');
  if (stale.length) out.push((l === 'pl' ? 'Dawno bez check-inu: ' : 'Overdue check-ins: ') + stale.slice(0, 3).map((x) => l === 'pl'
    ? `${x.name} (${rankLc(x.rank)}), ostatnio ${x.room ?? 'brak'} ${hoursAgo(x.hours, l)}`
    : `${x.name} (${rankLc(x.rank)}), last seen in ${x.room ?? 'unknown'} ${hoursAgo(x.hours, l)}`).join('; ') + '.');
  out.push(l === 'pl' ? 'Sprawdź te osoby przez radio albo zgłoś na mostek.' : 'Check on them by radio or report to the bridge.');
  const z = [...lone, ...under].map((x) => x.zone).find((x) => x && x !== 'boat-deck');
  if (z) out.push(`[[ROUTE:${z}]]`);
  return out;
}

// ---------------------------------------------------------------- small talk + fallback

const SUGGEST: Record<L2, string[]> = {
  pl: ['Co robić przy pożarze w kabinach na rufie?', 'Pokaż drogę ewakuacji z maszynowni', 'Jaki jest sygnał alarmu ogólnego?', 'Gdzie jest kapitan?'],
  en: ['What to do in a fire in the aft cabins?', 'Show the evacuation route from the engine room', 'What is the general alarm signal?', 'Where is the captain?'],
};
const suggest = (l: L2, n = 3) => (l === 'pl' ? 'Możesz zapytać na przykład: ' : 'You can ask for example: ') + SUGGEST[l].slice(0, n).map((s) => `„${s}”`).join(', ') + '.';

function small(type: IntentType, l: L2, it: Intent): string[] {
  const pl = l === 'pl';
  switch (type) {
    case 'greeting': return [pl
      ? 'Cześć, tu Mewka, asystentka szkoleniowa załogi MF Jantar Unity. Pomogę z procedurami awaryjnymi, drogami ewakuacji, ćwiczeniami i bazą załogi.'
      : 'Hi, this is Mewka, the training assistant for the crew of MF Jantar Unity. I can help with emergency procedures, evacuation routes, drills and the crew database.', suggest(l)];
    case 'thanks': return [pl ? 'Proszę bardzo. Spokojnej wachty.' : "You're welcome. Have a quiet watch."];
    case 'identity': return [pl
      ? 'Jestem Mewka, program komputerowy, nie człowiek. Teraz działam w trybie lokalnym: odpowiadam z kart ćwiczeń, tras ewakuacji i bazy załogi, bez modelu językowego.'
      : 'I am Mewka, a computer program, not a person. Right now I run in local mode: I answer from the drill cards, evacuation routes and crew database, without a language model.'];
    case 'help': return [
      pl ? 'W trybie lokalnym potrafię: podać pierwsze działania i sygnał dla pożaru, opuszczenia statku, człowieka za burtą, przecieku, rozlewu oleju, blackoutu i wypadku medycznego; pokazać drogę ewakuacji z każdej strefy, także przy zablokowanej klatce; powiedzieć z bazy załogi, kto gdzie jest i jakie są alerty.'
        : 'In local mode I can: give the first actions and the signal for fire, abandon ship, man overboard, flooding, oil spill, blackout and medical emergencies; show the evacuation route from every zone, also with a blocked stairwell; tell from the crew database who is where and what the alerts are.',
      suggest(l, 4)];
    case 'voice': return [
      pl ? 'Naciśnij przycisk mikrofonu przy polu pytania i powiedz pytanie, na przykład: gdzie jest bosman. Odpowiedź przeczytam na głos, a potem znów słucham.'
        : 'Press the microphone button next to the question box and say your question, for example: where is the bosun. I read the answer aloud and then listen again.',
      pl ? 'Mikrofon działa w Chrome, Edge i Safari. Alt+Shift+M włącza i wyłącza mikrofon, Escape zatrzymuje czytanie.'
        : 'The microphone works in Chrome, Edge and Safari. Alt+Shift+M turns it on and off, Escape stops reading.'];
    case 'equipment': return [
      pl ? 'Nie mam w trybie lokalnym planu rozmieszczenia sprzętu. Sprawdź plan ochrony przeciwpożarowej i plan ratunkowy statku albo zapytaj oficera wachtowego.'
        : 'In local mode I do not have the equipment layout. Check the ship\'s fire control plan and safety plan or ask the officer on watch.',
      it.kind ? `[[DRILL:${drillOf(it.kind)}]] [[KONTAKT]]` : '[[KONTAKT]]'];
    default: return [
      pl ? 'Nie znam odpowiedzi w trybie lokalnym. Zapytaj oficera wachtowego albo sprawdź dokumenty statku.'
        : 'I do not know the answer in local mode. Ask the officer on watch or check the ship\'s documents.',
      suggest(l), '[[KONTAKT]]'];
  }
}

// ---------------------------------------------------------------- public

const SOURCE: Record<'drill' | 'route' | 'crew' | 'none', { pl: string; en: string; href: string }> = {
  drill: { pl: 'Tryb lokalny: karty ćwiczeń', en: 'Local mode: drill cards', href: '#cwiczenia' },
  route: { pl: 'Tryb lokalny: trasy ewakuacji', en: 'Local mode: evacuation routes', href: '#ewakuacja' },
  crew: { pl: 'Tryb lokalny: baza załogi', en: 'Local mode: crew database', href: '#statek' },
  none: { pl: 'Tryb lokalny', en: 'Local mode', href: '#asystent' },
};
function sourceFor(type: IntentType, l: L2): Source {
  const k = ['emergency', 'signal', 'frequency', 'roles'].includes(type) ? 'drill'
    : ['route', 'muster'].includes(type) ? 'route'
    : type.startsWith('crew') ? 'crew' : 'none';
  return { label: SOURCE[k][l], href: SOURCE[k].href };
}

/** Answer of the local engine: the /api/chat shape plus engine: "local". */
export interface LocalAnswer {
  text: string[];
  sources: Source[];
  fallback: boolean;
  actions: Action[];
  engine: 'local';
  /** what the engine understood (tests, debugging) */
  intent: Intent;
  lang: L2;
}

/** Raw answer text with markers (paragraphs separated by blank lines), the intent and the language. */
export async function compose(lang: Lang, turns: Turn[], crewSrc: CrewSource): Promise<{ raw: string; intent: Intent; lang: L2 }> {
  const users = turns.filter((t) => t.role === 'user').map((t) => t.content);
  const last = users[users.length - 1] ?? '';
  const l = detectLang(last, lang);
  const it = resolve(users.slice(-8));
  let paras: string[];
  try {
    switch (it.type) {
      case 'emergency': paras = emergencyText(it, l); break;
      case 'signal': paras = signalText(it, l); break;
      case 'frequency': paras = frequencyText(it, l); break;
      case 'roles': paras = rolesText(it, l); break;
      case 'route': paras = [...routeLong(it.zone!, it.blocked, l), marker(it.zone, it.blocked)]; break;
      case 'muster': paras = MUSTER_TEXT[l]; break;
      case 'crew-where': paras = await crewWhere(it, l, crewSrc); break;
      case 'crew-room': paras = await crewRoom(it, l, crewSrc); break;
      case 'crew-summary': paras = await crewSummary(l, crewSrc); break;
      case 'crew-alerts': paras = await crewAlerts(l, crewSrc); break;
      default: paras = small(it.type, l, it);
    }
  } catch (e) {
    if (!it.type.startsWith('crew')) throw e;
    paras = crewFail(e, l);
  }
  return { raw: paras.filter((p) => p.trim()).join('\n\n'), intent: it, lang: l };
}

/** Answer the last user turn of `turns` (earlier turns give the follow-up context). Never throws for crew failures. */
export async function answerLocal(lang: Lang, turns: Turn[], crewSrc: CrewSource): Promise<LocalAnswer> {
  const { raw, intent, lang: l } = await compose(lang, turns, crewSrc);
  const userText = [...turns].reverse().find((t) => t.role === 'user')?.content ?? '';
  const contact = raw.includes(CONTACT_MARK);
  const parsed = parseActions(raw, l, userText);
  const text = parsed.text.trim().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { text, sources: [sourceFor(intent.type, l)], fallback: contact || !text.length, actions: parsed.actions, engine: 'local', intent, lang: l };
}

/** Deltas for a streaming UI: the answer's paragraphs, joined by blank lines (what an SSE `delta` stream would carry). */
export function answerDeltas(a: { text: string[] }): string[] {
  return a.text.map((p, i) => (i ? '\n\n' + p : p));
}
