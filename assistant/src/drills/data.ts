// Drill cards for the crew of MF Jantar Unity (ro-pax, Świnoujście - Ystad).
// TRAINING material based on general SOLAS / IMO practice. The ship's Muster List and SMS take precedence.
import type { ZoneId } from '../ship/routes';

export type DrillId = 'fire' | 'abandon' | 'mob' | 'flooding' | 'pollution' | 'blackout' | 'medical';

/** Polish first, English second. */
export interface Txt { pl: string; en: string }

/** One sound of an alarm pattern. whistle = ship's whistle, bell = alarm bells, chime = PA attention gong. */
export interface AlarmStep { tone: 'whistle' | 'bell' | 'chime'; ms: number; gap: number }
/** Machine-readable alarm: `steps` played in order; `bells` = alarm bells ring under the whistle for the whole pattern. */
export interface AlarmPattern { steps: AlarmStep[]; bells?: boolean; demo?: boolean }

export type PhaseId = 'alarm' | 'first' | 'action' | 'end';
export interface Phase { id: PhaseId; title: Txt; items: Txt[] }
export interface Role { name: Txt; task: Txt }

export interface Drill {
  id: DrillId;
  title: Txt;
  summary: Txt;
  /** human-readable alarm signal */
  signal: Txt;
  alarm: AlarmPattern;
  /** fire red instead of safety orange */
  danger?: boolean;
  roles: Role[];
  phases: Phase[];
  /** suggested evacuation zone for the 3D route, null = no route makes sense */
  zone: ZoneId | null;
  blocked: 'stair-aft' | 'stair-fwd' | null;
  /** scenario for the route (where it happens) */
  scenario?: Txt;
  frequency: Txt;
  debrief: Txt[];
}

const t = (pl: string, en: string): Txt => ({ pl, en });
const items = (...pairs: [string, string][]): Txt[] => pairs.map(([pl, en]) => ({ pl, en }));

export const PHASE_TITLES: Record<PhaseId, Txt> = {
  alarm: t('Alarm', 'Alarm'),
  first: t('Pierwsze działania', 'First actions'),
  action: t('Akcja', 'Response'),
  end: t('Zakończenie', 'Close-out'),
};
const phase = (id: PhaseId, its: Txt[]): Phase => ({ id, title: PHASE_TITLES[id], items: its });

// alarm building blocks: short = 1 s, long = 6 s
const S = (tone: AlarmStep['tone'] = 'whistle'): AlarmStep => ({ tone, ms: 1000, gap: 1000 });
const LONG = (tone: AlarmStep['tone'] = 'whistle'): AlarmStep => ({ tone, ms: 6000, gap: 1500 });
const GENERAL: AlarmPattern = { steps: [S(), S(), S(), S(), S(), S(), S(), LONG()], bells: true };

export const DISCLAIMER = t(
  'Materiał szkoleniowy oparty na ogólnej praktyce SOLAS / IMO. Wiążące są Rozkład alarmowy (Muster List) i SMS statku.',
  'Training material based on general SOLAS / IMO practice. The ship\'s Muster List and SMS take precedence.',
);

const ROLE = {
  master: (pl: string, en: string): Role => ({ name: t('Kapitan', 'Master'), task: t(pl, en) }),
  oow: (pl: string, en: string): Role => ({ name: t('Mostek / oficer wachtowy (OOW)', 'Bridge / OOW'), task: t(pl, en) }),
  engine: (pl: string, en: string): Role => ({ name: t('Maszynownia (st. mechanik, wachta)', 'Engine room (Chief Eng., watch)'), task: t(pl, en) }),
  guides: (pl: string, en: string): Role => ({ name: t('Przewodnicy pasażerów', 'Passenger guides'), task: t(pl, en) }),
};

export const DRILLS: Drill[] = [
  {
    id: 'fire',
    danger: true,
    title: t('Pożar', 'Fire'),
    summary: t('Pożar w kabinie na pokładzie D3, rufa. Klatka rufowa odcięta.', 'Fire in a cabin on deck D3 aft. Aft stairway cut off.'),
    signal: t(
      'Alarm pożarowy wg Rozkładu alarmowego, najczęściej ciągłe dzwonienie dzwonków alarmowych + komunikat PA z miejscem pożaru.',
      'Fire alarm as defined on the Muster List, commonly continuous ringing of the alarm bells + PA announcement with the location.',
    ),
    alarm: { steps: [{ tone: 'bell', ms: 10000, gap: 0 }] },
    roles: [
      ROLE.master('Dowodzi z mostka, decyduje o użyciu stałej instalacji (CO2) i o ewakuacji.', 'Commands from the bridge, decides on the fixed system (CO2) and on evacuation.'),
      ROLE.oow('Ogłasza alarm, lokalizuje pożar na panelu, zamyka drzwi pożarowe, zatrzymuje wentylację.', 'Raises the alarm, locates the fire on the panel, closes fire doors, stops ventilation.'),
      { name: t('Grupy pożarowe 1 i 2', 'Fire teams 1 and 2'), task: t('Aparaty oddechowe (BA), węże, rozpoznanie, gaszenie, chłodzenie przegród.', 'Breathing apparatus (BA), hoses, search, firefighting, boundary cooling.') },
      { name: t('Grupa pierwszej pomocy', 'First aid team'), task: t('Punkt opatrunkowy, nosze, przyjmowanie poszkodowanych.', 'First aid post, stretchers, receiving casualties.') },
      ROLE.engine('Pompy pożarowe pod ciśnieniem, odcięcie paliwa i zasilania w strefie.', 'Fire pumps on line, fuel and power isolation in the area.'),
      ROLE.guides('Przeprowadzają pasażerów z zagrożonej strefy na stanowiska zbiórki, liczą osoby.', 'Move passengers out of the affected zone to muster stations, count persons.'),
    ],
    phases: [
      phase('alarm', items(
        ['Zauważasz ogień lub dym: wciśnij najbliższy ręczny ostrzegacz pożarowy', 'Spot fire or smoke: press the nearest manual call point'],
        ['Zgłoś na mostek: miejsce (pokład, strefa, nr kabiny), co się pali, czy są ludzie', 'Report to the bridge: location (deck, zone, cabin no.), what is burning, persons involved'],
        ['Mostek ogłasza alarm pożarowy i komunikat PA z miejscem', 'Bridge sounds the fire alarm and makes a PA announcement with the location'],
      )),
      phase('first', items(
        ['Jeśli bezpiecznie: gaśnica podręczna na ogień w zarodku', 'If safe: portable extinguisher on an incipient fire'],
        ['Zamknij drzwi, drzwi pożarowe i klapy przeciwpożarowe', 'Close doors, fire doors and fire dampers'],
        ['Zatrzymaj wentylację strefy', 'Stop ventilation of the zone'],
        ['Uruchom pompy pożarowe, ciśnienie na magistrali', 'Start fire pumps, pressure on the fire main'],
        ['Zbiórka grup pożarowych z aparatami BA, kontrola aparatów', 'Muster fire teams with BA sets, BA check'],
      )),
      phase('action', items(
        ['Ewakuuj pasażerów i załogę ze strefy, omijając odciętą klatkę', 'Evacuate passengers and crew from the zone, avoiding the cut-off stairway'],
        ['Policz osoby na stanowiskach, zgłoś brakujących', 'Account for persons at stations, report missing'],
        ['Rozpoznanie i gaszenie w parach, kontrola czasu pracy w BA', 'Search and attack in pairs, BA time control'],
        ['Chłodzenie przegród: sąsiednie kabiny, pokład powyżej i poniżej', 'Boundary cooling: adjacent cabins, decks above and below'],
        ['Odetnij zasilanie elektryczne i paliwo w strefie', 'Isolate electrical power and fuel in the zone'],
        ['CO2 / stała instalacja tylko na rozkaz kapitana, po ewakuacji i sprawdzeniu przestrzeni', 'CO2 / fixed system only on the master\'s order, after the space is evacuated and checked'],
      )),
      phase('end', items(
        ['Potwierdź ugaszenie, wyznacz wachtę przeciwpożarową (ponowne zapalenie)', 'Confirm fire out, set a re-ignition watch'],
        ['Przewietrz przestrzeń, pomiar atmosfery przed wejściem bez BA', 'Ventilate the space, test atmosphere before entry without BA'],
        ['Komunikat PA o zakończeniu, odwołanie alarmu', 'PA announcement, stand down'],
        ['Wpis do dziennika okrętowego, uzupełnij butle i sprzęt', 'Log book entry, recharge cylinders and restore equipment'],
      )),
    ],
    zone: 'cabins-aft',
    blocked: 'stair-aft',
    scenario: t('Pożar kabin rufowych, klatka rufowa zablokowana', 'Aft cabin fire, aft stairway blocked'),
    frequency: t(
      'SOLAS III/19 i III/30: na statku pasażerskim ćwiczenie pożarowe co tydzień, każdy członek załogi co najmniej raz w miesiącu; przed wyjściem w morze, jeśli ponad 25% załogi nie ćwiczyło na tym statku w poprzednim miesiącu.',
      'SOLAS III/19 and III/30: on a passenger ship a fire drill weekly, each crew member at least monthly; before departure if more than 25% of the crew have not drilled on this ship in the previous month.',
    ),
    debrief: items(
      ['Ile czasu minęło od alarmu do zgłoszenia gotowości grup pożarowych?', 'How long from alarm to fire teams reporting ready?'],
      ['Czy wszystkie drzwi pożarowe i klapy zamknęły się, a wentylacja stanęła?', 'Did all fire doors and dampers close and did ventilation stop?'],
      ['Czy łączność radiowa grup z mostkiem była czytelna?', 'Was radio communication between teams and the bridge clear?'],
      ['Czy liczenie osób zgadzało się z listą? Kogo brakowało i dlaczego?', 'Did the headcount match the list? Who was missing and why?'],
      ['Czy pasażerów skierowano drogą omijającą odciętą klatkę?', 'Were passengers routed around the cut-off stairway?'],
    ),
  },
  {
    id: 'abandon',
    title: t('Opuszczenie statku', 'Abandon ship'),
    summary: t('Alarm ogólny, zbiórka na stanowiskach, przygotowanie łodzi i tratw.', 'General alarm, muster at stations, prepare boats and rafts.'),
    signal: t(
      'Alarm ogólny: 7 krótkich + 1 długi sygnał gwizdkiem okrętowym i dzwonkami alarmowymi (SOLAS / LSA Code). Rozkaz opuszczenia statku wydaje wyłącznie kapitan, ustnie / przez PA.',
      'General emergency alarm: 7 short + 1 long blasts on the ship\'s whistle and alarm bells (SOLAS / LSA Code). The order to abandon ship is given only by the master, verbally / on PA.',
    ),
    alarm: GENERAL,
    roles: [
      ROLE.master('Decyduje o opuszczeniu statku, wydaje rozkaz, nadzoruje wodowanie.', 'Decides to abandon ship, gives the order, supervises launching.'),
      ROLE.oow('Alarm ogólny, sygnał wzywania pomocy (GMDSS), pozycja, EPIRB i SART.', 'General alarm, distress alert (GMDSS), position, EPIRB and SART.'),
      { name: t('Załogi łodzi i tratw', 'Boat and raft crews'), task: t('Przygotowanie i wodowanie łodzi ratunkowych, tratw i systemu MES.', 'Prepare and launch lifeboats, liferafts and the MES.') },
      { name: t('Dowódcy stanowisk zbiórki', 'Muster station leaders'), task: t('Liczenie osób, kontrola kamizelek, raport na mostek.', 'Headcount, lifejacket check, report to the bridge.') },
      ROLE.guides('Kierują pasażerów oznakowanymi drogami na stanowiska, przeszukują kabiny i toalety.', 'Direct passengers along marked routes to stations, search cabins and toilets.'),
      ROLE.engine('Zasilanie awaryjne, zatrzymanie maszyn na rozkaz, opuszczenie maszynowni.', 'Emergency power, stop engines on order, leave the engine room.'),
    ],
    phases: [
      phase('alarm', items(
        ['Mostek ogłasza alarm ogólny: 7 krótkich + 1 długi', 'Bridge sounds the general alarm: 7 short + 1 long'],
        ['Komunikat PA: zbiórka na stanowiskach, nie korzystać z wind', 'PA announcement: go to muster stations, do not use lifts'],
      )),
      phase('first', items(
        ['Kamizelka ratunkowa, ciepłe ubranie, nakrycie głowy', 'Lifejacket, warm clothing, head cover'],
        ['Zajmij stanowisko wg karty alarmowej (Muster List)', 'Go to your station per the Muster List'],
        ['Przewodnicy przeszukują kabiny i przestrzenie publiczne', 'Guides search cabins and public spaces'],
        ['Zbiórka pasażerów na stanowiskach A (rufa) i B (dziób)', 'Muster passengers at stations A (aft) and B (forward)'],
      )),
      phase('action', items(
        ['Liczenie osób na każdym stanowisku, raport na mostek', 'Headcount at each station, report to the bridge'],
        ['Kontrola kamizelek u pasażerów (zapięte, światło, gwizdek)', 'Check passengers\' lifejackets (fastened, light, whistle)'],
        ['Przygotuj łodzie: korki spustowe, zabezpieczenia, silnik', 'Prepare boats: drain plugs, gripes, engine'],
        ['Na rozkaz kapitana: zaokrętowanie i wodowanie łodzi / tratw / MES', 'On the master\'s order: board and launch boats / rafts / MES'],
        ['Zabierz SART, radiotelefony UKF i EPIRB wg przydziału', 'Take SART, VHF handhelds and EPIRB as assigned'],
      )),
      phase('end', items(
        ['Ćwiczenie: odwołanie alarmu, powrót sprzętu na miejsce', 'Drill: stand down, return equipment'],
        ['Sprawdź łodzie i urządzenia wodujące po ćwiczeniu', 'Check boats and launching appliances after the drill'],
        ['Wpis do dziennika okrętowego', 'Log book entry'],
      )),
    ],
    zone: 'cabins-mid',
    blocked: null,
    scenario: t('Z kabin środkowych na stanowisko zbiórki', 'From mid cabins to a muster station'),
    frequency: t(
      'SOLAS III/19 i III/30: na statku pasażerskim ćwiczenie opuszczenia statku co tydzień, każdy członek załogi co najmniej raz w miesiącu; przed wyjściem, jeśli ponad 25% załogi nie ćwiczyło w poprzednim miesiącu. Każda łódź ratunkowa wodowana z załogą co najmniej raz na 3 miesiące. Pasażerów: odprawa / zbiórka przed lub zaraz po wyjściu (przy rejsie powyżej 24 h), na krótkim rejsie co najmniej komunikat i instrukcje bezpieczeństwa.',
      'SOLAS III/19 and III/30: on a passenger ship an abandon ship drill weekly, each crew member at least monthly; before departure if more than 25% of the crew have not drilled in the previous month. Each lifeboat launched with crew at least every 3 months. Passengers: muster prior to or immediately upon departure (voyages over 24 h); on a short voyage at least a safety announcement and instructions.',
    ),
    debrief: items(
      ['Ile czasu zajęło zebranie i policzenie wszystkich osób?', 'How long did it take to muster and count everyone?'],
      ['Czy wszyscy mieli prawidłowo założone kamizelki i ciepłe ubranie?', 'Did everyone wear lifejackets correctly and warm clothing?'],
      ['Czy alarm był słyszalny we wszystkich przestrzeniach (kabiny, pokład samochodowy, maszynownia)?', 'Was the alarm audible everywhere (cabins, vehicle deck, engine room)?'],
      ['Czy łodzie przygotowano zgodnie z instrukcją, bez skrótów?', 'Were the boats prepared by the instructions, without shortcuts?'],
      ['Jakie problemy z komunikacją z pasażerami (język, osoby z niepełnosprawnością)?', 'Any problems communicating with passengers (language, persons with disabilities)?'],
    ),
  },
  {
    id: 'mob',
    title: t('Człowiek za burtą', 'Man overboard'),
    summary: t('Osoba w wodzie: koło, oznaczenie pozycji, manewr, łódź ratownicza.', 'Person in the water: lifebuoy, mark position, manoeuvre, rescue boat.'),
    signal: t(
      'Okrzyk „Człowiek za burtą, lewa / prawa burta!”, zgłoszenie na mostek. Często 3 długie sygnały gwizdkiem i komunikat PA; dokładny sygnał w Rozkładzie alarmowym.',
      'Shout "Man overboard, port / starboard side!", report to the bridge. Commonly 3 long blasts and a PA announcement; the exact signal is in the Muster List.',
    ),
    alarm: { steps: [LONG(), LONG(), LONG()] },
    roles: [
      ROLE.master('Przejmuje dowodzenie, koordynuje akcję i łączność z MRCC.', 'Takes command, coordinates the response and contact with MRCC.'),
      ROLE.oow('Przycisk MOB na ECDIS / GPS, ster na burtę, manewr Williamsona, sygnał, PAN-PAN / Mayday wg decyzji.', 'MOB button on ECDIS / GPS, wheel over, Williamson turn, signal, PAN-PAN / Mayday as decided.'),
      { name: t('Obserwatorzy', 'Lookouts'), task: t('Stale wskazują osobę w wodzie, nie tracą jej z oczu.', 'Keep pointing at the person, never lose sight.') },
      { name: t('Załoga łodzi ratowniczej', 'Rescue boat crew'), task: t('Przygotowanie i wodowanie łodzi, podjęcie osoby.', 'Prepare and launch the rescue boat, recover the person.') },
      { name: t('Grupa pierwszej pomocy', 'First aid team'), task: t('Przygotowanie na hipotermię i podtopienie.', 'Ready for hypothermia and near-drowning.') },
      ROLE.engine('Gotowość manewrowa maszyn.', 'Engines ready for manoeuvring.'),
    ],
    phases: [
      phase('alarm', items(
        ['Krzycz „Człowiek za burtą” i podaj burtę', 'Shout "Man overboard" and the side'],
        ['Rzuć koło ratunkowe ze światłem i sygnałem dymnym (MOB)', 'Throw a lifebuoy with light and smoke signal (MOB)'],
        ['Wskazuj osobę ręką cały czas', 'Keep pointing at the person all the time'],
        ['Zgłoś na mostek: burta, czas, odległość', 'Report to the bridge: side, time, distance'],
      )),
      phase('first', items(
        ['Wciśnij MOB na ECDIS / GPS, zanotuj czas i pozycję', 'Press MOB on ECDIS / GPS, note time and position'],
        ['Ster na burtę, po której wypadła osoba (odsunięcie rufy)', 'Wheel over to the side the person fell (swing the stern clear)'],
        ['Sygnał alarmowy, komunikat PA, wystaw obserwatorów', 'Sound the alarm, PA announcement, post lookouts'],
        ['Manewr Williamsona (lub inny wg warunków)', 'Williamson turn (or other, as conditions dictate)'],
      )),
      phase('action', items(
        ['Powiadom MRCC i statki w pobliżu (UKF kan. 16 / DSC)', 'Inform MRCC and nearby ships (VHF ch 16 / DSC)'],
        ['Przygotuj łódź ratowniczą, załoga w kombinezonach', 'Prepare the rescue boat, crew in immersion suits'],
        ['Podejdź od nawietrznej, osłoń osobę kadłubem', 'Approach from windward, give a lee'],
        ['Wodowanie łodzi i podjęcie osoby (poziomo, jeśli możliwe)', 'Launch the boat and recover the person (horizontally if possible)'],
        ['Pierwsza pomoc: hipotermia, kontrola oddechu', 'First aid: hypothermia, breathing check'],
      )),
      phase('end', items(
        ['Podjęcie łodzi, zabezpieczenie sprzętu', 'Recover the boat, secure equipment'],
        ['Liczenie osób na statku (kogo brakuje?)', 'Headcount on board (who is missing?)'],
        ['Raport do MRCC, wpis do dziennika okrętowego', 'Report to MRCC, log book entry'],
      )),
    ],
    zone: null,
    blocked: null,
    frequency: t(
      'SOLAS III/19: łódź ratownicza wodowana z załogą co miesiąc, o ile to rozsądnie możliwe, nie rzadziej niż co 3 miesiące. Szczegóły ćwiczeń MOB wg SMS.',
      'SOLAS III/19: rescue boat launched with crew monthly where reasonable and practicable, at least every 3 months. MOB drill details per SMS.',
    ),
    debrief: items(
      ['Ile sekund od okrzyku do wciśnięcia MOB i rzucenia koła?', 'How many seconds from the shout to MOB pressed and lifebuoy thrown?'],
      ['Czy obserwatorzy cały czas widzieli osobę?', 'Did lookouts keep the person in sight the whole time?'],
      ['Czas od alarmu do wodowania łodzi ratowniczej?', 'Time from alarm to rescue boat launched?'],
      ['Czy manewr doprowadził statek z powrotem na ślad torowy?', 'Did the manoeuvre bring the ship back onto its track?'],
      ['Czy łączność z MRCC była poprawna (treść, kanał)?', 'Was the MRCC communication correct (content, channel)?'],
    ),
  },
  {
    id: 'flooding',
    title: t('Wejście wody / przeciek', 'Flooding / leak'),
    summary: t('Woda w maszynowni po uszkodzeniu kadłuba. Kontrola awarii.', 'Water in the engine room after hull damage. Damage control.'),
    signal: t(
      'Wg Rozkładu alarmowego, zwykle alarm ogólny (7 krótkich + 1 długi) i komunikat PA, alarm zęzowy w maszynowni.',
      'Per the Muster List, usually the general alarm (7 short + 1 long) and a PA announcement, bilge alarm in the engine room.',
    ),
    alarm: GENERAL,
    roles: [
      ROLE.master('Ocena stateczności, decyzja o zmianie kursu / prędkości, łączność z MRCC.', 'Stability assessment, course / speed decision, contact with MRCC.'),
      ROLE.oow('Zamknięcie drzwi wodoszczelnych z mostka, kontrola wskazań, alarm.', 'Close watertight doors from the bridge, monitor indicators, alarm.'),
      { name: t('Grupa kontroli awarii', 'Damage control team'), task: t('Lokalizacja przecieku, uszczelnianie, podpory, sondowanie.', 'Locate the leak, plug, shore up, take soundings.') },
      ROLE.engine('Pompy zęzowe, odcięcie zaworów, zabezpieczenie urządzeń elektrycznych.', 'Bilge pumps, isolate valves, protect electrical equipment.'),
      ROLE.guides('Utrzymanie pasażerów z dala od strefy, przygotowanie do zbiórki.', 'Keep passengers away from the zone, prepare to muster.'),
    ],
    phases: [
      phase('alarm', items(
        ['Zgłoś na mostek: miejsce, skąd woda, jak szybko przybywa', 'Report to the bridge: location, source, how fast it rises'],
        ['Mostek ogłasza alarm i komunikat PA', 'Bridge sounds the alarm and makes a PA announcement'],
      )),
      phase('first', items(
        ['Zamknij drzwi wodoszczelne (sprawdź, że nikt nie zostaje w przejściu)', 'Close watertight doors (check no one is in the doorway)'],
        ['Uruchom pompy zęzowe', 'Start bilge pumps'],
        ['Odetnij zawory i rurociągi w uszkodzonej strefie', 'Isolate valves and pipes in the damaged area'],
        ['Policz osoby w strefie, ewakuuj zagrożonych', 'Account for persons in the zone, evacuate those at risk'],
      )),
      phase('action', items(
        ['Zlokalizuj przeciek, uszczelnij (kliny, poduszki, zestaw do łatania)', 'Locate the leak, plug it (wedges, pads, patch kit)'],
        ['Sondowanie zbiorników i przestrzeni sąsiednich', 'Sound tanks and adjacent spaces'],
        ['Ocena stateczności, przechyłu i przegłębienia (komputer ładunkowy)', 'Assess stability, list and trim (loading computer)'],
        ['Rozważ zmianę kursu / prędkości, powiadom MRCC', 'Consider course / speed change, inform MRCC'],
        ['Gotowość do alarmu opuszczenia statku', 'Be ready for abandon ship'],
      )),
      phase('end', items(
        ['Potwierdź opanowanie przecieku, wachta przy uszczelnieniu', 'Confirm leak under control, watch on the repair'],
        ['Raport do armatora, wpis do dziennika okrętowego', 'Report to the company, log book entry'],
      )),
    ],
    zone: 'engine-room',
    blocked: null,
    scenario: t('Ewakuacja z maszynowni', 'Evacuation from the engine room'),
    frequency: t(
      'SOLAS II-1/19-1: na statku pasażerskim ćwiczenie kontroli awarii (damage control) co najmniej co 3 miesiące. Drzwi wodoszczelne: ćwiczenie co tydzień, codzienna próba działania (SOLAS II-1/21).',
      'SOLAS II-1/19-1: on a passenger ship a damage control drill at least every 3 months. Watertight doors: weekly drill, daily operation test (SOLAS II-1/21).',
    ),
    debrief: items(
      ['Ile czasu zajęło zamknięcie wszystkich drzwi wodoszczelnych?', 'How long did it take to close all watertight doors?'],
      ['Czy wskazania na mostku zgadzały się ze stanem faktycznym?', 'Did bridge indications match the real state?'],
      ['Czy grupa wiedziała, gdzie jest sprzęt do uszczelniania?', 'Did the team know where the plugging equipment is?'],
      ['Czy informacja o stateczności dotarła do kapitana na czas?', 'Did stability information reach the master in time?'],
    ),
  },
  {
    id: 'pollution',
    title: t('Rozlew olejowy', 'Oil spill'),
    summary: t('Wyciek paliwa przy bunkrowaniu lub z kadłuba. Plan SOPEP.', 'Fuel leak during bunkering or from the hull. SOPEP plan.'),
    signal: t(
      'Wg Rozkładu alarmowego i SOPEP, zwykle komunikat PA / UKF wewnętrzny do grupy SOPEP. Demonstracja: gong ogłoszeniowy.',
      'Per the Muster List and SOPEP, usually a PA / internal VHF call to the SOPEP team. Demo: PA attention chime.',
    ),
    alarm: { steps: [{ tone: 'chime', ms: 1600, gap: 600 }, { tone: 'chime', ms: 1600, gap: 0 }], demo: true },
    roles: [
      ROLE.master('Decyzje, zgłoszenie do państwa nadbrzeżnego / portu wg SOPEP.', 'Decisions, report to the coastal state / port per SOPEP.'),
      ROLE.oow('Zgłoszenie, rejestr zdarzeń, łączność z portem / VTS.', 'Reporting, event record, contact with port / VTS.'),
      { name: t('Grupa SOPEP', 'SOPEP team'), task: t('Sorbenty, zatkanie odpływów, zbieranie oleju, środki ochrony.', 'Sorbents, plug scuppers, collect oil, PPE.') },
      ROLE.engine('Zatrzymanie pomp / bunkrowania, przepompowanie do pustego zbiornika.', 'Stop pumps / bunkering, transfer to an empty tank.'),
    ],
    phases: [
      phase('alarm', items(
        ['Zatrzymaj bunkrowanie / przepompowywanie', 'Stop bunkering / transfer'],
        ['Zgłoś na mostek i do maszynowni: miejsce, rodzaj paliwa, ilość', 'Report to the bridge and engine room: location, fuel type, quantity'],
      )),
      phase('first', items(
        ['Zamknij zawory, odetnij źródło', 'Close valves, stop the source'],
        ['Zatkaj odpływy pokładowe (scuppers)', 'Plug the deck scuppers'],
        ['Zakaz palenia i źródeł zapłonu w strefie', 'No smoking or ignition sources in the area'],
        ['Grupa SOPEP: środki ochrony osobistej, zestaw SOPEP', 'SOPEP team: PPE, SOPEP kit'],
      )),
      phase('action', items(
        ['Zbieraj olej sorbentami, nie spłukuj za burtę', 'Collect oil with sorbents, do not wash overboard'],
        ['Przepompuj z uszkodzonego zbiornika do pustego', 'Transfer from the damaged tank to an empty one'],
        ['Zgłoś wg SOPEP: państwo nadbrzeżne, port, armator', 'Report per SOPEP: coastal state, port, company'],
      )),
      phase('end', items(
        ['Odpady olejowe do oznaczonych pojemników', 'Oily waste into marked containers'],
        ['Wpis do Książki zapisów olejowych i dziennika okrętowego', 'Oil Record Book and log book entry'],
        ['Uzupełnij zestaw SOPEP', 'Restock the SOPEP kit'],
      )),
    ],
    zone: null,
    blocked: null,
    frequency: t(
      'MARPOL Załącznik I / SOPEP: ćwiczenia wg SMS statku, w praktyce zwykle co 3 miesiące.',
      'MARPOL Annex I / SOPEP: drills per the ship\'s SMS, commonly every 3 months.',
    ),
    debrief: items(
      ['Ile czasu od zauważenia do zatrzymania pomp?', 'How long from detection to pumps stopped?'],
      ['Czy odpływy zatkano zanim olej doszedł do burty?', 'Were scuppers plugged before oil reached the side?'],
      ['Czy zestaw SOPEP był kompletny i na miejscu?', 'Was the SOPEP kit complete and in place?'],
      ['Czy wiadomo, kogo i w jakiej kolejności zawiadomić?', 'Was it clear whom to notify and in what order?'],
    ),
  },
  {
    id: 'blackout',
    title: t('Zanik zasilania', 'Blackout'),
    summary: t('Utrata zasilania głównego w morzu. Generator awaryjny, sterowanie.', 'Loss of main power at sea. Emergency generator, steering.'),
    signal: t(
      'Alarm maszynowy i komunikat z mostka / maszynowni wg Rozkładu alarmowego. Demonstracja: gong ogłoszeniowy.',
      'Engine room alarm and a bridge / engine room announcement per the Muster List. Demo: PA attention chime.',
    ),
    alarm: { steps: [{ tone: 'chime', ms: 1600, gap: 600 }, { tone: 'chime', ms: 1600, gap: 0 }], demo: true },
    roles: [
      ROLE.master('Ocena sytuacji nawigacyjnej, sygnały statku nieodpowiadającego za swoje ruchy, MRCC / VTS.', 'Assess the navigational situation, not-under-command signals, MRCC / VTS.'),
      ROLE.oow('Sterowanie awaryjne, światła NUC, ostrzeżenie statków w pobliżu.', 'Emergency steering, NUC lights, warn nearby ships.'),
      ROLE.engine('Kontrola startu generatora awaryjnego, przywrócenie zasilania głównego.', 'Check emergency generator start, restore main power.'),
      ROLE.guides('Uspokojenie pasażerów, latarki, obecność w przestrzeniach publicznych.', 'Reassure passengers, torches, presence in public spaces.'),
    ],
    phases: [
      phase('alarm', items(
        ['Mostek: zgłoszenie do maszynowni, komunikat PA dla pasażerów', 'Bridge: call the engine room, PA announcement for passengers'],
        ['Sprawdź start generatora awaryjnego (statek pasażerski: do 45 s)', 'Check the emergency generator started (passenger ship: within 45 s)'],
      )),
      phase('first', items(
        ['Oświetlenie awaryjne i podłogowe znaki ewakuacyjne działają', 'Emergency lighting and low-location lighting working'],
        ['Sterowanie awaryjne (ster z przedziału maszyny sterowej, jeśli trzeba)', 'Emergency steering (from the steering gear room if needed)'],
        ['Światła / sygnały statku nieodpowiadającego za swoje ruchy, ostrzeżenie na UKF', 'Not-under-command lights / signals, VHF warning'],
        ['Windy: sprawdź, czy nikt nie utknął', 'Lifts: check that no one is trapped'],
      )),
      phase('action', items(
        ['Ustal przyczynę, przywróć zasilanie główne wg procedury', 'Find the cause, restore main power by procedure'],
        ['Załączaj odbiorniki stopniowo (najpierw ster, pompy, nawigacja)', 'Reconnect consumers step by step (steering, pumps, navigation first)'],
        ['Przewodnicy w przestrzeniach publicznych, informacja dla pasażerów', 'Guides in public spaces, information for passengers'],
        ['Rozważ kotwiczenie / pomoc holowniczą przy zagrożeniu wejściem na mieliznę', 'Consider anchoring / tug assistance if grounding risk'],
      )),
      phase('end', items(
        ['Sprawdź wszystkie systemy (nawigacja, alarmy, pompy pożarowe)', 'Check all systems (navigation, alarms, fire pumps)'],
        ['Komunikat PA o powrocie do normalnej pracy', 'PA announcement, normal operation resumed'],
        ['Wpis do dziennika okrętowego i maszynowego', 'Deck and engine log entries'],
      )),
    ],
    zone: 'reclining-lounge',
    blocked: null,
    scenario: t('Pasażerowie w ciemnym salonie, oświetlenie awaryjne', 'Passengers in a dark lounge, emergency lighting'),
    frequency: t(
      'SOLAS V/26: ćwiczenie sterowania awaryjnego co najmniej co 3 miesiące. Źródło awaryjne statku pasażerskiego startuje automatycznie w 45 s (SOLAS II-1/42). Ćwiczenie blackoutu wg SMS.',
      'SOLAS V/26: emergency steering drill at least every 3 months. A passenger ship\'s emergency source starts automatically within 45 s (SOLAS II-1/42). Blackout drill per SMS.',
    ),
    debrief: items(
      ['Ile czasu do startu generatora awaryjnego i do przywrócenia zasilania głównego?', 'Time to emergency generator start and to main power restored?'],
      ['Czy oświetlenie awaryjne działało we wszystkich przestrzeniach?', 'Did emergency lighting work in all spaces?'],
      ['Czy przejście na sterowanie awaryjne było płynne?', 'Was the change to emergency steering smooth?'],
      ['Jak zareagowali pasażerowie, czy komunikat był jasny?', 'How did passengers react, was the announcement clear?'],
    ),
  },
  {
    id: 'medical',
    title: t('Nagły wypadek medyczny', 'Medical emergency'),
    summary: t('Pasażer nieprzytomny w restauracji. Grupa medyczna, TMAS.', 'Unconscious passenger in the restaurant. Medical team, TMAS.'),
    signal: t(
      'Komunikat PA / UKF wewnętrzny wzywający grupę medyczną (często hasło umowne) wg Rozkładu alarmowego. Demonstracja: gong ogłoszeniowy.',
      'PA / internal VHF call for the medical team (often a code phrase) per the Muster List. Demo: PA attention chime.',
    ),
    alarm: { steps: [{ tone: 'chime', ms: 1600, gap: 600 }, { tone: 'chime', ms: 1600, gap: 0 }], demo: true },
    roles: [
      ROLE.master('Decyzja o zmianie kursu, ewakuacji medycznej (śmigłowiec), kontakt z TMAS / MRCC.', 'Decides on diversion, medevac (helicopter), contact with TMAS / MRCC.'),
      ROLE.oow('Wezwanie grupy, łączność, przygotowanie lądowiska / strefy podjęcia śmigłowca.', 'Call the team, communications, prepare the helicopter winching area.'),
      { name: t('Grupa pierwszej pomocy / oficer medyczny', 'First aid team / medical officer'), task: t('Ocena ABC, resuscytacja, AED, tlen, dokumentacja.', 'ABC assessment, CPR, AED, oxygen, records.') },
      ROLE.guides('Odgrodzenie miejsca, zapewnienie przejścia, opieka nad osobami towarzyszącymi.', 'Clear the area, keep a passage open, look after companions.'),
    ],
    phases: [
      phase('alarm', items(
        ['Sprawdź bezpieczeństwo miejsca, wołaj o pomoc', 'Check the scene is safe, call for help'],
        ['Zgłoś na mostek: miejsce, stan osoby (przytomna? oddycha?)', 'Report to the bridge: location, condition (conscious? breathing?)'],
        ['Mostek wzywa grupę medyczną przez PA / UKF', 'Bridge calls the medical team on PA / VHF'],
      )),
      phase('first', items(
        ['Ocena: przytomność, drogi oddechowe, oddech', 'Assess: response, airway, breathing'],
        ['Brak oddechu: RKO 30:2, przynieś AED', 'Not breathing: CPR 30:2, bring the AED'],
        ['AED: włącz i wykonuj polecenia', 'AED: switch on and follow the prompts'],
      )),
      phase('action', items(
        ['Tlen, pozycja bezpieczna, kontrola funkcji życiowych', 'Oxygen, recovery position, monitor vital signs'],
        ['Konsultacja TMAS (porada medyczna drogą radiową)', 'TMAS consultation (radio medical advice)'],
        ['Kapitan: decyzja o medevacu lub zmianie kursu', 'Master: decision on medevac or diversion'],
        ['Dokumentuj czasy, leki i parametry', 'Record times, medication and vital signs'],
      )),
      phase('end', items(
        ['Przekazanie pacjenta służbom medycznym z dokumentacją', 'Hand over the patient to medical services with records'],
        ['Uzupełnij apteczkę, AED i tlen', 'Restock the medical kit, AED and oxygen'],
        ['Wpis do dziennika okrętowego, raport do armatora', 'Log book entry, report to the company'],
      )),
    ],
    zone: null,
    blocked: null,
    frequency: t(
      'Ćwiczenia medyczne wg SMS statku (Kodeks ISM). Szkolenie wg STCW (pierwsza pomoc / opieka medyczna).',
      'Medical drills per the ship\'s SMS (ISM Code). Training per STCW (first aid / medical care).',
    ),
    debrief: items(
      ['Ile czasu od zgłoszenia do przybycia grupy z AED?', 'Time from report to the team arriving with the AED?'],
      ['Czy wszyscy znali miejsce AED i tlenu?', 'Did everyone know where the AED and oxygen are?'],
      ['Czy konsultacja TMAS była sprawna (dane pacjenta, pozycja)?', 'Was the TMAS consultation efficient (patient data, position)?'],
      ['Czy miejsce było odgrodzone, a pasażerowie pod kontrolą?', 'Was the area cleared and passengers controlled?'],
    ),
  },
];

export const DRILL_BY_ID: Record<DrillId, Drill> = Object.fromEntries(DRILLS.map((d) => [d.id, d])) as Record<DrillId, Drill>;
