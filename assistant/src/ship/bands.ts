// Crew wristband positions for the ship view (server: server/positions.ts, model: shared/positions.ts).
// Polls GET /api/bands every 2 s while enabled and the page is visible. 401 = not logged in (positions are personal
// data); the panel then offers the login instead of a map.
import { useEffect, useState } from 'react';
import type { BandPerson, BandStatus, BandsState, PosZone } from '../../shared/positions';
import { isZoneId, type ZoneId } from './routes';

export type { BandPerson, BandStatus, BandsState };
export type BandsData =
  | { status: 'loading' | 'down' | 'login'; state: null }
  | { status: 'ok'; state: BandsState };

const POLL_MS = 2000;

export function useBands(enabled: boolean): BandsData {
  const [data, setData] = useState<BandsData>({ status: 'loading', state: null });
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer = 0, fails = 0;
    const ctl = new AbortController();
    const tick = async () => {
      if (document.hidden) { timer = window.setTimeout(tick, POLL_MS); return; }
      try {
        const r = await fetch('/api/bands', { signal: ctl.signal, credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (r.status === 401) { setData({ status: 'login', state: null }); fails = 0; }
        else if (!r.ok) throw new Error(String(r.status));
        else { setData({ status: 'ok', state: (await r.json()) as BandsState }); fails = 0; }
      } catch {
        if (stop) return;
        fails++;
        if (fails > 1) setData({ status: 'down', state: null });
      }
      if (!stop) timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** Math.max(0, fails - 1), 20_000));
    };
    void tick();
    return () => { stop = true; ctl.abort(); clearTimeout(timer); };
  }, [enabled]);
  return data;
}

export const STATUS_TEXT: Record<BandStatus, { pl: string; en: string }> = {
  sos: { pl: 'SOS', en: 'SOS' },
  still: { pl: 'bez ruchu', en: 'not moving' },
  lost: { pl: 'brak sygnału', en: 'no signal' },
  moving: { pl: 'w drodze', en: 'on the way' },
  safe: { pl: 'na zbiórce', en: 'at muster' },
  ok: { pl: 'na pokładzie', en: 'on board' },
};

/** zone of a band position mapped to an evacuation start zone (for the route to / from that person) */
export function routeZoneOf(z: PosZone | null): ZoneId | null {
  if (!z) return null;
  if (isZoneId(z)) return z;
  if (z === 'stair-aft') return 'cabins-aft';
  if (z === 'stair-fwd') return 'cabins-fwd';
  return null;
}

/** seconds -> "45 s" / "3 min" */
export function ago(sec: number | null): string {
  if (sec == null) return '';
  return sec < 90 ? `${Math.max(0, Math.round(sec))} s` : `${Math.round(sec / 60)} min`;
}
