# Konta załogi i logowanie

Asystent załogi MF Jantar Unity ma prawdziwe konta. Bez logowania działa czat (bez danych o ludziach), ewakuacja,
ćwiczenia i podgląd alarmu. Kto jest gdzie na statku, łączność i konsola mostka wymagają zalogowania.
Kod: `assistant/server/auth.ts` (serwer), `assistant/src/auth/` (ekran logowania), testy `assistant/tests/auth.test.ts`.

## Kto ma konto

Każda osoba z bazy załogi (`crew/`, `GET /api/crew`). Nie zakłada się kont ręcznie: serwer asystenta pobiera listę
przy pierwszym logowaniu i potem co najwyżej raz na minutę. Ostatnia lista zostaje w `accounts.json`, więc logowanie
działa także wtedy, gdy baza załogi chwilowo nie odpowiada. Osoba usunięta z bazy traci otwarte sesje.

## Role

Rola wynika ze stopnia w bazie załogi:

| Rola | Stopnie | Uprawnienia |
| --- | --- | --- |
| `captain` (Kapitan) | Kapitan | wszystko, co mostek |
| `bridge` (Mostek) | Starszy oficer, II oficer, III oficer, Oficer radiowy (GMDSS), każdy "oficer" | ogłaszanie i kończenie alarmów |
| `engine` (Maszynownia) | Starszy / II / III / IV mechanik, Elektryk | jak załoga |
| `crew` (Załoga) | pozostali (Bosman, marynarze, kadeci, motorzyści, hotel, medyczni) | podgląd danych załogi, łączność, potwierdzanie alarmu |

Kapitan ma wszystkie uprawnienia mostka. Rola na terminalu nie jest już ustawieniem: przełącznik "Mostek / Załoga"
w zakładce Alarmy zniknął, nazwa i strefa terminala opisują tylko urządzenie.

## Jak się zalogować

Przycisk **Zaloguj** w nagłówku. Okno logowania otwiera się też samo, gdy chroniona część tego wymaga
(zakładka Łączność, warstwa załogi w Statku 3D, przycisk "Zaloguj się na mostek" w Alarmach).

1. **Karta lub opaska RFID.** Czytnik USB działa jak klawiatura: wpisuje numer i Enter. Wystarczy zbliżyć kartę, gdy okno
   logowania jest otwarte. Numer można też wpisać ręcznie ("Czytnik nie działa? Wpisz numer karty"). Serwer porównuje
   same cyfry szesnastkowe (`04:A3:1F...`, `04a31f...`, `04-A3-...` to ten sam numer), a czytniki podające numer
   dziesiętnie są przeliczane (w obu kolejnościach bajtów).
2. **Osoba + PIN.** "Wybierz siebie z listy i wpisz PIN": lista według działów z wyszukiwaniem, potem klawiatura PIN
   z dużymi klawiszami (działa w rękawicach, działa też klawiatura fizyczna). PIN ma 4-6 cyfr; wygenerowane PIN-y mają 6
   i szósta cyfra od razu loguje.

Błędy po polsku: zły PIN (z liczbą pozostałych prób), blokada konta, nieznana karta, za dużo prób z terminala, brak
połączenia.

## Gdzie są PIN-y

Katalog `assistant/server/data/` (zmienna `AUTH_DIR`), wszystkie pliki z prawami `600`, wszystkie w `.gitignore`:

- `accounts.json`: lista kont (id, imię i nazwisko, stopień, dział, rola, numer karty) i **skróty** PIN-ów (scrypt z solą).
  Nie ma w nim żadnego PIN-u otwartym tekstem.
- `demo-pins.txt`: **jednorazowa** lista PIN-ów otwartym tekstem, tworzona przy pierwszym uruchomieniu (i dopisywana
  przy nowych osobach albo resecie). Kolumny: id, imię i nazwisko, stopień, PIN. Do rozdania na pokazie; potem plik
  należy usunąć. Serwer go nie czyta.
- `sessions.json`: otwarte sesje. Zapisany jest tylko skrót SHA-256 tokenu, nie sam token.

`ACCOUNTS_DEMO_PIN=1234` (4-6 cyfr) ustawia jeden PIN dla wszystkich. Tylko do testów i programowania; serwer ostrzega
w logu. Nigdy na produkcji.

## Reset PIN-u

Na serwerze, w katalogu `assistant/`, jako użytkownik usługi:

```
node --experimental-strip-types server/auth.ts list                 # lista kont (id, rola, stopień, karta, PIN)
node --experimental-strip-types server/auth.ts reset 12             # nowy losowy PIN dla id 12
node --experimental-strip-types server/auth.ts reset 12 4821        # konkretny PIN (4-6 cyfr)
node --experimental-strip-types server/auth.ts reset all            # nowe PIN-y dla wszystkich
```

Nowy PIN trafia na koniec `demo-pins.txt`. Działający serwer bierze nowy skrót przy następnym logowaniu (sam zauważa
zmianę pliku). Otwarte sesje tej osoby kończy restart serwera asystenta, inaczej wygasną same (12 h).
Zgubiona karta: zmienić `rfid_uid` w bazie załogi; serwer pobierze nową listę w ciągu minuty.

## Sesja

- Ciasteczko `ju_session`: `HttpOnly`, `SameSite=Strict`, `Path=/`, ważne 12 h, `Secure` gdy połączenie idzie po
  https (także za nginx z `X-Forwarded-Proto: https`). Przeglądarka nie widzi tokenu w JavaScripcie.
- **Wylogowanie po 30 min bezczynności** na wspólnych terminalach (bez dotyku, klawisza, przewijania). W nagłówku
  pojawia się wtedy komunikat.
- **Wyloguj**: kliknij swoje inicjały / nazwisko w nagłówku, potem "Wyloguj". Sesja jest usuwana na serwerze.

## Ochrona przed zgadywaniem

- Limit z jednego adresu: 10 prób logowania na minutę (`AUTH_RATE_PER_MIN`), potem 429.
- 5 błędnych PIN-ów dla jednej osoby blokuje jej konto na 15 min (`AUTH_MAX_FAILS`, `AUTH_LOCK_MS`), także dla
  poprawnego PIN-u. Karta działa dalej.
- Logowanie tylko z dozwolonego Origin i tylko jako JSON (formularz z obcej strony nie przejdzie), porównania w stałym
  czasie, nieznane id odpowiada tak samo jak zły PIN.

## Co jest chronione

| Część | Bez logowania | Po zalogowaniu |
| --- | --- | --- |
| `GET /api/crew/*` (kto gdzie, pomieszczenia, terminale, alerty) | 401 `login required` | każda rola |
| Narzędzia czatu o załodze (`find_crew`, `room_people`...) | odpowiadają "login required", Mewka prosi o zalogowanie | każda rola |
| Alarm: ogłoszenie / zakończenie (WebSocket `/api/alarms/ws`) | `forbidden` | `bridge`, `captain` |
| Alarm: potwierdzenie | tak (każdy ekran musi móc potwierdzić) | tak, zapisuje się zalogowana osoba |
| Łączność (zakładka) | ekran "zaloguj się" | każda rola |
| Czat, ewakuacja, ćwiczenia, stan alarmu | tak | tak |

Rola alarmowa jest sprawdzana przez serwer przy każdym poleceniu: WebSocket odczytuje ciasteczko w handshake,
a `raise` / `end` sprawdzają sesję ponownie, więc wylogowanie odbiera uprawnienie od razu, także na otwartym
połączeniu. Kto ogłosił / zakończył alarm i kto potwierdził, zapisuje się z imienia, nazwiska i stopnia.

`GET /api/auth/roster` (lista do wyboru osoby: imię, nazwisko, stopień, dział, rola) jest publiczny, ale bez miejsc,
numerów kart i godzin.

## API

- `POST /api/auth/login` `{ "method": "pin", "id": 1, "pin": "123456" }` albo `{ "method": "rfid", "uid": "04:A3:..." }`
  -> `{ user }` + ciasteczko; 401 `bad-credentials` (+ `left`) / `unknown-card`; 429 `locked` / `rate limited` (+ `retryAfter`)
- `POST /api/auth/logout` -> `{ ok: true }`
- `GET /api/auth/me` -> `{ user | null }`
- `GET /api/auth/roster` -> `{ members, live, rfid }`

Dla innych modułów serwera: `getSession(req)`, `requireRole(req, res, ['bridge'])`, `hasRole(role, roles)`,
`currentSession()` (sesja obsługiwanego żądania). `attachAuth(server)` podpina `/api/auth/*` i kontekst żądania;
wywołuje je `attachAlarms()`, więc `index.ts` nie potrzebuje osobnej linii.

## Czego to nie załatwia

- Sygnalizacja wideo `/crew-video-ws` (`server/crew-video.ts`) sama nie sprawdza sesji; zakładka Łączność pokazuje się
  tylko po zalogowaniu, ale gniazdo jest otwarte jak wcześniej.
- `ASSISTANT_TOKEN` dalej jest tylko filtrem na boty (#4); prawdziwą kontrolą dostępu do danych załogi jest teraz logowanie.
- To nadal system szkoleniowy: prawdziwa instalacja alarmowa statku pozostaje głównym sygnałem.
