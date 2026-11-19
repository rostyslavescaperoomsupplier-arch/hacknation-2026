// Polish / English names of the model's node groups ("Cabin 112 / Teak" -> group "Cabin 112").
import type { Lang } from '../types';
import { ZONES, type ZoneId } from './routes';

const NAMES: Record<string, [string, string]> = {
  'Hull': ['Kadłub', 'Hull'],
  'Hull detailing': ['Detale kadłuba', 'Hull details'],
  'Lettering': ['Napisy na burcie', 'Hull lettering'],
  'Vehicle D1': ['Pokład samochodowy 1', 'Vehicle deck 1'],
  'Vehicle D2': ['Pokład samochodowy 2', 'Vehicle deck 2'],
  'Exterior': ['Pokład dziobowy (otwarty)', 'Forward open deck'],
  'Cabins D3': ['Pokład kabinowy', 'Cabin deck'],
  'Cabins shell': ['Nadbudówka kabinowa', 'Cabin deck superstructure'],
  'Cabin corridor partitions': ['Korytarz kabinowy', 'Cabin corridor'],
  'Public D4': ['Pokład pasażerski', 'Passenger deck'],
  'Public shell': ['Nadbudówka pasażerska', 'Passenger deck superstructure'],
  'Restaurant D4': ['Restauracja', 'Restaurant'],
  'Reclining lounge D4': ['Salon z fotelami lotniczymi', 'Reclining seat lounge'],
  'Reception D4': ['Recepcja', 'Reception'],
  'Lounge D4': ['Salon (bar)', 'Lounge (bar)'],
  'Galley': ['Kuchnia (kambuz)', 'Galley'],
  'Stairwell -29': ['Klatka schodowa rufowa', 'Aft stairwell'],
  'Stairwell 22': ['Klatka schodowa dziobowa', 'Forward stairwell'],
  'Sun deck': ['Pokład słoneczny (szalupowy)', 'Sun deck (boat deck)'],
  'Sun deck furniture': ['Meble pokładu słonecznego', 'Sun deck furniture'],
  'Railings': ['Relingi', 'Railings'],
  'Bow rails': ['Relingi dziobowe', 'Bow railings'],
  'Bridge': ['Mostek', 'Bridge'],
  'Bridge furniture': ['Konsola mostka', 'Bridge consoles'],
  'Bridge stairs': ['Schody na mostek', 'Bridge stairs'],
  'Funnel': ['Komin', 'Funnel'],
  'Roof equipment': ['Urządzenia na dachu', 'Roof equipment'],
  'Mast': ['Maszt', 'Mast'],
  'Lifeboats': ['Szalupy ratunkowe', 'Lifeboats'],
  'Liferafts': ['Tratwy ratunkowe', 'Liferafts'],
  'Deck machinery': ['Urządzenia pokładowe', 'Deck machinery'],
  'Mooring machinery': ['Urządzenia cumownicze', 'Mooring machinery'],
  'Engineering floor': ['Podłoga maszynowni', 'Engine room floor'],
  'Engineering walls': ['Ściany maszynowni', 'Engine room walls'],
  'Engineering frames': ['Wręgi maszynowni', 'Engine room frames'],
  'Engineering pipes': ['Rurociągi', 'Piping'],
  'Engineering stairs': ['Schody maszynowni', 'Engine room stairs'],
  'Engineering lights': ['Oświetlenie maszynowni', 'Engine room lighting'],
  'Engineering ducts': ['Kanały wentylacyjne', 'Ventilation ducts'],
  'Pumps and auxiliaries': ['Pompy i urządzenia pomocnicze', 'Pumps and auxiliaries'],
  'Engine control room': ['Centrum kontroli maszynowni', 'Engine control room'],
  'Electrical room': ['Rozdzielnia elektryczna', 'Electrical room'],
  'Propulsion pods': ['Pędniki azymutalne', 'Propulsion pods'],
};

export function roomName(lang: Lang, group: string): string {
  const n = NAMES[group];
  if (n) return lang === 'pl' ? n[0] : n[1];
  let m = /^Cabin (\d+)$/.exec(group);
  if (m) return lang === 'pl' ? `Kabina ${m[1]}` : `Cabin ${m[1]}`;
  m = /^Engine (\d+)$/.exec(group);
  if (m) return lang === 'pl' ? `Silnik ${m[1]}` : `Engine ${m[1]}`;
  return group;
}

/** deck label from the group's world box (min/max Y in metres) */
export function deckOf(lang: Lang, minY: number, maxY: number): string {
  const pl = lang === 'pl';
  if (maxY - minY > 9) return pl ? 'Kilka pokładów' : 'Several decks';
  const y = minY + 1;
  if (y < 1) return pl ? 'Maszynownia, pod pokładem 1' : 'Engine room, below deck 1';
  if (y < 7) return pl ? 'Pokład 1' : 'Deck 1';
  if (y < 12.5) return pl ? 'Pokład 2' : 'Deck 2';
  if (y < 16) return pl ? 'Pokład 3' : 'Deck 3';
  if (y < 19.5) return pl ? 'Pokład 4' : 'Deck 4';
  if (y < 24) return pl ? 'Pokład 5' : 'Deck 5';
  return pl ? 'Nad pokładem 5' : 'Above deck 5';
}

export function zoneOfGroup(group: string): ZoneId | null {
  return ZONES.find((z) => z.groups.includes(group))?.id ?? null;
}
