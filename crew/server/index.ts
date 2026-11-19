// Crew terminal server: JSON API over the SQLite crew database + the browser dashboard from ../public.
//   GET  /api/summary            headline numbers
//   GET  /api/rooms              every room with current headcount and occupancy
//   GET  /api/rooms/:id          one room + who is inside
//   GET  /api/crew?q=            crew list with current location
//   GET  /api/terminals          terminals (for the check-in form)
//   GET  /api/activity           check-ins per hour, last 24 h
//   GET  /api/alerts             staffing of key rooms, lone workers in hazardous rooms, time since last check-in
//   POST /api/checkin            { rfid, terminal, direction? }  - sent by a physical terminal when a card/wristband is read
// The browser dashboard only reads; check-ins come from the terminals (or `npm run simulate` for a demo).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { seed } from './seed.ts';
import { alerts } from './alerts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);
const DB_FILE = process.env.CREW_DB || path.join(here, '..', 'data', 'crew.db');
const PUBLIC = path.join(here, '..', 'public');

const db = openDb(DB_FILE);
if (!(db.prepare('SELECT COUNT(*) AS n FROM crew').get() as { n: number }).n) {
  console.log('[crew] empty database, generating sample data:', seed(db));
}

const ROOMS_SQL = `
SELECT r.id, r.code, r.name, r.role, r.description, r.area_m2, r.capacity, r.restricted,
       r.min_staff, r.staff_hours, r.hazardous,
       d.level AS deck, d.name AS deck_name,
       COUNT(l.crew_id) AS people,       ROUND(COUNT(l.crew_id) * 100.0 / r.capacity, 1) AS occupancy,      -- % of safe capacity
       (SELECT COUNT(*) FROM terminals t WHERE t.room_id = r.id) AS terminals,
       (SELECT COUNT(*) FROM checkins c WHERE c.room_id = r.id AND c.direction = 'in'
          AND c.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')) AS checkins_24h
FROM rooms r
JOIN decks d ON d.id = r.deck_id
LEFT JOIN crew_location l ON l.room_id = r.id
GROUP BY r.id
ORDER BY d.level DESC, r.code`;

const CREW_SQL = `
SELECT cr.id, cr.badge, cr.rfid_uid, cr.rfid_type, cr.first_name, cr.last_name, cr.rank, cr.department, cr.shift, cr.nationality,
       cr.birth_date, cr.phone_ext, cr.embarked_at, cab.name AS cabin,
       r.id AS room_id, r.code AS room_code, r.name AS room_name, l.since
FROM crew cr
JOIN crew_location l ON l.crew_id = cr.id
LEFT JOIN rooms r ON r.id = l.room_id
LEFT JOIN rooms cab ON cab.id = cr.cabin_id`;

function summary() {
  const one = (sql: string) => Object.values(db.prepare(sql).get() as object)[0] as number;
  return {
    crew: one('SELECT COUNT(*) FROM crew'),
    onboard: one('SELECT COUNT(*) FROM crew_location WHERE room_id IS NOT NULL'),
    ashore: one('SELECT COUNT(*) FROM crew_location WHERE room_id IS NULL'),
    rooms: one('SELECT COUNT(*) FROM rooms'),
    terminals: one('SELECT COUNT(*) FROM terminals'),
    checkins24h: one(`SELECT COUNT(*) FROM checkins WHERE at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`),
    lastCheckin: one('SELECT MAX(at) FROM checkins'),
  };
}

function activity() {
  // 24 full-hour buckets, the last one is the current (unfinished) hour
  const end = Math.floor(Date.now() / 3600_000) * 3600_000 + 3600_000;
  const from = new Date(end - 24 * 3600_000).toISOString();
  const rows = db.prepare('SELECT at FROM checkins WHERE at >= ?').all(from) as { at: string }[];
  const buckets = Array.from({ length: 24 }, (_, i) => ({ start: new Date(end - (24 - i) * 3600_000).toISOString(), count: 0 }));
  for (const { at } of rows) {
    const i = 23 - Math.floor((end - 1 - Date.parse(at)) / 3600_000);
    if (i >= 0 && i < 24) buckets[i].count++;
  }
  return buckets;
}

function checkin(body: any) {
  // readers format UIDs differently ("04a31f5bc26e80", "04-A3-1F-..."): compare hex digits only
  const uid = String(body.rfid ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  const crew = uid
    ? db.prepare("SELECT id FROM crew WHERE REPLACE(rfid_uid, ':', '') = ?").get(uid) as { id: number } | undefined
    : undefined;
  const term = db.prepare('SELECT id, room_id FROM terminals WHERE code = ?').get(String(body.terminal ?? '')) as { id: number; room_id: number } | undefined;
  if (!crew) throw new HttpError(404, 'Nieznany identyfikator RFID');
  if (!term) throw new HttpError(404, 'Nieznany terminal');
  const direction = body.direction === 'out' ? 'out' : 'in';
  db.prepare('INSERT INTO checkins (crew_id, terminal_id, room_id, direction, at) VALUES (?, ?, ?, ?, ?)')
    .run(crew.id, term.id, term.room_id, direction, new Date().toISOString());
  return db.prepare(CREW_SQL + ' WHERE cr.id = ?').get(crew.id);
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) { reject(new HttpError(413, 'too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Niepoprawny JSON')); } });
    req.on('error', reject);
  });
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(url: string, res: ServerResponse) {
  const rel = url === '/' ? 'index.html' : decodeURIComponent(url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    if (req.method === 'GET') {
      if (p === '/api/summary') return send(res, 200, summary());
      if (p === '/api/rooms') return send(res, 200, db.prepare(ROOMS_SQL).all());
      const m = p.match(/^\/api\/rooms\/(\d+)$/);
      if (m) {
        const room = (db.prepare(ROOMS_SQL).all() as any[]).find((r) => r.id === Number(m[1]));
        if (!room) throw new HttpError(404, 'Brak pomieszczenia');
        return send(res, 200, { ...room, crew: db.prepare(CREW_SQL + ' WHERE r.id = ? ORDER BY cr.last_name').all(room.id) });
      }
      if (p === '/api/crew') {
        const q = `%${url.searchParams.get('q') ?? ''}%`;
        return send(res, 200, db.prepare(CREW_SQL + ` WHERE cr.first_name || ' ' || cr.last_name || ' ' || cr.rank || ' ' || cr.badge || ' ' || IFNULL(cr.rfid_uid, '') LIKE ?
          ORDER BY cr.department, cr.id`).all(q));
      }
      if (p === '/api/terminals') return send(res, 200, db.prepare(`SELECT t.code, r.code AS room_code, r.name AS room_name
        FROM terminals t JOIN rooms r ON r.id = t.room_id ORDER BY t.code`).all());
      if (p === '/api/activity') return send(res, 200, activity());
      if (p === '/api/alerts') return send(res, 200, alerts(db));
    }
    if (req.method === 'POST') {
      if (p === '/api/checkin') return send(res, 200, checkin(await readJson(req)));
    }
    throw new HttpError(404, 'Not found');
  } catch (e: any) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Błąd serwera' });
  }
}).listen(PORT, () => console.log(`[crew] http://localhost:${PORT}  (db: ${DB_FILE})`));
