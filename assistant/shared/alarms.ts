// Ship alarm system ("System alarmowy"): ids, types and the wire protocol shared by the assistant server
// (server/alarms.ts) and the terminals (src/alarm/**). Dependency-free, like shared/crew-map.ts.
// Client imports it as `../../shared/alarms`, the server as `../shared/alarms.ts`. Protocol: docs/ALARMS.md.

export const ALARM_KINDS = ['general', 'fire', 'abandon', 'mob', 'flooding', 'pollution', 'blackout', 'medical', 'security'] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];
export const isAlarmKind = (v: unknown): v is AlarmKind => typeof v === 'string' && (ALARM_KINDS as readonly string[]).includes(v);

/** Polish first, English second. */
export const ALARM_NAMES: Record<AlarmKind, { pl: string; en: string }> = {
  general: { pl: 'Alarm ogólny', en: 'General alarm' },
  fire: { pl: 'Pożar', en: 'Fire' },
  abandon: { pl: 'Opuszczenie statku', en: 'Abandon ship' },
  mob: { pl: 'Człowiek za burtą', en: 'Man overboard' },
  flooding: { pl: 'Przeciek / zatapianie', en: 'Flooding' },
  pollution: { pl: 'Zanieczyszczenie morza', en: 'Pollution' },
  blackout: { pl: 'Zanik zasilania', en: 'Blackout' },
  medical: { pl: 'Nagły wypadek medyczny', en: 'Medical emergency' },
  security: { pl: 'Zagrożenie ochrony (ISPS)', en: 'Security threat (ISPS)' },
};

/** Same ids as ZoneId in src/ship/routes.ts (kept here so the server needs no client code). */
export const ALARM_ZONES = ['bridge', 'cabins-fwd', 'cabins-mid', 'cabins-aft', 'restaurant', 'lounge', 'reclining-lounge',
  'vehicle-d1', 'vehicle-d2', 'engine-room', 'engine-control'] as const;
export type AlarmZone = (typeof ALARM_ZONES)[number];
export const isAlarmZone = (v: unknown): v is AlarmZone => typeof v === 'string' && (ALARM_ZONES as readonly string[]).includes(v);
/** Where a terminal stands: an alarm zone or the boat deck (muster station room in the crew DB). */
export type TerminalZone = AlarmZone | 'boat-deck';
export const isTerminalZone = (v: unknown): v is TerminalZone => v === 'boat-deck' || isAlarmZone(v);

export type BlockedStair = 'stair-aft' | 'stair-fwd';
export const isStair = (v: unknown): v is BlockedStair => v === 'stair-aft' || v === 'stair-fwd';
export type MusterStation = 'muster-a' | 'muster-b';
export type TerminalRole = 'bridge' | 'crew';

export const MESSAGE_MAX = 200;
export const NAME_MAX = 40;
export const USER_MAX = 40;
export const HEADCOUNT_MAX = 999;

/** Muster station a zone evacuates to. Mirrors route() in src/ship/routes.ts: bridge -> B (own stairs),
 *  engine spaces -> aft stair (A) unless it is blocked, others -> nearest stairwell, the other one when blocked. */
const NEAREST_STAIR: Record<AlarmZone, BlockedStair | null> = {
  bridge: null, 'cabins-fwd': 'stair-fwd', 'cabins-mid': 'stair-aft', 'cabins-aft': 'stair-aft', restaurant: 'stair-fwd',
  lounge: 'stair-fwd', 'reclining-lounge': 'stair-aft', 'vehicle-d1': 'stair-aft', 'vehicle-d2': 'stair-aft',
  'engine-room': 'stair-aft', 'engine-control': 'stair-aft',
};
export function musterFor(zone: TerminalZone, blocked: BlockedStair | null = null): MusterStation {
  if (zone === 'boat-deck') return 'muster-a'; // the muster station room (D4-04) is station A
  const s = NEAREST_STAIR[zone];
  if (!s) return 'muster-b';
  const used = blocked === s ? (s === 'stair-aft' ? 'stair-fwd' : 'stair-aft') : s;
  return used === 'stair-aft' ? 'muster-a' : 'muster-b';
}

/** One acknowledgement: `name` = terminal name, `user` = who pressed it (optional), `zone` = terminal zone at that time. */
export interface AlarmAck { at: string; name: string; zone?: TerminalZone | null; user?: string; headcount?: number }

export interface Alarm {
  id: string;
  kind: AlarmKind;
  zone: AlarmZone | null;
  blocked: BlockedStair | null;
  message: string;
  /** true = ćwiczenie (drill), false = prawdziwy alarm */
  drill: boolean;
  /** terminal name that raised it */
  raisedBy: string;
  raisedById: string;
  at: string;
  endedAt: string | null;
  endedBy?: string;
  /** 'ended' by the bridge or 'replaced' by a newer alarm */
  endReason?: 'ended' | 'replaced';
  acks: Record<string, AlarmAck>;
  /** fire detectors that went off (shared/sensors.ts ids), newest last; absent on older alarms */
  sensors?: string[];
}

export interface TerminalInfo {
  terminalId: string;
  name: string;
  role: TerminalRole;
  zone: TerminalZone | null;
  /** crew DB room code (D4-01) when the terminal is one from the crew database */
  place: string | null;
}

/** Accountability for one zone during the active alarm. `expected` = people checked in there (crew DB), null when the DB is down. */
export interface MusterZoneRow {
  zone: TerminalZone;
  expected: number | null;
  terminals: number;
  acked: number;
  /** sum of headcounts reported with the acks from this zone */
  reported: number;
}
export interface MusterRow {
  station: MusterStation;
  zones: MusterZoneRow[];
  expected: number | null;
  terminals: number;
  acked: number;
  reported: number;
}
export interface Muster {
  rows: MusterRow[];
  /** crew database reachable when the table was computed */
  crewOnline: boolean;
  /** acks from terminals without a zone */
  unzonedAcks: number;
  at: string;
}

export interface AlarmState {
  active: Alarm | null;
  muster: Muster | null;
  terminals: TerminalInfo[];
  now: string;
}

// ---------- wire protocol (JSON text frames on /api/alarms/ws) ----------
export type ClientMsg =
  | { type: 'hello'; terminalId: string; name: string; role: TerminalRole; zone?: TerminalZone | null; place?: string | null }
  | { type: 'raise'; kind: AlarmKind; zone: AlarmZone | null; blocked: BlockedStair | null; message: string; drill: boolean; confirm?: boolean; sensors?: string[] }
  | { type: 'ack'; alarmId: string; user?: string; headcount?: number }
  | { type: 'end'; alarmId: string }
  | { type: 'ping' };

export type ServerMsg =
  | { type: 'welcome'; terminalId: string; role: TerminalRole; state: AlarmState }
  | { type: 'state'; state: AlarmState; reason: 'raised' | 'ack' | 'ended' | 'terminals' | 'muster' }
  | { type: 'pong'; now: string }
  | { type: 'error'; code: AlarmErrorCode; message: string };

export type AlarmErrorCode =
  | 'unknown' | 'json' | 'invalid' | 'not-hello' | 'hello-twice' | 'forbidden' | 'confirm' | 'no-alarm' | 'rate' | 'too-long';

export const TERMINAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
export const PLACE_RE = /^[A-Z0-9][A-Z0-9_-]{0,11}$/;
