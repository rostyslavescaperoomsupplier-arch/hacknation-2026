# Statystyki: ranking siłowni i statystyki statku

Zakładka „Statystyki” w aplikacji załogi MF Jantar Unity. Dwie części:

1. **Ranking siłowni**: kto z załogi ile czasu spędził w siłowni statku (7 dni, 30 dni, cały okres).
2. **Statystyki statku**: ile osób jest na pokładzie i na lądzie, rozkład na działy, pokłady i wachty, obłożenie pomieszczeń, odbicia na godzinę, obsada kluczowych pomieszczeń, aktywne alerty i czasy potwierdzania alarmów.

| Plik | Co robi |
|---|---|
| `assistant/server/stats.ts` | API `GET /api/stats/gym`, `GET /api/stats/ship`; czyta bazę załogi tylko do odczytu i dziennik alarmów |
| `assistant/src/stats/StatsPanel.tsx` | panel (`export default function StatsPanel({ lang })`), wykresy SVG rysowane ręcznie |
| `assistant/tests/stats.test.ts` | testy `node:test` na tymczasowej bazie SQLite i tymczasowym `alarms.json` |

## Źródła danych

- **Baza załogi** (`crew/`, SQLite): pomieszczenia, załoga, odbicia kart `in`/`out` z czasem. Otwierana przez `new DatabaseSync(ścieżka, { readOnly: true })`, nic do niej nie zapisujemy. Ścieżka ze zmiennej `CREW_DB`, domyślnie `../crew/data/crew.db` względem folderu `assistant`. Na serwerze: `CREW_DB=/var/www/jantar-crew/data/crew.db` (www-data musi móc czytać plik bazy oraz, przy trybie WAL, mieć dostęp do plików `crew.db-wal` i `crew.db-shm` w tym samym katalogu).
- **Dziennik alarmów**: `assistant/server/data/alarms.json` (zmienna `ALARMS_FILE`, ta sama co w `alarms.ts`, opis w `docs/ALARMS.md`).
- Wyniki są trzymane w pamięci 10 s, więc odświeżanie wielu terminali nie obciąża bazy.
- Dziennik ćwiczeń z zakładki „Ćwiczenia” leży tylko w `localStorage` przeglądarki, serwer go nie widzi, więc nie wchodzi do statystyk.

## Definicje

### Siłownia

- Siłownia to pomieszczenie o nazwie „Siłownia” z rolą „Rekreacja” (w danych przykładowych `D3-05`). Inny kod można wymusić zmienną `STATS_GYM_CODE`. Uwaga: słowo „siłownia” występuje też w opisie maszynowni (siłownia okrętowa), dlatego liczy się nazwa i rola pomieszczenia, a nie opis.
- **Wizyta** zaczyna się od odbicia `in` w siłowni i trwa do następnego odbicia tej osoby gdziekolwiek (`in` w innym pomieszczeniu albo `out`). Ponowne odbicie przy drzwiach siłowni nie zaczyna nowej wizyty.
- Wizyta trwająca (brak kolejnego odbicia) liczy się do teraz.
- Jedna wizyta liczy się **najwyżej 4 godziny** (zapomniane odbicie przy wyjściu, karta zostawiona w siłowni).
- Okres 7 dni / 30 dni: liczy się tylko ta część wizyty, która mieści się w okresie. Wizyta wchodzi do liczby wizyt, jeśli choć jej część jest w okresie.
- **Ranking**: suma minut malejąco. Ta sama liczba minut daje to samo miejsce (1, 2, 2, 4). Osoby bez minut w okresie nie są pokazywane.
- Dla każdej osoby: miejsce, imię i nazwisko, dział, łączny czas, liczba wizyt, średnia wizyta, ostatnia wizyta (z dokładnością do minuty), czy jest teraz w siłowni.
- Działy: suma minut, wizyt i liczba trenujących osób z działu. Podium: trzy pierwsze pozycje.

### Statek

- **Na pokładzie**: ostatnie odbicie osoby to `in`. **Na lądzie**: ostatnie odbicie to `out` albo brak odbić (jak widok `crew_location` w bazie).
- **Działy, wachty**: liczba osób w załodze i ile z nich jest teraz na pokładzie (pole `shift`: `00-04`, `04-08`, `08-12`, `dzienna` itd.).
- **Pokłady**: osoby odbite teraz w pomieszczeniach danego pokładu.
- **Obłożenie** pomieszczenia = osoby / bezpieczna pojemność × 100%. Lista 8 najbardziej zajętych i lista pomieszczeń z przekroczoną pojemnością. Progi jak w panelu `crew/`: wysokie od 70%, przekroczone od 100%.
- **Odbicia na godzinę**: 24 pełne godziny, ostatnia to bieżąca, niepełna godzina (te same przedziały co `crew` `/api/activity`).
- **Obsada kluczowych pomieszczeń** (`rooms.min_staff > 0` w godzinach `staff_hours`): stan teraz i odsetek minut z ostatnich 24 h, w których obsada była pełna. Liczone tak samo jak w `crew/server/alerts.ts` (odtworzenie logu odbić; sprawdzone na bazie demo, wyniki zgodne). Kod jest powtórzony, a nie importowany, bo na serwerze `crew/` stoi w innym katalogu.
- **Aktywne alerty**: tylko liczby, progi z `crew/server/alerts.ts`: obsada (niepełna / brak), praca w pojedynkę w pomieszczeniu niebezpiecznym (30 / 60 min), czas od ostatniego odbicia (4 / 8 h, we własnej kabinie 12 / 16 h).
- **Alarmy (ostatnie 30 dni)**: liczba, prawdziwe i ćwiczenia, rodzaje. **Czas potwierdzenia** = pierwsze potwierdzenie terminala minus start alarmu; terminal, który ogłosił alarm (potwierdzenie 0 s), jest pomijany. Średnia, mediana, najdłuższy oraz terminal z najdłuższym średnim czasem (nazwa terminala, nie osoby).
- **Zaokrętowania**: ile osób zaokrętowało w ostatnich 7 i 30 dniach oraz mediana dni na statku. Same liczby, bez nazwisk.

## Prywatność (RODO)

- Osoby z imienia i nazwiska pojawiają się **tylko w rankingu siłowni**, i tylko jako: miejsce, imię i nazwisko, dział, czas w siłowni. Panel mówi wprost, że udział jest dobrowolny i że ranking pokazuje wyłącznie czas w siłowni.
- Nigdy nie wychodzą: numer `badge`, UID RFID, typ nośnika, kabina, telefon wewnętrzny, data urodzenia, narodowość, identyfikatory z bazy, pole `user` z potwierdzeń alarmów. Zapytania SQL w `stats.ts` w ogóle tych kolumn nie czytają (poza kabiną, potrzebną tylko do progu alertu „we własnej kabinie”). Test sprawdza to na całej odpowiedzi obu endpointów.
- Statystyki statku to wyłącznie liczby.
- Do decyzji zespołu przed wdrożeniem: ranking pokazuje wzorzec zachowania konkretnych osób (kiedy i jak długo ćwiczą). Na prawdziwym statku potrzebna byłaby zgoda (opt-in) albo pseudonimy; w kodzie łatwo to dodać jako filtr listy osób.

## API

Oba endpointy: tylko `GET` (inne metody 405), ten sam test Origin i `x-assistant-token` co proxy załogi (403), limit z `guard.ts` `takeCrewToken` (120 / min / IP, wspólny z `/api/crew/*`, 429 z `retry-after`), `cache-control: no-store`.

Dostęp: jeśli `server/auth.ts` eksportuje `getSession(req)`, wymagana jest zalogowana sesja (cookie `ju_session`), inaczej **401** `{ "error": "login required" }`. Moduł jest ładowany dynamicznie: gdy pliku nie ma, statystyki są otwarte (demo bez kont); gdy plik jest, ale nie da się go wczytać, statystyki są zamknięte. Hak dla prowadzącego: `setStatsAccessCheck(fn)` z `server/stats.ts` zastępuje tę regułę dowolną funkcją `(req) => boolean | Promise<boolean>` (np. tylko rola `bridge`).

| Metoda | Ścieżka | Parametry | Odpowiedź |
|---|---|---|---|
| GET | `/api/stats/gym` | `period` = `7d` (domyślnie) \| `30d` \| `all` | `{ period, from, now, room: { code, name }, capMinutes, totals: { minutes, sessions, people, crew }, ranking: [{ rank, name, department, minutes, sessions, avgMinutes, lastVisit, ongoing }], top3, departments: [{ department, minutes, sessions, people }] }` |
| GET | `/api/stats/ship` | brak | `{ now, crew: { total, onboard, ashore }, checkins24h, departments, decks, watches, rooms: { total, occupied, busy, overCapacity }, checkinsPerHour: [{ start, count }], staffing: [{ code, name, deck, minStaff, hours, active, people, status, coverage24h }], alerts, alarms: { days, total, real, drill, active, byKind, ack: { count, avgSec, medianSec, maxSec }, slowestTerminal, lastAlarm }, embarked: { last7d, last30d, medianDaysOnBoard } }` |

Błędy: 400 przy złym lub powtórzonym `period` albo nieznanym parametrze, 404 dla innych ścieżek pod `/api/stats/`, 503 `{ "error": "crew database unavailable" }`, gdy bazy nie da się otworzyć.

## Podłączenie (dla prowadzącego)

`assistant/server/index.ts`, obok pozostałych modułów, przed 404 dla `/api/`:

```ts
import { handleStatsHttp } from './stats.ts';
// ...
    if (await handleStatsHttp(req, res)) return;
```

`assistant/src/App.tsx`, leniwa zakładka „Statystyki” z hashem `#statystyki`:

```tsx
const StatsPanel = lazy(() => import('./stats/StatsPanel'));
// type Tab = ... | 'statystyki';   TABS: [..., 'statystyki']
// TAB_ICON.statystyki: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3']
// etykieta: L(lang, 'Statystyki', 'Statistics')
<section id="panel-statystyki" role="tabpanel" aria-labelledby="tab-statystyki" hidden={tab !== 'statystyki'}
         className="gutter mx-auto max-w-6xl py-4">
  {seen.has('statystyki') && (
    <Suspense fallback={fallback}>
      <StatsPanel lang={lang} />
    </Suspense>
  )}
</section>
```

Przy 7 zakładkach dolny pasek na telefonie 360 px ma ok. 51 px na zakładkę, więc nadal ≥ 48 px.

## Panel

- „Ranking siłowni”: przełącznik okresu (7 dni / 30 dni / wszystko, przyciski `aria-pressed`, 48 px), podium top 3, lista pierwszych 10 osób (przycisk „Pokaż wszystkich”) z paskiem czasu, czasem w godz:min, liczbą wizyt, średnią i ostatnią wizytą, sumy działów, notka o dobrowolności i RODO.
- „Statystyki statku”: kafle (na pokładzie, na lądzie, aktywne alerty, średni czas potwierdzenia alarmu), wykres odbić na godzinę (SVG z podpisem tekstowym: suma, godzina szczytu, najspokojniejsza godzina, oraz tabela pod „Pokaż tabelę”), obsada kluczowych pomieszczeń (znak kształt + kolor + słowo), załoga według działów, osoby na pokładach, najbardziej zajęte pomieszczenia z paskami obłożenia, alarmy, wachty, zaokrętowania.
- Każdy pasek ma obok liczbę zapisaną tekstem, więc kolor nigdy nie jest jedynym nośnikiem informacji. Liczby tabelaryczne (`tabular-nums`).
- Stany: wczytywanie, brak danych, błąd (401: „dostępne po zalogowaniu”, 503: „baza załogi niedostępna”, 429) z przyciskiem „Spróbuj ponownie”.
- Odświeżanie co 30 s, tylko gdy karta przeglądarki jest widoczna i zakładka jest otwarta.
- Kolory wyłącznie z tokenów (`teal`, `gold`, `danger`, `ok`, `paper-2`), więc działa w trybie jasnym, ciemnym i nocnym (`data-theme="night"`). Sprawdzone na 360 px bez poziomego przewijania.

## Testy

```bash
cd assistant
node --experimental-strip-types --test tests/stats.test.ts
```

Tymczasowa baza (schemat z `crew/server/db.ts`) ze znanymi odbiciami: zwykła wizyta, wizyta 5,5 h ucięta do 4 h, wizyta trwająca, podwójne odbicie przy drzwiach, wizyta na granicy 7 dni, wizyty sprzed 10 i 40 dni, osoba nigdy w siłowni, osoba bez żadnych odbić. Sprawdzane: minuty, wizyty i miejsca dla 7d / 30d / all (z remisami), sumy działów, kształt i liczby statystyk statku, podsumowanie alarmów z tymczasowego `alarms.json`, walidacja parametrów, 401 z haka dostępu, 503 bez bazy oraz brak pól prywatnych w odpowiedziach.
