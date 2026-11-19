# API asystenta (Mewka) dla zespołu

Serwer asystenta to `assistant/server/index.ts` (Node 22, `--experimental-strip-types`). Odpowiada przez Claude,
klucz API jest tylko na serwerze, przeglądarka go nigdy nie widzi. Ten sam serwer serwuje zbudowany front (`assistant/dist`).

| Środowisko | Base URL |
|---|---|
| Produkcja (Mikrus, nginx + Cloudflare) | `https://jantar.byst.re` |
| Lokalnie (`npm run server` / `npm start`) | `http://localhost:8787` (port z `PORT`) |
| Lokalnie przez Vite (`npx vite`) | `http://localhost:5173`, `/api` jest proxowane do serwera |

## Endpointy

### `GET /api/health`

```bash
curl https://jantar.byst.re/api/health
```

```json
{ "ok": true, "model": "claude-opus-5-5", "knowledge": { "files": 2, "chars": 18450 }, "uptime": 3621 }
```

`knowledge.files` to liczba dokumentów w `server/knowledge/`, `uptime` w sekundach. Health nie wymaga tokenu ani limitów.

### `POST /api/chat` (JSON, cała odpowiedź naraz)

Body: `{ "lang": "pl" | "en" | "de" | "uk", "messages": Turn[] }`, gdzie `Turn = { "role": "user" | "assistant", "content": string }`.
Wysyłamy całą rozmowę (ostatnie 20 tur), ostatnia tura musi być od `user`.

```bash
curl -s https://jantar.byst.re/api/chat \
  -H 'content-type: application/json' \
  -d '{"lang":"pl","messages":[{"role":"user","content":"Pożar w kabinach na rufie, co robić?"}]}'
```

```json
{
  "text": ["Jeden. Ogłoś alarm i zgłoś na mostek miejsce i rodzaj zdarzenia.", "Dwa. ..."],
  "sources": [{ "label": "Muster List - punkt zbiórki A", "href": "#doc:muster-list.md" }],
  "fallback": false,
  "actions": [
    { "type": "route", "zone": "cabins-aft", "blocked": "stair-aft", "label": "kabiny na rufie, pokład 3, zablokowana klatka schodowa rufowa" },
    { "type": "drill", "id": "fire", "label": "pożar" }
  ]
}
```

- `text`: akapity (do wyświetlenia i czytania na głos), bez markerów.
- `sources`: cytowania z dokumentów statku (maks. 4), `href` = `#doc:<plik>`. Pusta lista, gdy folder `knowledge/` jest pusty.
- `fallback: true`: asystent nie zna odpowiedzi, UI pokazuje kontakt z mostkiem.
- `actions`: przyciski pod odpowiedzią (patrz niżej "Markery akcji").

### `POST /api/chat/stream` (Server-Sent Events)

To samo body co `/api/chat`. Odpowiedź `content-type: text/event-stream`, każde `data:` to JSON:

| Zdarzenie | Dane | Kiedy |
|---|---|---|
| `delta` | `{ "text": "kolejny kawałek" }` | wiele razy, w trakcie generowania; markery już usunięte |
| `done` | `{ "text": string[], "sources": [], "fallback": bool, "actions": [] }` | raz, na końcu; wersja ostateczna (jak `/api/chat`) |
| `error` | `{ "error": "assistant unavailable" \| "rate limited" \| "bad request" }` | gdy coś padnie w trakcie |

```bash
curl -N https://jantar.byst.re/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"lang":"pl","messages":[{"role":"user","content":"Droga ewakuacji z maszynowni"}]}'
```

```
event: delta
data: {"text":"Z maszynowni idź "}

event: delta
data: {"text":"schodami rufowymi na pokład 5."}

event: done
data: {"text":["Z maszynowni idź schodami rufowymi na pokład 5."],"sources":[],"fallback":false,"actions":[{"type":"route","zone":"engine-room","label":"maszynownia"}]}
```

Przykład w przeglądarce (`fetch` + strumień, bez bibliotek):

```js
async function askStream(messages, lang = 'pl', onDelta) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' /*, 'x-assistant-token': TOKEN */ },
    body: JSON.stringify({ lang, messages }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.status);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = JSON.parse(block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'));
      if (event === 'delta') onDelta(data.text);
      else if (event === 'done') return data;          // { text[], sources, fallback, actions }
      else if (event === 'error') throw new Error(data.error);
    }
  }
}
```

Uwaga: `done.text` to tekst ostateczny, podzielony na akapity. Po `done` warto podmienić tekst złożony z `delta` na `done.text`.
Przerwanie (`AbortController.abort()`) jest bezpieczne: serwer przestaje generować i dalej działa.
Pełniejszy parser SSE: `assistant/tests/sse.ts`.

## Błędy i limity

| Status | Body | Przyczyna |
|---|---|---|
| 400 | `{ "error": "bad request" }` | zły JSON, brak `messages`, brak niepustej tury `user` na końcu, body > 100 KB (*) |
| 403 | `{ "error": "forbidden" }` | obce `Origin` albo brak / zły `x-assistant-token` (gdy włączony) |
| 404 | `{ "error": "not found" }` | nieznany `/api/...` |
| 405 | `{ "error": "POST only" }` | zła metoda na `/api/chat*` |
| 429 | `{ "error": "rate limited" }` + nagłówek `retry-after` (sekundy) | przekroczony limit |
| 502 | `{ "error": "assistant unavailable" }` | błąd Claude / brak klucza |

W `/api/chat/stream` błędy przed startem strumienia (400/403/429) przychodzą jako zwykły JSON z tym statusem;
błąd Claude w trakcie strumienia to `event: error` (status już 200). Serwer nigdy nie zwraca stack trace'ów.
Cross-origin (`localhost` na innym porcie, `ALLOWED_ORIGINS`) dostaje nagłówki CORS i obsługę `OPTIONS`.

(*) Obecnie przy body > 100 KB serwer zrywa połączenie zamiast wysłać 400 (znany błąd); przez nginx body > 256 KB kończy się 413.

Limity (pamięć procesu, reset przy restarcie):
- na IP: 20 zapytań / 10 min i 300 / dobę; globalnie 2000 / dobę (oba endpointy czatu liczą się razem, `health` nie);
- za nginx IP brane jest z pierwszego wpisu `X-Forwarded-For`;
- wiadomości: ostatnie 20 tur, każda obcinana do 2000 znaków;
- do testów limity można zmienić env: `RATE_IP_10MIN`, `RATE_IP_DAY`, `RATE_GLOBAL_DAY`.

Origin: zapytania bez nagłówka `Origin` (curl, serwer-serwer) przechodzą. Z przeglądarki dozwolone są: ten sam host,
`localhost:*` / `127.0.0.1:*` oraz lista z env `ALLOWED_ORIGINS` (po przecinku, np. `https://jantar.byst.re,https://terminal.example.org`).

### `x-assistant-token`

Opcjonalny wspólny sekret. Jeśli na serwerze ustawiony jest env `ASSISTANT_TOKEN`, każde zapytanie do `/api/chat*`
musi mieć nagłówek `x-assistant-token: <ta sama wartość>`. Terminale (front Vite) biorą go z `VITE_ASSISTANT_TOKEN`
w `.env` przy buildzie. Bez `ASSISTANT_TOKEN` nagłówek jest ignorowany.

```bash
curl -s https://jantar.byst.re/api/chat -H 'content-type: application/json' -H 'x-assistant-token: SEKRET' -d '{...}'
```

## Markery akcji

Model dopisuje na końcu odpowiedzi markery, serwer je parsuje, waliduje (nieznane id są wyrzucane) i usuwa z tekstu.
Do klienta trafiają tylko gotowe `actions` (maks. 4); w `delta` markery nigdy się nie pojawiają.

| Marker | Akcja | Znaczenie w UI |
|---|---|---|
| `[[ROUTE:<zone>]]` | `{ type: "route", zone, label }` | zakładka Ewakuacja: trasa ze strefy do punktu zbiórki |
| `[[ROUTE:<zone>:<stair>]]` | `{ type: "route", zone, blocked, label }` | to samo, z zablokowaną klatką schodową (ogień, dym) |
| `[[DRILL:<id>]]` | `{ type: "drill", id, label }` | zakładka Ćwiczenia: karta ćwiczenia |
| `[[KONTAKT]]` | `fallback: true` | asystent nie wie, pokaż kontakt z oficerem wachtowym |
| inne `[[SŁOWO]]` / `[[SŁOWO:...]]` | (brak) | każdy inny marker (np. `[[SRC:n]]`) jest usuwany z tekstu |

Strefy (`zone`, z `assistant/src/ship/routes.ts`):

| id | strefa |
|---|---|
| `bridge` | mostek kapitański, pokład 5 |
| `cabins-fwd` | kabiny dziobowe 122-123, 146-147, pokład 3 |
| `cabins-mid` | kabiny śródokręcie 112-118, 136-142, pokład 3 |
| `cabins-aft` | kabiny rufowe 100-108, 124-132, pokład 3 |
| `restaurant` | restauracja, pokład 4 |
| `lounge` | salon (bar), pokład 4 |
| `reclining-lounge` | salon z fotelami lotniczymi, pokład 4 |
| `vehicle-d1` | pokład samochodowy 1 |
| `vehicle-d2` | pokład samochodowy 2 |
| `engine-room` | maszynownia, pod pokładem 1 |
| `engine-control` | centrum kontroli maszynowni (CMK), pod pokładem 1 |

Klatki schodowe (`blocked`): `stair-aft` (schody rufowe, prowadzą do punktu zbiórki A) i `stair-fwd` (schody dziobowe, punkt zbiórki B).

Ćwiczenia (`id`, z `assistant/src/drills/data.ts`): `fire` (pożar), `abandon` (opuszczenie statku), `mob` (człowiek za burtą),
`flooding` (wejście wody / przeciek), `pollution` (rozlew olejowy), `blackout` (zanik zasilania), `medical` (nagły wypadek medyczny).

Przykład: "pożar w kabinach na rufie" -> `[[ROUTE:cabins-aft:stair-aft]]` + `[[DRILL:fire]]`.

## Baza załogi (`/api/crew/*`)

Serwer asystenta jest też pośrednikiem (tylko do odczytu) do bazy załogi kolegów (`crew/`, karty i terminale w pomieszczeniach).
Adres bazy ustawia env `CREW_API` (domyślnie `http://127.0.0.1:8790`); `CREW_API=off` wyłącza proxy i narzędzia Mewki.

| Endpoint | Odpowiedź |
|---|---|
| `GET /api/crew/summary` | liczby: załoga, na statku, na lądzie, pomieszczenia, terminale, check-iny 24 h, ostatni check-in |
| `GET /api/crew/rooms` | pomieszczenia z obsadą i zajętością, **plus `place`** |
| `GET /api/crew/rooms/:id` | jedno pomieszczenie (`id` liczbowe z listy) + `crew` (kto jest w środku, bez danych prywatnych), **plus `place`** |
| `GET /api/crew/crew?q=` | lista załogi z bieżącym miejscem i `since` (`q` filtruje po imieniu, nazwisku, stopniu, karcie; maks. 64 znaki), bez danych prywatnych |
| `GET /api/crew/terminals` | terminale (`code`, `room_code`, `room_name`), **plus `place`** |
| `GET /api/crew/activity` | check-iny na godzinę, ostatnie 24 h |
| `GET /api/crew/alerts` | obsada kluczowych pomieszczeń, samotna praca w strefach niebezpiecznych, zaległe check-iny |

JSON jest taki sam jak w serwerze bazy, tylko pomieszczenia i terminale dostają
`place: { "zone": "<strefa>", "at": [x, y, z] }` z `assistant/shared/crew-map.ts` (`null`, gdy pomieszczenia nie ma na mapie).
Wiersze osób (`/api/crew/crew` i `crew` w `rooms/:id`) nie mają pól `birth_date`, `nationality` i `badge` (UI ich nie pokazuje);
reszta (imię, nazwisko, stopień, dział, zmiana, kabina, numer wewnętrzny, `room_*`, `since`) zostaje.
`zone` to id strefy z tabeli niżej albo `boat-deck`; dla terminali `at` liczy `terminalAt()` (kolejne czytniki w tym samym pomieszczeniu są przesunięte).

```bash
curl -s localhost:8787/api/crew/rooms | jq '.[0] | {code, name, people, place}'
# { "code": "D4-01", "name": "Mostek nawigacyjny", "people": 6, "place": { "zone": "bridge", "at": [0, 22.4, 57] } }
```

Zasady:
- tylko `GET` (i `HEAD`); `POST`/`PUT`/... -> 405, a `POST /api/checkin` nie jest przekazywany nigdy (check-iny robią tylko terminale bezpośrednio w bazie);
- ten sam `Origin` i `x-assistant-token` co czat (gdy `ASSISTANT_TOKEN` jest ustawiony, mapa też musi wysłać nagłówek);
- osobny limit: 120 zapytań / min na IP (env `RATE_CREW_MIN`), niezależny od limitu czatu (odpytywanie co 5 s nie zjada pytań do Mewki);
- odpowiedzi z bazy są trzymane w pamięci 3 s na ścieżkę, zapytanie do bazy ma timeout 2 s;
- baza nie odpowiada (lub `CREW_API=off`) -> `503 { "error": "crew database unavailable" }`; nieznane `rooms/:id` -> 404.

### Narzędzia Mewki (czat)

Gdy baza jest skonfigurowana, `/api/chat` i `/api/chat/stream` dają Claude narzędzia tylko do odczytu
(`tool_choice: auto`, pętla maks. 5 rund, wyniki jako zwięzły JSON). API czatu się nie zmienia: klient dostaje tylko tekst,
w `delta` nie ma ani markerów, ani danych narzędzi.

| Narzędzie | Wejście | Zwraca |
|---|---|---|
| `crew_summary` | brak | liczby z `summary` + `people_by_zone` (ile osób w każdej strefie) |
| `find_crew` | `{ query: string, details?: boolean }` | do 8 osób: imię i nazwisko, stopień, dział, karta, gdzie jest (pomieszczenie, strefa), od kiedy (`minutes_ago`), kabina, numer wewnętrzny; data urodzenia i narodowość tylko przy `details: true` |
| `room_people` | `{ room: string }` (kod `D1-01` albo fragment nazwy) | kto jest w środku i od kiedy, pojemność, zajętość %, minimalna obsada, strefa niebezpieczna / zastrzeżona, strefa |
| `safety_alerts` | brak | niedostateczna obsada, samotna praca, zaległe check-iny (maks. 10) |
| `list_terminals` | brak | terminale z pomieszczeniem i strefą |

Mewka podaje imiona, stopnie i miejsca, mówi ile minut / godzin temu był check-in, nie podaje danych osobowych
(urodzenie, narodowość) bez wyraźnej potrzeby służbowej, a gdy mówi gdzie ktoś jest, może dodać `[[ROUTE:<strefa>]]`
(przycisk z trasą). Gdy baza nie działa, narzędzie zwraca błąd i Mewka mówi wprost, że baza załogi jest niedostępna.

## Dokumenty statku (`server/knowledge/`)

- `server/knowledge.md` to krótkie podsumowanie dla persony Mewki (zostaje w prompcie systemowym).
- Folder `server/knowledge/` trzyma dokumenty statku: `.md`, `.txt` (UTF-8), `.pdf`. Wrzuć plik i zrestartuj serwer (dokumenty są wczytywane tylko przy starcie; na serwerze `deploy.sh` robi restart). `README.md` i inne rozszerzenia są pomijane; plik > 5 MB jest pomijany, łącznie do 20 MB. Szczegóły: `assistant/server/knowledge/README.md`.
- Przykład: `przyklad-procedura-pozarowa.md` (oznaczony jako materiał przykładowy).
- Tytuł dokumentu = nazwa pliku bez rozszerzenia, więc nazywaj pliki czytelnie: `muster-list.md`, `sms-pozar.pdf`.
- Każdy dokument idzie do Claude jako blok `document` z włączonymi cytowaniami; cytaty wracają w `sources` jako `"<tytuł> - <cytat>"`, `href: "#doc:<plik>"`.
- Sprawdź po restarcie: `curl localhost:8787/api/health` -> `knowledge.files` powinno wzrosnąć.
- Dokumenty są w każdym zapytaniu (cache'owane), więc trzymaj je zwięzłe; duże PDF-y podnoszą koszt i czas odpowiedzi.
- Nie wrzucaj danych osobowych załogi.

## Uruchomienie lokalnie

Bez klucza, z frontem podpiętym do serwera produkcyjnego:

```bash
cd assistant
ASSISTANT_API=https://jantar.byst.re npx vite
```

Bez klucza, z lokalnym serwerem i deterministycznym fałszywym Claude (do pracy nad UI i testów):

```bash
cd assistant
ASSISTANT_FAKE=1 npm run server      # albo: ASSISTANT_FAKE=1 npm run dev  (serwer + vite)
```

Fałszywy Claude powtarza pytanie, strumieniuje w małych kawałkach (markery rozcięte między kawałkami) i zawsze dodaje
`[[ROUTE:cabins-aft:stair-aft]] [[DRILL:fire]]`. Słowa w pytaniu sterują scenariuszem: `FAKE_KONTAKT` (fallback: true),
`FAKE_REFUSAL` (odmowa, pusty tekst), `FAKE_ERROR` (502 / `event: error`), `FAKE_SLOW` (200 ms między kawałkami),
`FAKE_TOOL` (najpierw wywołuje `find_crew` z `{query:"bosman"}`, potem odpowiada z wyniku: imię, stopień, pomieszczenie i `[[ROUTE:<strefa>]]`;
z bazą wyłączoną lub niedostępną mówi, że baza załogi jest niedostępna).
`/api/health` zwraca wtedy dodatkowo `"fake": true`.

Z prawdziwym kluczem: skopiuj `.env.example` do `.env`, wpisz `ANTHROPIC_API_KEY=...` i `npm run dev`.

Testy (startują serwer z `ASSISTANT_FAKE=1` na losowym porcie, nie potrzebują klucza ani internetu; `tests/crew.test.ts`
stawia własną fałszywą bazę załogi, a jeśli prawdziwa działa na `:8790`, robi też na niej krótki test proxy):

```bash
cd assistant
npm test
```

## Deploy

```bash
cd assistant
./deploy/deploy.sh      # build, rsync na Mikrus (ssh alias `mikrus`), systemd jantar-assistant + nginx
./deploy/set-key.sh     # wklej klucz Anthropic (sk-ant-...), trafia do /etc/jantar-assistant.env, restart usługi
```

Na serwerze usługa słucha na `127.0.0.1:3003`, nginx wystawia ją jako `jantar.byst.re`.
Inne zmienne (`ASSISTANT_TOKEN`, `ALLOWED_ORIGINS`, `ASSISTANT_MODEL`, `CREW_API`) dopisz do `/etc/jantar-assistant.env` i zrób
`systemctl restart jantar-assistant`. Uwaga: `set-key.sh` nadpisuje cały plik env, więc po nim dopisz pozostałe zmienne ponownie.
