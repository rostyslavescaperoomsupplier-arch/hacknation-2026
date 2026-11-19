# System alarmowy (MF Jantar Unity, asystent załogi)

Mostek ogłasza alarm, każdy terminal na statku pokazuje go od razu na pełnym ekranie, a załoga go potwierdza.
Centrala to serwer asystenta (`assistant/server/index.ts`). Terminale łączą się z nim przez WebSocket.

Wersja demonstracyjna na hackathon. Nie zastępuje instalacji alarmowej statku, Rozkładu alarmowego (Muster List) ani poleceń kapitana.

## Pliki

| Plik | Co robi |
|---|---|
| `assistant/shared/alarms.ts` | `ALARM_KINDS`, nazwy PL/EN, typy (`Alarm`, `AlarmState`, `Muster`, ...), protokół (`ClientMsg`, `ServerMsg`), `musterFor()` |
| `assistant/server/alarms.ts` | `attachAlarms(server)` (WebSocket `/api/alarms/ws`), `handleAlarmHttp(req, res)` (GET state/log), zapis dziennika |
| `assistant/src/alarm/AlarmProvider.tsx` | kontekst: połączenie, tożsamość terminala, aktywny alarm, dziennik, `raise/ack/end`; `useAlarms()` |
| `assistant/src/alarm/AlarmOverlay.tsx` | pełnoekranowy alarm (`role="alertdialog"`) + pasek po potwierdzeniu |
| `assistant/src/alarm/AlarmPanel.tsx` | karta „Alarmy”: konsola mostka, status załogi, rozliczenie stanu osób, dziennik + CSV, ustawienia terminala |
| `assistant/src/alarm/kinds.ts` | dźwięk (wzorce z `src/drills`), 3 natychmiastowe działania na rodzaj alarmu |
| `assistant/tests/alarms.test.ts` | testy (node:test) |

## Rodzaje alarmów

`general` (alarm ogólny: 7 krótkich + 1 długi), `fire`, `abandon`, `mob`, `flooding`, `pollution`, `blackout`, `medical`, `security`.
Dźwięk i 3 pierwsze działania pochodzą z kart ćwiczeń (`src/drills/data.ts`, faza „Pierwsze działania”); `general` i `security` mają własne listy.

## Role

- `bridge` (mostek): może ogłosić alarm (ćwiczenie i prawdziwy) oraz go zakończyć.
- `crew` (załoga): odbiera alarm i potwierdza. Może dopisać kto zgłasza i liczbę osób przy terminalu.

Rolę wybiera się na terminalu (karta Alarmy → Ten terminal → Zmień). **To nie jest uwierzytelnianie.** Każdy, kto otworzy stronę, może ustawić rolę mostka. Przed prawdziwym użyciem rola mostka musi być za poświadczeniami terminala (poza paczką JS) albo listą adresów sieci statku w nginx.

Tożsamość terminala korzysta z tego samego wpisu `localStorage` co łączność wideo (`crew-terminal`: nazwa, kod terminala z bazy załogi, kod pomieszczenia), więc terminal ma jedną nazwę w całej aplikacji. Część tylko dla alarmów (rola, strefa, wygenerowany identyfikator `W-...` dla terminali spoza bazy) jest w `alarm-terminal`. Nieskonfigurowana przeglądarka też się łączy (jako `crew`, nazwa „Terminal XXXX”), więc alarm dociera na każdy ekran.

## Protokół WebSocket `/api/alarms/ws`

Ramki tekstowe JSON. Typy w `shared/alarms.ts`.

Terminal → centrala:

```
hello { terminalId, name, role: 'bridge'|'crew', zone?: strefa|'boat-deck'|null, place?: 'D4-01'|null }
raise { kind, zone: strefa|null, blocked: 'stair-aft'|'stair-fwd'|null, message, drill: boolean, confirm?: true }
ack   { alarmId, user?, headcount? }
end   { alarmId }
ping
```

Centrala → terminal:

```
welcome { terminalId, role, state }            po hello (pełny stan: działa też po ponownym połączeniu)
state   { state, reason: 'raised'|'ack'|'ended'|'terminals'|'muster' }   po każdej zmianie, do wszystkich
pong    { now }
error   { code, message }   code: unknown|json|invalid|not-hello|hello-twice|forbidden|confirm|no-alarm|rate|too-long
```

`state = { active: Alarm|null, muster: Muster|null, terminals: TerminalInfo[], now }`.

Zasady:
- `hello` w ciągu 10 s, inaczej zamknięcie (1008). Zmiana roli/nazwy = nowe połączenie.
- `raise` i `end` tylko z rolą `bridge` (`forbidden`). Prawdziwy alarm (`drill: false`) wymaga `confirm: true` (`confirm`); UI ma osobny krok potwierdzenia.
- Jeden aktywny alarm. Nowy kończy poprzedni (`endReason: 'replaced'`) i oba zostają w dzienniku.
- Terminal, który ogłosił alarm, jest od razu potwierdzony (czas reakcji 0).
- `ack` każdy terminal; pierwszy zapisuje czas (czas reakcji = `ack.at - alarm.at`), kolejne mogą tylko dopisać `user` / `headcount`.
- `message` maks. 200 znaków (dłuższy = `too-long`, nie jest obcinany), znaki sterujące usuwane. `user` maks. 40, `headcount` 0..999, nazwa 2..40.

Alarm: `{ id, kind, zone, blocked, message, drill, raisedBy, raisedById, at, endedAt, endedBy?, endReason?, acks: { [terminalId]: { at, name, zone?, user?, headcount? } } }`.

## HTTP

- `GET /api/alarms/state` → `AlarmState`
- `GET /api/alarms/log?limit=1..1000` (domyślnie 100) → `{ alarms: Alarm[] }`, od najnowszego, aktywny też.

Ten sam test Origin i `x-assistant-token` co czat, osobny limit 60 / min / IP, CORS jak `/api/crew/*`.

## Rozliczenie stanu osób (muster)

Dla aktywnego alarmu centrala liczy dla każdej strefy:
- `expected`: osoby zameldowane w strefie (baza załogi `/api/rooms` przez `crew.ts`, pomieszczenia → strefy wg `shared/crew-map.ts`); `null` gdy baza nie odpowiada,
- `terminals`: terminale online w strefie, `acked`: potwierdzenia z tej strefy, `reported`: suma zgłoszonych `headcount`.

Strefy są pogrupowane wg punktu zbiórki (`musterFor(zone, blocked)`: ta sama reguła co trasy ewakuacji w `src/ship/routes.ts`, z uwzględnieniem zablokowanej klatki). Tabela jest przeliczana po każdej zmianie i co 10 s.

## Limity i niezawodność

- Origin jak w czacie (`originAllowed` z `guard.ts`), połączeń razem 200 / z jednego IP 40, ramka maks. 4 KB (większa = zamknięcie 1009).
- Limit na połączenie: 20 ramek naraz, 5 / s (potem `rate`, po 30 naruszeniach zamknięcie 1008); `raise`: 4 naraz, potem 1 / 5 s.
- Heartbeat: ping co 25 s, martwe gniazda zamykane; klient wysyła `ping` co 20 s i łączy się ponownie z narastającą przerwą (1..15 s) oraz od razu po powrocie sieci / ekranu.
- Dziennik: `assistant/server/data/alarms.json` (zmienna `ALARMS_FILE`), zapis z opóźnieniem 0,5 s przez plik tymczasowy + rename, maks. 1000 wpisów. Alarm aktywny przetrwa restart serwera.
- Zmienne do strojenia (głównie testy): `ALARMS_MAX_CONNECTIONS`, `ALARMS_MAX_PER_IP`, `ALARMS_MSG_BURST`, `ALARMS_MSG_PER_SEC`, `ALARMS_RAISE_BURST`, `ALARMS_HTTP_PER_MIN`, `ALARMS_HEARTBEAT_MS`, `ALARMS_MUSTER_MS`, `ALARMS_SAVE_MS`.

**Wspólne zdarzenie `upgrade`.** Nasłuch w `crew-video.ts` niszczy każde gniazdo o innej ścieżce niż `/crew-video-ws`. Dlatego `attachAlarms()` przejmuje `upgrade`: obsługuje `/api/alarms/ws`, a resztę przekazuje dotychczasowym nasłuchom (także dodanym później). Kolejność wywołań w `index.ts` jest więc obojętna; test sprawdza, że oba WebSockety działają razem. nginx (`location /` z `Upgrade`) i proxy vite (`/api` z `ws: true`) już przepuszczają tę ścieżkę.

## Podłączenie (dla leada)

`assistant/server/index.ts` (3 linie):

```ts
import { attachAlarms, handleAlarmHttp } from './alarms.ts';
// w handlerze createServer, przed `if (url.startsWith('/api/')) return send(res, 404, ...)`:
    if (await handleAlarmHttp(req, res)) return;
// obok attachCrewVideoWebSocket(server):
attachAlarms(server);
```

`assistant/src/App.tsx`:

```tsx
import { AlarmProvider, AlarmOverlay } from './alarm';
const AlarmPanel = lazy(() => import('./alarm/AlarmPanel'));

// Tab: dodać 'alarmy' do type Tab, TABS, tabRefs ({ ..., alarmy: null }), label ({ alarmy: lang === 'pl' ? 'Alarmy' : 'Alarms' })
// i ikonę, np. TAB_ICON.alarmy = ['M12 3.5 21 19.5H3Z', 'M12 9.5v4.5', 'M12 16.8v.2'] (pasek ma wtedy 6 kolumn: grid-cols-6).

// return: całość w providerze, overlay raz w korzeniu (wewnątrz .app, żeby pasek po potwierdzeniu widział zmienne CSS):
<AlarmProvider>
  <div className="app min-h-dvh" ...>
    ...header, main...
    <section id="panel-alarmy" role="tabpanel" aria-labelledby="tab-alarmy" hidden={tab !== 'alarmy'}
             className="mx-auto max-w-6xl px-4 py-4">
      {seen.has('alarmy') && <Suspense fallback={fallback}><AlarmPanel lang={lang} /></Suspense>}
    </section>
    ...
    <AlarmOverlay lang={lang} onShowRoute={(z, b) => showRoute(z, b)} onOpenPanel={() => setTab('alarmy')} />
    <MotionCues lang={lang} />
  </div>
</AlarmProvider>
```

`AlarmProvider` musi być nad `AlarmOverlay` i `AlarmPanel`. Overlay ma `z-[100]` (nad wszystkim, także nad dialogiem połączenia wideo), pasek `z-[60]`; gdy pasek jest widoczny, `html[data-alarm-banner]` przesuwa `.app-header` o 48 px w dół (`src/alarm/alarm.css`).

## Dostępność i ruch

- Overlay: `role="alertdialog"`, `aria-modal`, fokus na tytule, pułapka fokusu (Tab/Shift+Tab). Escape nigdy nie zamyka prawdziwego alarmu; przy ćwiczeniu Escape = potwierdzenie.
- Przyciski min. 48 px, „Potwierdzam” 56 px. Pasek „ĆWICZENIE” pomarańczowy w ukośne pasy, „ALARM RZECZYWISTY” czerwony; pulsuje 1 Hz (tylko przyciemnienie, bez migania), wyłączone przy `prefers-reduced-motion`.
- Dźwięk: `playAlarm` z `src/drills/alarm.ts` w pętli do potwierdzenia. Gdy przeglądarka blokuje autoodtwarzanie (brak gestu użytkownika), pojawia się przycisk „Włącz dźwięk alarmu”.

## Testy

```
cd assistant && node --experimental-strip-types --test tests/alarms.test.ts
```

Uprząż: serwer http + `attachAlarms` + `handleAlarmHttp` + prawdziwy `attachCrewVideoWebSocket`, sztuczna baza załogi. Sprawdzają: odmowę dla roli crew i wymóg `confirm`, ogłoszenie przez mostek i rozesłanie do 2 terminali, potwierdzenie z czasem reakcji i liczbą osób, tabelę rozliczenia, zakończenie, zastąpienie alarmu, migawkę stanu dla spóźnionego terminala, zapis dziennika (HTTP + plik), walidację, za dużą ramkę (1009), obcy Origin (403), limit na połączenie i współistnienie z WebSocketem wideo.

## Otwarte sprawy

- Brak uwierzytelniania roli mostka (patrz wyżej).
- Terminale z tym samym kodem z bazy (dwie przeglądarki jako T-D4-01-A) dzielą jedno potwierdzenie.
- Oczekiwana liczba osób to zameldowania czytnikami, nie Muster List; przy nieaktualnych zameldowaniach liczby będą odbiegać.
- Dziennik jest w pliku JSON na jednym serwerze; przy kilku instancjach potrzebny wspólny magazyn.
