// Local Mewka engine (src/local/**): intents, answers, markers, follow-ups, crew sources, the browser adapter in local
// mode, and the server with ASSISTANT_ENGINE=local / auto. No API key, no network (fake crew servers on random ports).
// Run from assistant/:  npm test   (or: node --experimental-strip-types --test tests/local.test.ts)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSSE } from './sse.ts';
import { answerLocal, answerDeltas, detectLang, features, decide, resolve, type LocalAnswer } from '../src/local/engine.ts';
import { parseActions as localParse } from '../src/local/actions.ts';
import { CrewError, httpCrewSource, matchCrew, type CrewPerson, type CrewSource } from '../src/local/crew.ts';
import { fold, lev, stemMatch } from '../src/local/text.ts';
import { askStream as adapterAskStream, ask as adapterAsk, MODE } from '../src/adapter.ts';
import type { Turn } from '../src/types.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- fake upstream crew database, started before anything imports server/crew.ts (it reads CREW_API once) ----------
const T = new Date(Date.now() - 7 * 60_000).toISOString();
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}
/** fake upstream crew database (the shape of the teammates' crew server, as in tests/crew.test.ts) */
function fakeCrewDb(): Server {
  const crew = [{ id: 1, badge: 'B-1', first_name: 'Bartosz', last_name: 'Kozłowski', rank: 'Kapitan', department: 'Pokład', room_id: 21, room_code: 'D4-01', room_name: 'Mostek nawigacyjny', since: T, cabin: 'x', phone_ext: '201', nationality: 'PL', birth_date: '1970-01-01' }];
  const rooms = [{ id: 21, code: 'D4-01', name: 'Mostek nawigacyjny', role: 'Nawigacja', deck: 4, people: 1, capacity: 8, occupancy: 12, min_staff: 2, staff_hours: '00-24', hazardous: 0, restricted: 0 }];
  return createServer((req, res) => {
    const json = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url ?? '/', 'http://x').pathname;
    if (u === '/api/crew') return json(200, crew);
    if (u === '/api/rooms') return json(200, rooms);
    if (u === '/api/rooms/21') return json(200, { ...rooms[0], crew });
    if (u === '/api/summary') return json(200, { crew: 1, onboard: 1, ashore: 0, rooms: 1, terminals: 1, checkins24h: 3, lastCheckin: T });
    if (u === '/api/alerts') return json(200, { staffing: [], lone: [], lastCheckin: [], counts: {}, limits: {} });
    json(404, { error: 'Not found' });
  });
}

const DB = fakeCrewDb();
const DB_BASE = await listen(DB);
process.env.CREW_API = DB_BASE;
after(() => new Promise<void>((r) => DB.close(() => r())));

// ---------- in-memory crew source ----------
const P = (name: string, rank: string, room: string | null, code: string | null, zone: string | null, minutesAgo: number | null): CrewPerson =>
  ({ name, rank, room, code, zone, minutesAgo });
const PEOPLE: CrewPerson[] = [
  P('Bartosz Kozłowski', 'Kapitan', 'Mostek nawigacyjny', 'D4-01', 'bridge', 12),
  P('Mark Reyes', 'III oficer', 'Mostek nawigacyjny', 'D4-01', 'bridge', 30),
  P('Natalia Melnyk', 'Bosman', 'Magazyn bosmański', 'D2-08', 'vehicle-d2', 42),
  P('Paweł Piotrowski', 'Starszy mechanik', 'Maszynownia główna', 'D1-01', 'engine-room', 95),
  P('Wołodymyr Melnyk', 'II mechanik', 'Siłownia', 'D3-05', 'reclining-lounge', 5),
  P('Ola Nowak', 'Steward', null, null, null, null),
];
const memCrew = (over: Partial<CrewSource> = {}): CrewSource => ({
  async find(q) { return matchCrew(PEOPLE, q); },
  async room(code) {
    const people = PEOPLE.filter((p) => p.code === code);
    const name = { 'D4-01': 'Mostek nawigacyjny', 'D1-01': 'Maszynownia główna', 'D2-03': 'Kuchnia', 'D3-03': 'Kabiny załogi – blok B' }[code];
    if (!name) return null;
    return { code, name, zone: code === 'D4-01' ? 'bridge' : null, people, minStaff: code === 'D4-01' ? 2 : 0, staffHours: '00-24', hazardous: code === 'D1-01' };
  },
  async summary() { return { crew: 6, onboard: 5, ashore: 1, lastMinutesAgo: 5, byZone: { bridge: 2, 'engine-room': 1 } }; },
  async alerts() {
    return { lone: [{ person: 'Paweł Piotrowski (Starszy mechanik)', room: 'Maszynownia główna', zone: 'engine-room', minutes: 42, status: 'warning' }],
      under: [], stale: [{ name: 'Natalia Melnyk', rank: 'Bosman', room: 'Magazyn bosmański', hours: 9.1 }] };
  },
  ...over,
});
const downCrew = memCrew({
  async find() { throw new CrewError('down'); }, async room() { throw new CrewError('down'); },
  async summary() { throw new CrewError('down'); }, async alerts() { throw new CrewError('down'); },
});
const authCrew = memCrew({ async find() { throw new CrewError('auth'); }, async room() { throw new CrewError('auth'); } });

const conv = (...qs: string[]): Turn[] => qs.flatMap((content, i) =>
  i < qs.length - 1 ? [{ role: 'user' as const, content }, { role: 'assistant' as const, content: 'OK.' }] : [{ role: 'user' as const, content }]);
const ans = (lang: 'pl' | 'en', ...qs: string[]) => answerLocal(lang, conv(...qs), memCrew());
const all = (a: LocalAnswer) => a.text.join('\n');

function shape(a: LocalAnswer) {
  assert.ok(a.text.length > 0);
  for (const p of a.text) { assert.ok(p.trim()); assert.ok(!p.includes('[[') && !p.includes(']]'), 'marker left: ' + p); }
  assert.equal(a.engine, 'local');
  assert.ok(a.sources.length === 1 && /Tryb lokalny|Local mode/.test(a.sources[0].label));
  for (const p of a.text) assert.ok(p.length <= 600, 'paragraph too long: ' + p);
}
const route = (a: LocalAnswer) => a.actions.find((x) => x.type === 'route') as { zone: string; blocked?: string } | undefined;
const drill = (a: LocalAnswer) => (a.actions.find((x) => x.type === 'drill') as { id: string } | undefined)?.id;

// ---------- question table ----------
interface Case { q: string[]; lang?: 'pl' | 'en'; intent: string; kind?: string; drill?: string; zone?: string | null; blocked?: string; has?: RegExp[]; fallback?: boolean; out?: 'pl' | 'en' }
const CASES: Case[] = [
  { q: ['Pożar w kabinach na rufie, co robić?'], intent: 'emergency', kind: 'fire', drill: 'fire', zone: 'cabins-aft', blocked: 'stair-aft', has: [/ostrzegacz/, /Muster List/, /schodami dziobowymi/] },
  { q: ['Ogień i dym w restauracji!'], intent: 'emergency', kind: 'fire', drill: 'fire', zone: 'restaurant', has: [/Zgłoś na mostek/] },
  { q: ['pali się w kabinie 140'], intent: 'emergency', kind: 'fire', zone: 'cabins-mid' },
  { q: ['pozsr w maszynowni'], intent: 'emergency', kind: 'fire', zone: 'engine-room' }, // typo
  { q: ['Człowiek za burtą!'], intent: 'emergency', kind: 'mob', drill: 'mob', zone: null, has: [/koło ratunkowe/, /MOB/] },
  { q: ['Jak przeprowadzić ćwiczenie człowiek za burtą?'], intent: 'emergency', kind: 'mob', drill: 'mob' },
  { q: ['Woda wdziera się do maszynowni, przeciek'], intent: 'emergency', kind: 'flooding', drill: 'flooding', zone: 'engine-room', has: [/drzwi wodoszczelne/] },
  { q: ['Wyciek wody na pokładzie samochodowym 2'], intent: 'emergency', kind: 'flooding', zone: 'vehicle-d2' },
  { q: ['Rozlew oleju przy bunkrowaniu'], intent: 'emergency', kind: 'pollution', drill: 'pollution', has: [/SOPEP/] },
  { q: ['Brak prądu, blackout'], intent: 'emergency', kind: 'blackout', drill: 'blackout', has: [/generatora awaryjnego/] },
  { q: ['Pasażer nieprzytomny w salonie'], intent: 'emergency', kind: 'medical', drill: 'medical', zone: 'lounge', has: [/RKO|AED/] },
  { q: ['zawał serca w kuchni'], intent: 'emergency', kind: 'medical' },
  { q: ['Ogłoszono opuszczenie statku, co robię?'], intent: 'emergency', kind: 'abandon', drill: 'abandon', has: [/Kamizelka/] },
  { q: ['Co robić przy alarmie ogólnym?'], intent: 'emergency', kind: 'general', drill: 'abandon', has: [/nie rozkaz opuszczenia/] },
  { q: ['Jaki jest sygnał alarmu ogólnego?'], intent: 'signal', kind: 'general', drill: 'abandon', has: [/7 krótkich \+ 1 długi/] },
  { q: ['Jak brzmi alarm pożarowy?'], intent: 'signal', kind: 'fire', drill: 'fire', has: [/dzwonków/] },
  { q: ['Jak często ćwiczenia pożarowe?'], intent: 'frequency', kind: 'fire', has: [/co tydzień/] },
  { q: ['Kto co robi przy przecieku?'], intent: 'roles', kind: 'flooding', has: [/Kapitan/] },
  { q: ['Pokaż drogę ewakuacji z maszynowni'], intent: 'route', zone: 'engine-room', has: [/schodów maszynowni/, /punktu zbiórki A/] },
  { q: ['droga ewakuacji z centrali manewrowej'], intent: 'route', zone: 'engine-control' },
  { q: ['Jak dojść do punktu zbiórki z sali foteli lotniczych?'], intent: 'route', zone: 'reclining-lounge' },
  { q: ['Ewakuacja z mostka'], intent: 'route', zone: 'bridge', has: [/Schodami mostka/] },
  { q: ['Droga z kabin dziobowych, schody dziobowe zablokowane'], intent: 'route', zone: 'cabins-fwd', blocked: 'stair-fwd', has: [/schodów rufowych/] },
  { q: ['Gdzie jest punkt zbiórki?'], intent: 'muster', has: [/pokładzie 5/] },
  { q: ['Gdzie jest kapitan?'], intent: 'crew-where', zone: 'bridge', has: [/Bartosz Kozłowski, kapitan/, /Mostek nawigacyjny/, /12 min temu/] },
  { q: ['Gdzie znajdę bosmana?'], intent: 'crew-where', has: [/Natalia Melnyk/] },
  { q: ['Gdzie jest Kozłowski?'], intent: 'crew-where', has: [/Bartosz Kozłowski/] },
  { q: ['Gdzie jest Ola Nowak?'], intent: 'crew-where', zone: null, has: [/nie ma teraz check-inu/] },
  { q: ['Gdzie jest Melnyka?'], intent: 'crew-where', has: [/Znalazłam 2 osoby/] }, // stem retry
  { q: ['Kto jest na mostku?'], intent: 'crew-room', zone: 'bridge', has: [/Na mostku są teraz 2 osoby/, /Minimalna obsada: 2/] },
  { q: ['Kto jest w maszynowni?'], intent: 'crew-room', has: [/W maszynowni jest teraz 1 osoba/, /niebezpieczne/] },
  { q: ['Ile osób jest na pokładzie?'], intent: 'crew-summary', has: [/5 na statku, 1 na lądzie/] },
  { q: ['Czy ktoś pracuje sam?'], intent: 'crew-alerts', zone: 'engine-room', has: [/Praca w pojedynkę: Paweł Piotrowski/, /Natalia Melnyk/] },
  { q: ['Gdzie jest gaśnica?'], intent: 'equipment', fallback: true, has: [/plan ochrony przeciwpożarowej/] },
  { q: ['Co potrafisz?'], intent: 'help', has: [/W trybie lokalnym potrafię/] },
  { q: ['Jak rozmawiać z tobą głosem?'], intent: 'voice', has: [/mikrofonu/] },
  { q: ['Cześć Mewka'], intent: 'greeting', has: [/tu Mewka/] },
  { q: ['Dziękuję!'], intent: 'thanks', has: [/Proszę bardzo/] },
  { q: ['Czy jesteś AI?'], intent: 'identity', has: [/nie człowiek/] },
  { q: ['Jaka będzie jutro pogoda w Ystad?'], intent: 'fallback', fallback: true, has: [/Nie znam odpowiedzi w trybie lokalnym/, /Możesz zapytać/] },
  // English
  { q: ['Fire in the forward cabins, what do I do?'], lang: 'en', intent: 'emergency', kind: 'fire', zone: 'cabins-fwd', blocked: 'stair-fwd', out: 'en', has: [/manual call point/, /Muster List/] },
  { q: ['Man overboard on the port side!'], lang: 'pl', intent: 'emergency', kind: 'mob', out: 'en', has: [/lifebuoy/] },
  { q: ['Show me the evacuation route from the engine room'], lang: 'en', intent: 'route', zone: 'engine-room', out: 'en', has: [/[Mm]uster station A/] },
  { q: ['What is the general alarm signal?'], lang: 'en', intent: 'signal', kind: 'general', out: 'en', has: [/7 short \+ 1 long/] },
  { q: ['Where is the chief engineer?'], lang: 'en', intent: 'crew-where', zone: 'engine-room', out: 'en', has: [/Paweł Piotrowski/, /95 min ago|1 h 35 min ago/] },
  { q: ['Who is on the bridge?'], lang: 'en', intent: 'crew-room', out: 'en', has: [/On the bridge there are 2 people/] },
  { q: ['How many people are on board?'], lang: 'en', intent: 'crew-summary', out: 'en' },
  { q: ['What can you do?'], lang: 'en', intent: 'help', out: 'en' },
  { q: ['Unconscious passenger in the restaurant'], lang: 'en', intent: 'emergency', kind: 'medical', zone: 'restaurant', out: 'en', has: [/CPR|AED/] },
  // follow-ups
  { q: ['Pokaż drogę ewakuacji z kabin na rufie', 'a jeśli schody rufowe są zablokowane?'], intent: 'route', zone: 'cabins-aft', blocked: 'stair-aft', has: [/Schody rufowe zablokowane/] },
  { q: ['Pożar w restauracji', 'a z salonu?'], intent: 'emergency', kind: 'fire', zone: 'lounge' },
  { q: ['Pożar w kabinach na śródokręciu', 'a jeśli schody dziobowe są zadymione?'], intent: 'emergency', kind: 'fire', zone: 'cabins-mid', blocked: 'stair-fwd' },
  { q: ['Przeciek w maszynowni', 'a jak brzmi sygnał?'], intent: 'signal', kind: 'flooding' },
  { q: ['Gdzie jest bosman?', 'a starszy mechanik?'], intent: 'crew-where', has: [/Paweł Piotrowski/] },
  { q: ['Pożar w kabinach na rufie', 'a gdzie jest kapitan?'], intent: 'crew-where', has: [/Bartosz Kozłowski/] },
  { q: ['Kto jest na mostku?', 'a w maszynowni?'], intent: 'crew-room', has: [/Paweł Piotrowski/] },
];

describe('local engine: question table', () => {
  test(`at least 30 questions (${CASES.length})`, () => assert.ok(CASES.length >= 30));
  for (const c of CASES) {
    test(`${c.q.join(' -> ')} => ${c.intent}${c.kind ? '/' + c.kind : ''}`, async () => {
      const a = await ans(c.lang ?? 'pl', ...c.q);
      shape(a);
      assert.equal(a.intent.type, c.intent, `intent of ${JSON.stringify(c.q)}: ${JSON.stringify(a.intent)}`);
      if (c.kind) assert.equal(a.intent.kind, c.kind);
      if (c.drill) assert.equal(drill(a), c.drill);
      if (c.zone === null) assert.equal(route(a), undefined, 'no route expected');
      else if (c.zone) assert.equal(route(a)?.zone, c.zone, 'route zone: ' + JSON.stringify(a.actions));
      if (c.blocked) assert.equal(route(a)?.blocked, c.blocked);
      if (c.zone && !c.blocked) assert.equal(route(a)?.blocked, undefined, 'no blocked stair expected');
      assert.equal(a.fallback, !!c.fallback, 'fallback');
      assert.equal(a.lang, c.out ?? 'pl');
      for (const re of c.has ?? []) assert.match(all(a), re);
    });
  }
});

describe('local engine: details', () => {
  test('text helpers: diacritics, typos, stems', () => {
    assert.equal(fold('Pożar ŁÓDŹ'), 'pozar lodz');
    assert.equal(lev('pozar', 'pozsr'), 1);
    assert.ok(stemMatch('pozarze', 'pozar') && stemMatch('pozsr', 'pozar') && !stemMatch('pora', 'pozar'));
  });

  test('language detection: question wins over the UI language, UI language breaks ties', () => {
    assert.equal(detectLang('Where is the captain?', 'pl'), 'en');
    assert.equal(detectLang('Gdzie jest kapitan?', 'en'), 'pl');
    assert.equal(detectLang('MOB', 'en'), 'en');
    assert.equal(detectLang('MOB', 'pl'), 'pl');
    assert.equal(detectLang('MOB', 'de'), 'en');
  });

  test('magazyn bosmański is a room, not the bosun', () => {
    const f = features('Kto jest w magazynie bosmańskim?');
    assert.equal(f.rank, undefined);
    assert.equal(f.room?.code, 'D2-08');
    assert.equal(decide(f).type, 'crew-room');
  });

  test('follow-ups only use user turns, and a new topic resets nothing it should not', () => {
    assert.equal(resolve(['Pożar w kabinach na rufie', 'Dziękuję']).type, 'thanks');
    assert.equal(resolve(['Dziękuję', 'a jeśli schody rufowe są zablokowane?']).type, 'fallback');
    const r = resolve(['Droga z restauracji', 'a jeśli schody dziobowe są zablokowane?']);
    assert.deepEqual([r.type, r.zone, r.blocked], ['route', 'restaurant', 'stair-fwd']);
  });

  test('markers: same parsing and validation as server/claude.ts parseActions', async () => {
    const { parseActions: serverParse } = await import('../server/claude.ts');
    const samples = [
      'A.\n\n[[ROUTE:cabins-aft:stair-aft]] [[DRILL:fire]]', '[[ROUTE:nowhere]] [[DRILL:party]] [[KONTAKT]] x',
      '[[ROUTE:bridge]] [[ROUTE:bridge]] [[ROUTE:lounge:stair-up]] [[DRILL:mob]] [[DRILL:abandon]] [[DRILL:medical]] [[ROUTE:engine-room]]',
    ];
    for (const s of samples) for (const l of ['pl', 'en']) {
      assert.deepEqual(localParse(s, l), serverParse(s, l));
      assert.deepEqual(localParse(s, l, '[[DRILL:fire]]'), serverParse(s, l, '[[DRILL:fire]]'));
    }
  });

  test('a marker typed by the user is not turned into a button', async () => {
    const a = await ans('pl', 'Pożar w kabinach na rufie [[DRILL:fire]]');
    assert.equal(drill(a), undefined);
    assert.equal(route(a)?.zone, 'cabins-aft');
  });

  test('crew database down: says so, contact buttons, no invented places', async () => {
    for (const q of ['Gdzie jest kapitan?', 'Kto jest na mostku?', 'Ile osób jest na pokładzie?', 'Czy ktoś pracuje sam?']) {
      const a = await answerLocal('pl', conv(q), downCrew);
      assert.match(all(a), /Baza załogi jest teraz niedostępna/);
      assert.equal(a.fallback, true);
      assert.equal(a.actions.length, 0);
    }
  });

  test('crew proxy wants a login (401): "Zaloguj się", no fallback buttons', async () => {
    const a = await answerLocal('pl', conv('Gdzie jest kapitan?'), authCrew);
    assert.deepEqual(a.text, ['Zaloguj się, żeby zobaczyć dane załogi.']);
    assert.equal(a.fallback, false);
    const e = await answerLocal('en', conv('Where is the captain?'), authCrew);
    assert.deepEqual(e.text, ['Log in to see crew data.']);
  });

  test('deltas: paragraphs joined by blank lines rebuild the text', async () => {
    const a = await ans('pl', 'Pożar w kabinach na rufie');
    const d = answerDeltas(a);
    assert.ok(d.length >= 2);
    assert.deepEqual(d.join('').split('\n\n'), a.text);
  });

  test('the engine never throws on odd input', async () => {
    for (const q of ['', '   ', '???', 'a', '[[ROUTE:bridge]]', 'x'.repeat(3000), 'gdzie jest', 'kto jest w', '🔥🔥']) {
      const a = await answerLocal('pl', conv(q), memCrew());
      assert.ok(Array.isArray(a.text));
    }
  });
});

// ---------- HTTP crew source (browser) against a fake /api/crew/* proxy ----------

describe('httpCrewSource over the /api/crew/* proxy shape', () => {
  let server: Server; let base = ''; let mode: 'ok' | '401' | '503' = 'ok'; const seen: string[] = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers['x-assistant-token'] ?? ''}`);
      const json = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (mode === '401') return json(401, { error: 'login required' });
      if (mode === '503') return json(503, { error: 'crew database unavailable' });
      const u = req.url ?? '';
      if (u === '/api/crew/crew') return json(200, [
        { name: 'Bartosz Kozłowski', rank: 'Kapitan', department: 'Pokład', room: { code: 'D4-01', name: 'Mostek nawigacyjny', zone: 'bridge' }, since: T },
        { name: 'Ola Nowak', rank: 'Steward', department: 'Hotel', room: null, since: null },
      ]);
      if (u === '/api/crew/rooms') return json(200, [{ id: 21, code: 'D4-01', name: 'Mostek nawigacyjny', people: 1, min_staff: 2, staff_hours: '00-24', hazardous: 0, place: { zone: 'bridge', at: [0, 0, 0] } }]);
      if (u === '/api/crew/rooms/21') return json(200, { id: 21, code: 'D4-01', name: 'Mostek nawigacyjny', min_staff: 2, staff_hours: '00-24', hazardous: 0, place: { zone: 'bridge' },
        crew: [{ name: 'Bartosz Kozłowski', rank: 'Kapitan', room: { code: 'D4-01', name: 'Mostek nawigacyjny', zone: 'bridge' }, since: T }] });
      if (u === '/api/crew/summary') return json(200, { crew: 2, onboard: 1, ashore: 1, lastCheckin: T });
      if (u === '/api/crew/alerts') return json(200, { staffing: [{ code: 'D4-01', name: 'Mostek nawigacyjny', people: 1, min_staff: 2, status: 'warning' }], lone: [], lastCheckin: [] });
      json(404, { error: 'not found' });
    });
    base = await listen(server);
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test('find / room / summary / alerts answers, token header sent', async () => {
    mode = 'ok';
    const src = httpCrewSource(base, { 'x-assistant-token': 'tok' });
    const a = await answerLocal('pl', conv('Gdzie jest kapitan?'), src);
    assert.match(all(a), /Bartosz Kozłowski, kapitan, jest w pomieszczeniu Mostek nawigacyjny \(D4-01\), ostatni check-in 7 min temu/);
    assert.equal(route(a)?.zone, 'bridge');
    assert.match(all(await answerLocal('pl', conv('Kto jest na mostku?'), src)), /Na mostku jest teraz 1 osoba: Bartosz Kozłowski \(kapitan, 7 min temu\)/);
    assert.match(all(await answerLocal('pl', conv('Ile osób jest na pokładzie?'), src)), /1 na statku, 1 na lądzie/);
    assert.match(all(await answerLocal('pl', conv('Pokaż alerty bezpieczeństwa'), src)), /Za mała obsada: Mostek nawigacyjny 1 z wymaganych 2/);
    assert.ok(seen.every((s) => s.endsWith(' tok')));
  });

  test('401 -> login message; 503 -> crew database unavailable', async () => {
    const src = httpCrewSource(base);
    mode = '401';
    const a = await answerLocal('pl', conv('Gdzie jest kapitan?'), src);
    assert.deepEqual([a.text, a.fallback], [['Zaloguj się, żeby zobaczyć dane załogi.'], false]);
    mode = '503';
    const b = await answerLocal('pl', conv('Gdzie jest kapitan?'), src);
    assert.match(all(b), /niedostępna/);
    assert.equal(b.fallback, true);
    mode = 'ok';
  });
});

// ---------- browser adapter in local mode ----------
describe('src/adapter.ts without a server (auto mode -> local engine)', () => {
  test('askStream: a few deltas, then the local answer with buttons', async () => {
    assert.equal(MODE, 'auto');
    const seenD: string[] = [];
    const r = await adapterAskStream(conv('Pożar w kabinach na rufie'), 'pl', { onDelta: (t) => seenD.push(t) });
    assert.ok(seenD.length >= 2, 'several deltas');
    assert.equal(seenD[seenD.length - 1], r.text.join('\n\n'));
    assert.ok(!r.remoteFailed && !r.notConfigured);
    assert.equal(r.sources[0].label, 'Tryb lokalny: karty ćwiczeń');
    assert.deepEqual(r.actions?.map((a) => a.type), ['route', 'drill']);
  });

  test('ask: crew question without the proxy says the crew database is unavailable', async () => {
    const r = await adapterAsk(conv('Gdzie jest kapitan?'), 'pl');
    assert.match(r.text.join(' '), /Baza załogi jest teraz niedostępna/);
  });

  test('askStream: stopped by the user -> aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await adapterAskStream(conv('Pożar'), 'pl', { signal: ac.signal });
    assert.equal(r.aborted, true);
  });
});

// ---------- the server with the local engine ----------
interface Srv { base: string; child: ChildProcess; log: string[]; exited: boolean }
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}
async function startServer(extra: Record<string, string>): Promise<Srv> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || ['ASSISTANT_TOKEN', 'ALLOWED_ORIGINS', 'CREW_API', 'ASSISTANT_FAKE', 'ASSISTANT_ENGINE'].includes(k)) delete env[k];
  Object.assign(env, { PORT: String(port), NODE_ENV: 'test' }, extra);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv: Srv = { base: `http://127.0.0.1:${port}`, child, log: [], exited: false };
  child.stdout!.on('data', (d) => srv.log.push(String(d)));
  child.stderr!.on('data', (d) => srv.log.push(String(d)));
  child.on('exit', () => { srv.exited = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (srv.exited) throw new Error('server exited:\n' + srv.log.join(''));
    try { if ((await fetch(srv.base + '/api/health')).ok) return srv; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start:\n' + srv.log.join(''));
}
const stop = (srv?: Srv) => new Promise<void>((resolve) => {
  if (!srv || srv.exited) return resolve();
  srv.child.once('exit', () => resolve()); srv.child.kill('SIGTERM'); setTimeout(() => srv.child.kill('SIGKILL'), 2000).unref();
});
let ipN = 1;
const post = (srv: Srv, p: string, body: unknown) => fetch(srv.base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.77.0.${ipN++}` }, body: JSON.stringify(body),
});

describe('server with ASSISTANT_ENGINE=local (no key, ASSISTANT_FAKE unset)', () => {
  let srv: Srv;
  before(async () => { srv = await startServer({ ASSISTANT_ENGINE: 'local', CREW_API: DB_BASE }); });
  after(async () => { await stop(srv); });

  test('health reports the local engine', async () => {
    const h = await (await fetch(srv.base + '/api/health')).json();
    assert.deepEqual([h.ok, h.engine, h.model, h.configured], [true, 'local', 'local', false]);
  });

  test('POST /api/chat answers locally with buttons', async () => {
    const r = await post(srv, '/api/chat', { lang: 'pl', messages: conv('Pożar w kabinach na rufie, co robić?') });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.engine, 'local');
    assert.match(j.text.join(' '), /ostrzegacz/);
    assert.deepEqual(j.actions, [
      { type: 'route', zone: 'cabins-aft', blocked: 'stair-aft', label: 'kabiny na rufie, pokład 3, zablokowana klatka schodowa rufowa' },
      { type: 'drill', id: 'fire', label: 'pożar' },
    ]);
    assert.equal(j.fallback, false);
    assert.ok(!('intent' in j) && !('lang' in j));
  });

  test('POST /api/chat/stream: deltas then done, same SSE format', async () => {
    const r = await post(srv, '/api/chat/stream', { lang: 'pl', messages: conv('Droga z kabin na rufie', 'a jeśli schody rufowe są zablokowane?') });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const ev = await readSSE(r);
    const deltas = ev.filter((e) => e.event === 'delta');
    const done = ev[ev.length - 1];
    assert.equal(done.event, 'done');
    assert.ok(deltas.length >= 2);
    assert.equal(deltas.map((e) => e.json.text).join(''), done.json.text.join('\n\n'));
    assert.deepEqual(done.json.actions[0], { type: 'route', zone: 'cabins-aft', blocked: 'stair-aft', label: 'kabiny na rufie, pokład 3, zablokowana klatka schodowa rufowa' });
  });

  test('crew question through the server crew tools: anonymous chat -> log in first (server/auth.ts)', async () => {
    const j = await (await post(srv, '/api/chat', { lang: 'pl', messages: conv('Gdzie jest kapitan?') })).json();
    assert.deepEqual(j.text, ['Zaloguj się, żeby zobaczyć dane załogi.']);
    assert.equal(j.fallback, false);
    assert.deepEqual(j.actions, []);
  });

  test('server crew source maps the crew tool results (tools opened as for a logged-in user)', async () => {
    const crew = await import('../server/crew.ts');
    crew.setCrewAccessCheck(() => true);
    const { localAsk } = await import('../server/local.ts');
    const j = await localAsk('pl', conv('Gdzie jest kapitan?'));
    assert.match(j.text.join(' '), /Bartosz Kozłowski, kapitan, jest w pomieszczeniu Mostek nawigacyjny \(D4-01\)/);
    assert.ok(!/1970|PL\b|201/.test(j.text.join(' ')), 'no private fields');
    assert.deepEqual(j.actions, [{ type: 'route', zone: 'bridge', label: 'mostek nawigacyjny' }]);
    const k = await localAsk('pl', conv('Kto jest na mostku?'));
    assert.match(k.text.join(' '), /Na mostku jest teraz 1 osoba: Bartosz Kozłowski/);
    crew.setCrewAccessCheck(() => false);
  });

  test('bad input still 400', async () => {
    assert.equal((await post(srv, '/api/chat', { lang: 'pl', messages: [] })).status, 400);
  });
});

describe('server ASSISTANT_ENGINE=auto without a key -> local; default without a key -> 503', () => {
  test('auto', async () => {
    const srv = await startServer({ ASSISTANT_ENGINE: 'auto', CREW_API: 'off' });
    try {
      assert.equal((await (await fetch(srv.base + '/api/health')).json()).engine, 'local');
      const j = await (await post(srv, '/api/chat', { lang: 'en', messages: conv('Where is the captain?') })).json();
      assert.match(j.text.join(' '), /crew database is unavailable|Log in to see crew data/);
    } finally { await stop(srv); }
  });
  test('default (claude) keeps the not-configured path', async () => {
    const srv = await startServer({ CREW_API: 'off' });
    try {
      const h = await (await fetch(srv.base + '/api/health')).json();
      assert.deepEqual([h.engine, h.configured], ['claude', false]);
      const r = await post(srv, '/api/chat', { lang: 'pl', messages: conv('Pożar') });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'assistant not configured' });
    } finally { await stop(srv); }
  });
});
