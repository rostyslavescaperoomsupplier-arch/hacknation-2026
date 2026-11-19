import type { Lang } from './types';

/** a big shortcut on the assistant's home: sends `q`, or puts `prefill` into the field and focuses it */
export interface QuickAction { id: 'fire' | 'alarm' | 'route' | 'where'; label: string; sub: string; q?: string; prefill?: string }

// Contact shown when the assistant cannot help: the bridge / officer on watch.
// TODO: replace with the real internal extension and phone from the ship's contact list (placeholder for the demo).
export const CONTACT = { tel: '100', telLabel: 'Mostek (wewn.) 100', telLabelEn: 'Bridge (ext.) 100' };

const pl = {
  // app shell
  app_kicker: 'Asystent załogi · szkolenie',
  lang_label: 'Język',
  tabs_label: 'Sekcje aplikacji',
  tab_assistant: 'Asystent',
  tab_ship: 'Statek 3D',
  tab_evac: 'Ewakuacja',
  tab_drills: 'Ćwiczenia',
  loading: 'Ładowanie…',
  tab_comms: 'Łączność',
  tab_alarms: 'Alarmy',
  night: 'Tryb nocny (mostek)',
  night_short: 'Noc',
  night_on: 'Tryb nocny włączony: czerwone, przyciemnione światło chroni widzenie nocne.',
  night_off: 'Tryb nocny wyłączony.',
  // chat
  title: 'Asystent załogi',
  hello: 'Dzień dobry, tu Mewka, asystentka szkoleniowa załogi MF Jantar Unity. Nie jestem człowiekiem. Pomogę przypomnieć procedury awaryjne, pokażę drogę ewakuacji i otworzę ćwiczenie. W prawdziwym zagrożeniu obowiązują polecenia kapitana i Muster List.',
  log_label: 'Rozmowa z asystentką',
  input_label: 'Twoje pytanie',
  placeholder: 'Zapytaj o procedurę…',
  send: 'Wyślij',
  suggestions: 'Przykładowe pytania',
  sugg: [
    'Co robić przy pożarze w kabinach na rufie?',
    'Pokaż drogę ewakuacji z maszynowni',
    'Jak przeprowadzić ćwiczenie człowiek za burtą?',
    'Jaki jest sygnał alarmu ogólnego?',
  ],
  you: 'Ty',
  bot: 'Mewka',
  thinking: 'Mewka sprawdza procedury…',
  source: 'Źródło',
  sources: 'Źródła',
  clear: 'Wyczyść rozmowę',
  call: 'Zadzwoń',
  write: 'Napisz e-mail',
  actions: 'Proponowane działania',
  act_route: 'Pokaż drogę ewakuacji:',
  act_drill: 'Otwórz ćwiczenie:',
  rodo_title: 'Prywatność',
  rodo: 'Materiał szkoleniowy wg ogólnej praktyki SOLAS / IMO, nie zastępuje Muster List ani SMS statku. Nie podawaj danych osobowych; rozmowa znika po odświeżeniu.',
  rodo_short: 'Nie podawaj danych osobowych.',
  ai_badge: 'Asystent AI · materiał szkoleniowy',
  offline: 'Nie mogę teraz połączyć się z serwerem asystenta. Spróbuj za chwilę albo zapytaj oficera wachtowego.',
  // home hero (Mewka in the middle of the Asystent tab)
  hero_hello: 'Cześć, jestem Mewka. Przypomnę procedury awaryjne, pokażę drogę ewakuacji i otworzę ćwiczenie. Napisz albo naciśnij mikrofon i powiedz.',
  hero_note: 'Jestem programem, nie człowiekiem. W prawdziwym zagrożeniu słuchaj kapitana i Muster List.',
  qa_title: 'Na skróty',
  qa: [
    { id: 'fire', label: 'Pożar — co robić?', sub: 'Pierwsze działania i sygnał', q: 'Pożar na statku: co mam robić?' },
    { id: 'alarm', label: 'Alarm ogólny', sub: 'Sygnał i co wtedy robić', q: 'Jaki jest sygnał alarmu ogólnego i co wtedy robić?' },
    { id: 'route', label: 'Droga ewakuacji', sub: 'Do punktu zbiórki', q: 'Pokaż drogę ewakuacji do punktu zbiórki' },
    { id: 'where', label: 'Gdzie jest…?', sub: 'Osoba albo miejsce', prefill: 'Gdzie jest ' },
  ] as QuickAction[],
};
type Dict = typeof pl;

const en: Dict = {
  app_kicker: 'Crew assistant · training',
  lang_label: 'Language',
  tabs_label: 'App sections',
  tab_assistant: 'Assistant',
  tab_ship: '3D ship',
  tab_evac: 'Evacuation',
  tab_drills: 'Drills',
  loading: 'Loading…',
  tab_comms: 'Comms',
  tab_alarms: 'Alarms',
  night: 'Night mode (bridge)',
  night_short: 'Night',
  night_on: 'Night mode on: dim red light preserves night vision.',
  night_off: 'Night mode off.',
  title: 'Crew assistant',
  hello: "Hello, this is Mewka, the training assistant for the crew of MF Jantar Unity. I'm not a human. I can help you revise emergency procedures, show an evacuation route and open a drill. In a real emergency, the master's orders and the Muster List apply.",
  log_label: 'Conversation with the assistant',
  input_label: 'Your question',
  placeholder: 'Ask about a procedure…',
  send: 'Send',
  suggestions: 'Example questions',
  sugg: [
    'What to do in a fire in the aft cabins?',
    'Show the evacuation route from the engine room',
    'How do I run a man overboard drill?',
    'What is the general alarm signal?',
  ],
  you: 'You',
  bot: 'Mewka',
  thinking: 'Mewka is checking the procedures…',
  source: 'Source',
  sources: 'Sources',
  clear: 'Clear conversation',
  call: 'Call',
  write: 'Send an e-mail',
  actions: 'Suggested actions',
  act_route: 'Show evacuation route:',
  act_drill: 'Open drill:',
  rodo_title: 'Privacy',
  rodo: "Training material based on general SOLAS / IMO practice; it does not replace the ship's Muster List or SMS. Do not share personal data; the conversation disappears on reload.",
  rodo_short: 'Please do not share personal data.',
  ai_badge: 'AI assistant · training material',
  offline: "I can't reach the assistant server right now. Try again in a moment or ask the officer on watch.",
  hero_hello: "Hi, I'm Mewka. I'll go over emergency procedures with you, show an evacuation route and open a drill. Type, or press the microphone and speak.",
  hero_note: "I'm a program, not a person. In a real emergency, follow the master and the Muster List.",
  qa_title: 'Shortcuts',
  qa: [
    { id: 'fire', label: 'Fire: what to do?', sub: 'First actions and the signal', q: 'Fire on board: what do I do?' },
    { id: 'alarm', label: 'General alarm', sub: 'The signal and what to do', q: 'What is the general alarm signal and what do I do then?' },
    { id: 'route', label: 'Evacuation route', sub: 'To the muster station', q: 'Show the evacuation route to the muster station' },
    { id: 'where', label: 'Where is…?', sub: 'A person or a place', prefill: 'Where is ' },
  ],
};

// de / uk fall back to English (contract: Polish first, English second).
export const STR: Record<Lang, Dict> = { pl, en, de: en, uk: en };

export const contactLabel = (lang: Lang) => (lang === 'pl' ? CONTACT.telLabel : CONTACT.telLabelEn);
