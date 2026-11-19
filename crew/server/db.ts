// Crew database: ship rooms, crew members, terminals and the check-in log.
// Uses Node's built-in SQLite (node:sqlite), so there is nothing to install.
// Current location of a crew member = their latest check-in event, if it is an 'in'.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS decks (
  id      INTEGER PRIMARY KEY,
  level   INTEGER NOT NULL UNIQUE,   -- 1 = lowest deck
  name    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL UNIQUE,   -- e.g. "D2-04"
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL,          -- function category: Nawigacja, Maszynownia, ...
  description TEXT    NOT NULL,
  deck_id     INTEGER NOT NULL REFERENCES decks(id),
  area_m2     REAL    NOT NULL CHECK (area_m2 > 0),
  capacity    INTEGER NOT NULL CHECK (capacity > 0),   -- safe max number of people
  restricted  INTEGER NOT NULL DEFAULT 0,              -- 1 = authorised personnel only
  min_staff   INTEGER NOT NULL DEFAULT 0,              -- required minimum crew (0 = no requirement)
  staff_hours TEXT    NOT NULL DEFAULT '00-24',        -- when min_staff applies, ship time "HH-HH"
  hazardous   INTEGER NOT NULL DEFAULT 0               -- 1 = nobody should work here alone for long
);

CREATE TABLE IF NOT EXISTS crew (
  id          INTEGER PRIMARY KEY,
  badge       TEXT    NOT NULL UNIQUE,   -- human-readable crew number, e.g. "B-1001"
  rfid_uid    TEXT,                      -- UID of the RFID card/wristband, e.g. "04:A3:1F:5B:C2:6E:80" (unique, see index)
  rfid_type   TEXT    CHECK (rfid_type IN ('karta', 'opaska')),
  first_name  TEXT    NOT NULL,
  last_name   TEXT    NOT NULL,
  rank        TEXT    NOT NULL,          -- Kapitan, Starszy mechanik, Marynarz, ...
  department  TEXT    NOT NULL,          -- Pokład, Maszynownia, Hotel, Medyczny
  shift       TEXT    NOT NULL,          -- watch: 00-04, 04-08, 08-12, dzienna
  nationality TEXT    NOT NULL,
  birth_date  TEXT    NOT NULL,
  phone_ext   TEXT    NOT NULL,          -- on-board phone extension
  cabin_id    INTEGER REFERENCES rooms(id),
  embarked_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id      INTEGER PRIMARY KEY,
  code    TEXT    NOT NULL UNIQUE,       -- e.g. "T-D2-04-A"
  room_id INTEGER NOT NULL REFERENCES rooms(id)
);

CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY,
  crew_id     INTEGER NOT NULL REFERENCES crew(id),
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  room_id     INTEGER NOT NULL REFERENCES rooms(id),
  direction   TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  at          TEXT    NOT NULL           -- ISO timestamp, UTC
);
CREATE INDEX IF NOT EXISTS checkins_crew_at ON checkins (crew_id, at);
CREATE INDEX IF NOT EXISTS checkins_at ON checkins (at);

-- latest event per crew member
CREATE VIEW IF NOT EXISTS last_checkin AS
SELECT c.* FROM checkins c
JOIN (SELECT crew_id, MAX(id) AS id FROM checkins GROUP BY crew_id) m ON m.id = c.id;

-- where everyone is right now (NULL room = checked out / unknown)
CREATE VIEW IF NOT EXISTS crew_location AS
SELECT cr.id AS crew_id,
       CASE WHEN l.direction = 'in' THEN l.room_id END AS room_id,
       l.at AS since
FROM crew cr LEFT JOIN last_checkin l ON l.crew_id = cr.id;
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // older databases: add columns introduced later (values come from `npm run seed`)
  const cols = new Set((db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('min_staff')) db.exec('ALTER TABLE rooms ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('staff_hours')) db.exec("ALTER TABLE rooms ADD COLUMN staff_hours TEXT NOT NULL DEFAULT '00-24'");
  if (!cols.has('hazardous')) db.exec('ALTER TABLE rooms ADD COLUMN hazardous INTEGER NOT NULL DEFAULT 0');
  const crewCols = new Set((db.prepare('PRAGMA table_info(crew)').all() as { name: string }[]).map((c) => c.name));
  if (!crewCols.has('rfid_uid')) db.exec('ALTER TABLE crew ADD COLUMN rfid_uid TEXT');
  if (!crewCols.has('rfid_type')) db.exec("ALTER TABLE crew ADD COLUMN rfid_type TEXT CHECK (rfid_type IN ('karta', 'opaska'))");
  // one RFID tag = one person (several NULLs allowed: tag not issued yet)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS crew_rfid_uid ON crew (rfid_uid)');
  return db;
}
