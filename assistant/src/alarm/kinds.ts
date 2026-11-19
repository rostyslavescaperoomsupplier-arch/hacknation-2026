// Per-kind presentation of the ship alarms: sound pattern (the drills' Web Audio patterns), colour and the top-3
// immediate actions. Drill kinds reuse src/drills/data.ts; 'general' and 'security' have their own short lists.
import type { Lang } from '../types';
import { DRILL_BY_ID, type AlarmPattern, type DrillId, type Txt } from '../drills/data';
import { ALARM_NAMES, type AlarmKind } from '../../shared/alarms';

export const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);
export const tx = (lang: Lang, t: Txt) => (lang === 'pl' ? t.pl : t.en);
export const kindName = (lang: Lang, k: AlarmKind) => tx(lang, ALARM_NAMES[k]);

const DRILL_KINDS: AlarmKind[] = ['fire', 'abandon', 'mob', 'flooding', 'pollution', 'blackout', 'medical'];
export const drillOf = (k: AlarmKind): DrillId | null => (DRILL_KINDS.includes(k) ? (k as DrillId) : null);

const SECURITY: AlarmPattern = {
  steps: [{ tone: 'chime', ms: 900, gap: 300 }, { tone: 'chime', ms: 900, gap: 300 }, { tone: 'chime', ms: 900, gap: 300 }, { tone: 'chime', ms: 900, gap: 0 }],
};

/** Sound for a kind. General alarm = 7 short + 1 long with bells (same as the abandon-ship drill). */
export function patternFor(k: AlarmKind): AlarmPattern {
  if (k === 'general') return DRILL_BY_ID.abandon.alarm;
  if (k === 'security') return SECURITY;
  return DRILL_BY_ID[k as DrillId].alarm;
}

/** Human description of the signal (from the drill cards). */
export function signalFor(lang: Lang, k: AlarmKind): string {
  if (k === 'general') return L(lang, '7 krótkich + 1 długi sygnał, dzwonki alarmowe', '7 short + 1 long blasts, alarm bells');
  if (k === 'security') return L(lang, 'Sygnał ochrony wg planu ochrony statku (SSP) + komunikat', 'Security signal as per the Ship Security Plan (SSP) + announcement');
  return tx(lang, DRILL_BY_ID[k as DrillId].signal);
}

const OWN: Partial<Record<AlarmKind, Txt[]>> = {
  general: [
    { pl: 'Idź do swojego punktu zbiórki wg Rozkładu alarmowego (Muster List)', en: 'Go to your muster station as per the Muster List' },
    { pl: 'Ciepłe ubranie, kamizelka ratunkowa, nie używaj wind', en: 'Warm clothing, lifejacket, do not use the lifts' },
    { pl: 'Zgłoś się dowódcy grupy, czekaj na komunikat z mostka', en: 'Report to your group leader, wait for the bridge announcement' },
  ],
  security: [
    { pl: 'Nie konfrontuj się. Zgłoś mostkowi miejsce i opis zagrożenia', en: 'Do not confront. Report location and description to the bridge' },
    { pl: 'Zabezpiecz strefy zastrzeżone wg planu ochrony (SSP)', en: 'Secure restricted areas as per the Ship Security Plan (SSP)' },
    { pl: 'Wykonuj polecenia oficera ochrony statku (SSO)', en: 'Follow the Ship Security Officer (SSO) instructions' },
  ],
};

/** Top-3 immediate actions for the overlay. */
export function actionsFor(k: AlarmKind): Txt[] {
  const own = OWN[k];
  if (own) return own;
  const d = DRILL_BY_ID[k as DrillId];
  return d?.phases.find((p) => p.id === 'first')?.items.slice(0, 3) ?? [];
}

/** "1:05" or "1:02:03" from seconds. */
export function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** Reaction time "12 s" / "2 min 05 s". */
export function reaction(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
