// Demo stand-in for the physical terminals: every few seconds a random crew member taps their card
// on a random terminal. It talks to the server only through POST /api/checkin, exactly like a real device.
//   npm run simulate                      (server must be running)
//   CREW_URL=http://host:8790 INTERVAL_MS=2000 npm run simulate
const BASE = process.env.CREW_URL || `http://localhost:${process.env.PORT || 8790}`;
const INTERVAL = Number(process.env.INTERVAL_MS || 2500);

const get = async (p: string) => (await fetch(BASE + p)).json();
const crew = (await get('/api/crew')) as { badge: string }[];
const terminals = (await get('/api/terminals')) as { code: string; room_name: string }[];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
console.log(`[terminals] ${terminals.length} terminali, ${crew.length} kart, odbicie co ${INTERVAL} ms → ${BASE}`);

setInterval(async () => {
  const term = pick(terminals);
  const direction = Math.random() < 0.05 ? 'out' : 'in';
  try {
    const res = await fetch(BASE + '/api/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ badge: pick(crew).badge, terminal: term.code, direction }),
    });
    const c = await res.json();
    if (!res.ok) throw new Error(c.error);
    console.log(`${term.code.padEnd(11)} ${direction === 'in' ? 'WEJŚCIE' : 'WYJŚCIE'}  ${c.first_name} ${c.last_name} (${term.room_name})`);
  } catch (e) {
    console.error('[terminals] błąd:', (e as Error).message);
  }
}, INTERVAL);
