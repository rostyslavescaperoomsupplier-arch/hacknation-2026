// Sample data: a 4-deck cargo ship, 45 crew members and 24 hours of terminal check-ins.
// Deterministic (seeded RNG), so every run gives the same ship and crew;
// check-in times are generated relative to `now`, so the data always looks fresh.
import type { DatabaseSync } from 'node:sqlite';

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECKS = [
  [1, 'Pokład dolny (maszynowy)'],
  [2, 'Pokład główny'],
  [3, 'Pokład mieszkalny'],
  [4, 'Pokład nawigacyjny'],
] as const;

// code, name, role, area m², capacity, restricted, terminals, description
type RoomDef = [string, string, string, number, number, 0 | 1, number, string];
const ROOMS: RoomDef[] = [
  ['D1-01', 'Maszynownia główna', 'Maszynownia', 320, 12, 1, 2, 'Silnik główny, agregaty prądotwórcze, kotły'],
  ['D1-02', 'Centrala manewrowa (ECR)', 'Maszynownia', 60, 6, 1, 1, 'Sterowanie i monitoring siłowni'],
  ['D1-03', 'Warsztat mechaniczny', 'Maszynownia', 80, 6, 0, 1, 'Tokarka, spawalnia, naprawy bieżące'],
  ['D1-04', 'Pompownia', 'Maszynownia', 70, 4, 1, 1, 'Pompy balastowe i zęzowe'],
  ['D1-05', 'Magazyn części zamiennych', 'Magazyn', 90, 4, 0, 1, 'Części do siłowni i instalacji'],
  ['D1-06', 'Chłodnie prowiantowe', 'Magazyn', 50, 3, 0, 1, 'Komory chłodnicze i mroźnie'],
  ['D2-01', 'Pokład ładunkowy', 'Ładunek', 600, 10, 0, 2, 'Luki ładowni, mocowanie kontenerów'],
  ['D2-02', 'Biuro ładunkowe', 'Ładunek', 30, 4, 0, 1, 'Plan ładunkowy, dokumentacja'],
  ['D2-03', 'Kuchnia', 'Wyżywienie', 55, 5, 0, 1, 'Przygotowanie posiłków'],
  ['D2-04', 'Mesa załogi', 'Wyżywienie', 70, 24, 0, 1, 'Posiłki załogi szeregowej'],
  ['D2-05', 'Mesa oficerska', 'Wyżywienie', 40, 12, 0, 1, 'Posiłki oficerów'],
  ['D2-06', 'Pralnia', 'Hotel', 25, 3, 0, 1, 'Pralnia i suszarnia'],
  ['D2-07', 'Szpital okrętowy', 'Medyczny', 35, 4, 1, 1, 'Gabinet lekarski i izolatka'],
  ['D2-08', 'Magazyn bosmański', 'Pokład', 45, 4, 0, 1, 'Liny, farby, sprzęt pokładowy'],
  ['D3-01', 'Kabiny oficerskie', 'Kwatery', 160, 12, 0, 1, 'Kabiny jednoosobowe oficerów'],
  ['D3-02', 'Kabiny załogi – blok A', 'Kwatery', 180, 18, 0, 1, 'Kabiny załogi szeregowej'],
  ['D3-03', 'Kabiny załogi – blok B', 'Kwatery', 180, 18, 0, 1, 'Kabiny załogi szeregowej'],
  ['D3-04', 'Świetlica', 'Rekreacja', 60, 16, 0, 1, 'TV, gry, biblioteka'],
  ['D3-05', 'Siłownia', 'Rekreacja', 40, 8, 0, 1, 'Sprzęt treningowy'],
  ['D3-06', 'Biuro kapitana', 'Dowodzenie', 25, 4, 1, 1, 'Dokumentacja statku, odprawy'],
  ['D4-01', 'Mostek nawigacyjny', 'Nawigacja', 85, 8, 1, 2, 'Prowadzenie nawigacji, wachty'],
  ['D4-02', 'Kabina radiowa (GMDSS)', 'Łączność', 18, 2, 1, 1, 'Łączność alarmowa i satelitarna'],
  ['D4-03', 'Sala odpraw', 'Dowodzenie', 35, 14, 0, 1, 'Odprawy i szkolenia'],
  ['D4-04', 'Stacja ratunkowa', 'Bezpieczeństwo', 120, 40, 0, 2, 'Szalupy, tratwy, punkt zbiórki'],
];

// required minimum crew per room and when it applies (ship time)
const STAFFING: Record<string, [number, string]> = {
  'D4-01': [2, '00-24'],   // bridge: officer of the watch + lookout
  'D1-02': [1, '00-24'],   // engine control room: engineer on watch
  'D2-03': [1, '06-19'],   // galley during meal service
};
// rooms where nobody should work alone for long (lone-worker alert)
const HAZARDOUS = ['D1-01', 'D1-03', 'D1-04', 'D1-06'];

type Weights = Record<string, number>;
const W = {
  watch: { 'D4-01': 1 },                     // officer of the watch / lookout: on the bridge for the whole watch
  ecr: { 'D1-02': 0.85, 'D1-01': 0.15 },     // engineer of the watch
  bridge: { 'D4-01': 0.7, 'D2-02': 0.2, 'D4-03': 0.1 },
  captain: { 'D4-01': 0.4, 'D3-06': 0.4, 'D4-03': 0.2 },
  radio: { 'D4-02': 0.7, 'D4-01': 0.3 },
  deck: { 'D2-01': 0.4, 'D2-08': 0.25, 'D4-01': 0.15, 'D4-04': 0.2 },
  engine: { 'D1-01': 0.4, 'D1-02': 0.3, 'D1-03': 0.2, 'D1-04': 0.07, 'D1-05': 0.03 },
  electric: { 'D1-02': 0.35, 'D1-03': 0.3, 'D1-01': 0.25, 'D4-01': 0.1 },
  galley: { 'D2-03': 0.85, 'D1-06': 0.1, 'D2-04': 0.05 },
  steward: { 'D2-04': 0.3, 'D2-05': 0.3, 'D2-06': 0.25, 'D2-03': 0.15 },
  medic: { 'D2-07': 0.85, 'D3-04': 0.15 },
} satisfies Record<string, Weights>;

// rank, department, count, shifts (cycled), work pattern, officer
const RANKS: [string, string, number, string[], keyof typeof W, boolean][] = [
  ['Kapitan', 'Pokład', 1, ['dzienna'], 'captain', true],
  ['Starszy oficer', 'Pokład', 1, ['04-08'], 'watch', true],
  ['II oficer', 'Pokład', 1, ['00-04'], 'watch', true],
  ['III oficer', 'Pokład', 1, ['08-12'], 'watch', true],
  ['Oficer radiowy', 'Pokład', 1, ['dzienna'], 'radio', true],
  ['Bosman', 'Pokład', 1, ['dzienna'], 'deck', false],
  ['Marynarz AB', 'Pokład', 9, ['00-04', '04-08', '08-12'], 'deck', false],
  ['Marynarz OS', 'Pokład', 4, ['dzienna', '00-04', '04-08', '08-12'], 'deck', false],
  ['Kadet pokładowy', 'Pokład', 2, ['dzienna'], 'deck', false],
  ['Starszy mechanik', 'Maszynownia', 1, ['dzienna'], 'engine', true],
  ['II mechanik', 'Maszynownia', 1, ['04-08'], 'ecr', true],
  ['III mechanik', 'Maszynownia', 1, ['00-04'], 'ecr', true],
  ['IV mechanik', 'Maszynownia', 1, ['08-12'], 'ecr', true],
  ['Elektryk', 'Maszynownia', 2, ['dzienna'], 'electric', true],
  ['Motorzysta', 'Maszynownia', 6, ['00-04', '04-08', '08-12'], 'engine', false],
  ['Ślusarz', 'Maszynownia', 2, ['dzienna'], 'engine', false],
  ['Kadet maszynowy', 'Maszynownia', 1, ['dzienna'], 'engine', false],
  ['Szef kuchni', 'Hotel', 1, ['06-14'], 'galley', true],
  ['Kucharz', 'Hotel', 2, ['06-14', '11-19'], 'galley', false],
  ['Steward', 'Hotel', 4, ['dzienna'], 'steward', false],
  ['Lekarz okrętowy', 'Medyczny', 1, ['dzienna'], 'medic', true],
  ['Ratownik medyczny', 'Medyczny', 1, ['dzienna'], 'medic', false],
];

const NAMES: Record<string, { m: string[]; f: string[]; last: string[] }> = {
  Polska: {
    m: ['Piotr', 'Tomasz', 'Krzysztof', 'Marek', 'Paweł', 'Michał', 'Jakub', 'Adam', 'Łukasz', 'Bartosz', 'Grzegorz', 'Kamil'],
    f: ['Anna', 'Katarzyna', 'Magdalena', 'Agnieszka', 'Joanna', 'Monika'],
    last: ['Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kamiński', 'Lewandowski', 'Zieliński', 'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowski', 'Jankowski', 'Mazur', 'Krawczyk', 'Piotrowski', 'Grabowski'],
  },
  Ukraina: {
    m: ['Ołeksandr', 'Dmytro', 'Andrij', 'Serhij', 'Wołodymyr', 'Iwan'],
    f: ['Olena', 'Natalia', 'Iryna'],
    last: ['Szewczenko', 'Bondarenko', 'Kowalenko', 'Tkaczenko', 'Kraweć', 'Melnyk'],
  },
  Filipiny: {
    m: ['Jose', 'Mark', 'John Paul', 'Rommel', 'Jerome'],
    f: ['Maria', 'Kristine'],
    last: ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Garcia', 'Mendoza'],
  },
};

// hours (UTC-agnostic ship time) in which a watch is on duty
function onDuty(shift: string, hour: number): boolean {
  if (shift === 'dzienna') return hour >= 8 && hour < 17 && hour !== 12;
  const [start, end] = shift.split('-').map(Number);
  if (end - start === 4) return [start, start + 12].some((s) => hour >= s && hour < s + 4);  // sea watch, twice a day
  return hour >= start && hour < end;                                                        // plain shift, e.g. galley
}
const isMeal = (h: number, m: number) => (h === 7 && m < 50) || (h === 12) || (h === 18 && m < 50);

export function seed(db: DatabaseSync, now = new Date()) {
  const r = rng(2026);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const weighted = (w: Weights) => {
    let x = r() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(w)) if ((x -= v) <= 0) return k;
    return Object.keys(w)[0];
  };

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM checkins; DELETE FROM terminals; DELETE FROM crew; DELETE FROM rooms; DELETE FROM decks;');

    const insDeck = db.prepare('INSERT INTO decks (id, level, name) VALUES (?, ?, ?)');
    for (const [level, name] of DECKS) insDeck.run(level, level, name);

    const roomId: Record<string, number> = {};
    const terminalsOf: Record<number, number[]> = {};
    const insRoom = db.prepare(`INSERT INTO rooms (code, name, role, description, deck_id, area_m2, capacity, restricted,
      min_staff, staff_hours, hazardous) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTerm = db.prepare('INSERT INTO terminals (code, room_id) VALUES (?, ?)');
    for (const [code, name, role, area, cap, restr, terms, desc] of ROOMS) {
      const [minStaff, hours] = STAFFING[code] ?? [0, '00-24'];
      const id = Number(insRoom.run(code, name, role, desc, Number(code[1]), area, cap, restr,
        minStaff, hours, HAZARDOUS.includes(code) ? 1 : 0).lastInsertRowid);
      roomId[code] = id;
      terminalsOf[id] = [];
      for (let t = 0; t < terms; t++)
        terminalsOf[id].push(Number(insTerm.run(`T-${code}-${'AB'[t]}`, id).lastInsertRowid));
    }

    const insCrew = db.prepare(`INSERT INTO crew (badge, rfid_uid, rfid_type, first_name, last_name, rank, department, shift,
      nationality, birth_date, phone_ext, cabin_id, embarked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // 7-byte UID like NTAG/MIFARE tags: "04:XX:XX:XX:XX:XX:XX"
    const uid = () => ['04', ...Array.from({ length: 6 }, () => Math.floor(r() * 256).toString(16).padStart(2, '0'))].join(':').toUpperCase();
    interface Member { id: number; shift: string; work: Weights; cabin: number; mess: number }
    const members: Member[] = [];
    let n = 0, blockA = 0;
    for (const [rank, dept, count, shifts, work, officer] of RANKS) {
      for (let i = 0; i < count; i++) {
        n++;
        const nat = r() < 0.6 ? 'Polska' : r() < 0.6 ? 'Ukraina' : 'Filipiny';
        const female = r() < 0.18;
        const nm = NAMES[nat];
        let last = pick(nm.last);
        if (nat === 'Polska' && female) last = last.replace(/ski$/, 'ska').replace(/cki$/, 'cka');
        const age = officer ? 30 + Math.floor(r() * 26) : 21 + Math.floor(r() * 30);
        const birth = new Date(Date.UTC(now.getUTCFullYear() - age, Math.floor(r() * 12), 1 + Math.floor(r() * 28)));
        const embarked = new Date(now.getTime() - (7 + Math.floor(r() * 110)) * 86400_000);
        const cabin = officer ? roomId['D3-01'] : (blockA++ % 2 === 0 ? roomId['D3-02'] : roomId['D3-03']);
        const shift = shifts[i % shifts.length];
        // wristbands where hands get dirty or wet (engine room, galley), cards elsewhere
        const tagType = dept === 'Maszynownia' || dept === 'Hotel' ? 'opaska' : 'karta';
        const id = Number(insCrew.run(
          `B-${String(1000 + n)}`, uid(), tagType, pick(female ? nm.f : nm.m), last, rank, dept, shift, nat,
          birth.toISOString().slice(0, 10), String(200 + n), cabin, embarked.toISOString().slice(0, 10),
        ).lastInsertRowid);
        // the first AB of each watch is the bridge lookout
        const pattern = rank === 'Marynarz AB' && i < 3 ? W.watch : W[work];
        const w = Object.fromEntries(Object.entries(pattern).map(([c, v]) => [roomId[c], v]));
        members.push({ id, shift, work: w, cabin, mess: officer ? roomId['D2-05'] : roomId['D2-04'] });
      }
    }

    // 24 h of movement: every 15-75 min decide where the person should be and check in there
    const insCheck = db.prepare('INSERT INTO checkins (crew_id, terminal_id, room_id, direction, at) VALUES (?, ?, ?, ?, ?)');
    const events: [number, number, number, string, number][] = [];
    const start = now.getTime() - 24 * 3600_000;
    const leisure = { [roomId['D3-04']]: 0.6, [roomId['D3-05']]: 0.4 };
    for (const m of members) {
      let t = start + r() * 30 * 60_000, here = -1;
      while (t < now.getTime() - 60_000) {
        const d = new Date(t), h = d.getHours(), min = d.getMinutes();
        let target: number;
        if (onDuty(m.shift, h)) target = Number(weighted(m.work));
        else if (isMeal(h, min)) target = m.mess;
        else if (h >= 22 || h < 6 || r() < 0.55) target = m.cabin;
        else target = Number(weighted(leisure));
        if (target !== here) {
          events.push([m.id, pick(terminalsOf[target]), target, 'in', t]);
          here = target;
        }
        t += (15 + r() * 60) * 60_000;
      }
    }
    // three people went ashore a few hours ago: last event is a check-out at the gangway
    for (const m of members.filter((x) => x.shift === 'dzienna').slice(-3)) {
      const t = now.getTime() - (1 + r() * 3) * 3600_000;
      const gangway = roomId['D2-01'];
      for (let i = events.length - 1; i >= 0; i--) if (events[i][0] === m.id && events[i][4] > t) events.splice(i, 1);
      events.push([m.id, terminalsOf[gangway][0], gangway, 'out', t]);
    }
    // two people with no check-in for a long time (lost card? needs checking on): ~5.5 h and ~9 h
    const deckDay = members.filter((x) => x.work[roomId['D2-01']] && x.shift === 'dzienna');   // bosun, OS, cadets
    const silent = [[deckDay[0], 'D2-08', 5.5], [deckDay[1], 'D2-01', 9.2]] as const;
    for (const [m, code, h] of silent) {
      const t = now.getTime() - h * 3600_000;
      for (let i = events.length - 1; i >= 0; i--) if (events[i][0] === m.id && events[i][4] >= t) events.splice(i, 1);
      events.push([m.id, terminalsOf[roomId[code]][0], roomId[code], 'in', t]);
    }
    events.sort((a, b) => a[4] - b[4]);
    for (const [c, term, room, dir, at] of events) insCheck.run(c, term, room, dir, new Date(at).toISOString());

    db.exec('COMMIT');
    return { rooms: ROOMS.length, crew: members.length, checkins: events.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
