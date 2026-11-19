# Firmware: kotwice BLE i opaski załogi

Dwa projekty PlatformIO (Arduino, ESP32) do lokalizacji załogi wewnątrz promu i ewakuacji.
Kontrakt (nazwy kotwic, `TX_1M`, format zapytania i odpowiedzi) jest w
`assistant/shared/positions.ts`, a serwer przyjmuje skany na `POST /api/bands/scan`.

| Katalog | Urządzenie | Co robi |
|---|---|---|
| `anchor/` | kotwica (beacon) | wisi pod sufitem, nadaje BLE z nazwą `JU-A-<id>`, nic więcej |
| `wristband/` | opaska | co 1 do 3 s skanuje BLE, wysyła listę kotwic i RSSI przez Wi-Fi, wibruje przy alarmie |
| `tools/` | skrypty | lista kotwic z `positions.ts`, uśrednianie RSSI do kalibracji |

## Jak to działa

1. Każda kotwica co ok. 150 ms nadaje niełączalny pakiet BLE z nazwą `JU-A-D3-05` przy stałej mocy.
2. Opaska skanuje BLE przez 1 s (skan pasywny, NimBLE), bierze tylko nazwy zaczynające się od `JU-A-`,
   dla każdej kotwicy zapamiętuje najsilniejszy RSSI z okna i zostawia maks. 40 najsilniejszych.
3. Opaska wysyła JSON (`BandScan`) do `<SERVER_URL>/api/bands/scan` z nagłówkiem `x-band-key`:

   ```json
   {"band":"04:A2:3B:1C","anchors":[{"id":"D3-05","rssi":-63},{"id":"D3-06","rssi":-71}],
    "bat":82,"sos":false,"ack":false,"fw":"band-0.1.0"}
   ```

4. Centrala liczy pozycję (pokład z najsilniejszych kotwic, potem trilateracja) i odpowiada (`BandReply`):

   ```json
   {"ok":true,"alarm":{"id":"a1","kind":"fire","drill":false,"muster":"muster-a","acked":false},"next":1}
   ```

   `next` to liczba sekund do następnego skanu (domyślnie 3 s bez alarmu, 1 s w czasie alarmu).

## Opaska: sygnały i przycisk

Wibracja zależy od `alarm.kind`:

| Rodzaj | Wzór wibracji |
|---|---|
| `general` | 7 krótkich + 1 długi, przerwa 2 s (jak sygnał alarmu ogólnego na statku) |
| `fire` | ciągłe krótkie impulsy 200/200 ms |
| `abandon` | długie 3 s, przerwa 0,7 s |
| `mob` | 3 długie, przerwa 2 s |
| pozostałe (`flooding`, `pollution`, `blackout`, `medical`, `security`) | 2 średnie, przerwa 2 s |

Dioda miga razem z silnikiem. Ćwiczenia (`drill: true`) mają ten sam wzór co prawdziwy alarm.

Przycisk:

- **krótkie naciśnięcie** w czasie alarmu = potwierdzenie (ack). Opaska od razu przestaje wibrować
  i w każdym kolejnym skanie wysyła `ack: true`, aż serwer odpowie `alarm.acked: true`.
  Dioda dalej daje krótki błysk co sekundę, dopóki alarm trwa. Nowy alarm (inne `alarm.id`) znowu wibruje.
- **przytrzymanie 3 s** = włączenie SOS (3 krótkie wibracje). Opaska wysyła `sos: true` w każdym skanie,
  dopóki SOS nie zostanie wyłączone kolejnym przytrzymaniem przez 3 s (1 wibracja).
  W trybie SOS dioda daje podwójny błysk co 2 s. SOS nie znika samo, nawet po restarcie serwera,
  bo to osoba w opałach decyduje, kiedy pomoc nie jest już potrzebna. Po restarcie opaski SOS jest wyłączone.

Brak Wi-Fi albo serwera: opaska dalej odtwarza ostatni wzór alarmu, ponawia połączenie
z rosnącą przerwą (1, 2, 4 ... 30 s). Po powrocie sieci od razu wysyła skan.

## Części

Opaska (na jedną sztukę):

| Część | Uwagi |
|---|---|
| ESP32-C3 SuperMini (albo ESP32 DevKit do testów na biurku) | C3 jest mały i bierze mniej prądu |
| Silnik wibracyjny pastylkowy 3 V (10 mm) | ok. 60 do 80 mA |
| Tranzystor NPN (S8050, 2N2222) + rezystor 1 kΩ do bazy, albo N-MOSFET logic level (AO3400) + 100 Ω do bramki i 100 kΩ bramka-GND | klucz silnika |
| Dioda 1N4148 lub 1N5819 | równolegle do silnika, katoda do plusa (gasi przepięcie) |
| Przycisk tact | do GND, podciąganie wewnętrzne |
| Akumulator LiPo 1S, 300 do 500 mAh | |
| Ładowarka TP4056 z zabezpieczeniem (wersja z DW01, wyjścia OUT+/OUT-) | ładowanie przez USB-C |
| Dzielnik 2 x 100 kΩ + 100 nF do GND na środku | pomiar baterii, pobiera ok. 20 µA |
| Wyłącznik suwakowy | między OUT+ a resztą układu |

Kotwica: ESP32-C3 SuperMini (albo dowolny ESP32), zasilacz USB 5 V z instalacji statku lub powerbank,
obudowa niemetalowa. Kotwica nie potrzebuje Wi-Fi.

## Podłączenie opaski

| Sygnał | ESP32-C3 SuperMini | ESP32 DevKit |
|---|---|---|
| Dioda LED | GPIO8 (wbudowana, aktywna stanem niskim) | GPIO2 (wbudowana) |
| Przycisk (do GND) | GPIO10 | GPIO27 |
| Silnik (baza/bramka klucza) | GPIO4 | GPIO25 |
| Bateria (środek dzielnika) | GPIO3 (ADC1) | GPIO34 (ADC1, tylko wejście) |
| Zasilanie z TP4056 OUT+ | pin 5V (przez stabilizator płytki) | VIN |
| Masa | GND | GND |

Silnik: plus silnika do OUT+ baterii, minus do kolektora NPN (drenu MOSFET-a), emiter (źródło) do GND.
Dzielnik: OUT+ -> 100 kΩ -> GPIO3 -> 100 kΩ -> GND.
Nie używaj GPIO9 na C3 jako przycisku: to BOOT, przytrzymany przy starcie wprowadza układ w tryb programowania.
Na ESP32 klasycznym pomiar musi być na ADC1, bo ADC2 nie działa przy włączonym Wi-Fi.
Piny są w `wristband/include/pins.h` i wybierają się same zależnie od układu.

Kotwica: dioda na GPIO8 (C3) albo GPIO2 (DevKit) mruga 3 razy po starcie.

## Konfiguracja

Opaska, `wristband/include/config.h`:

| Stała | Znaczenie |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | sieć załogi |
| `SERVER_URL` | adres centrali bez ukośnika na końcu, np. `http://192.168.1.10:8787` |
| `BAND_KEY` | wspólny klucz, wysyłany w nagłówku `x-band-key` |
| `BAND_UID` | UID tagu RFID tej opaski (hex, dowolne separatory), ten sam co `crew.rfid_uid` w bazie załogi |

Kotwica, `anchor/include/config.h`: `ANCHOR_ID` (np. `"D3-05"`), `ANCHOR_TX_POWER`
(domyślnie `ESP_PWR_LVL_N0`, czyli 0 dBm), `ADV_INTERVAL_MS` (domyślnie 150).

Każdą stałą da się nadpisać przy budowaniu, więc nie trzeba edytować pliku dla każdej sztuki:

```sh
PLATFORMIO_BUILD_FLAGS='-DANCHOR_ID=\"D3-06\"' pio run -t upload
PLATFORMIO_BUILD_FLAGS='-DBAND_UID=\"04:A2:3B:1D\"' pio run -t upload
```

Dla `https://` opaska nie sprawdza certyfikatu (`setInsecure`). Na prawdziwym statku trzeba wgrać
certyfikat CA centrali albo trzymać serwer w osobnej, zamkniętej sieci Wi-Fi.

## Budowanie i wgrywanie

```sh
cd firmware/anchor        # albo firmware/wristband
pio run                   # domyślnie ESP32-C3 (esp32-c3-devkitm-1)
pio run -e esp32dev       # ESP32 DevKit
pio run -t upload         # wgranie przez USB
pio device monitor        # log na 115200
```

SuperMini czasem nie wchodzi sam w tryb programowania: przytrzymaj BOOT, naciśnij RESET, puść BOOT.
Opaska używa partycji `huge_app.csv` (Wi-Fi + BLE + TLS zajmują ok. 1,1 MB, bez OTA).

## Lista kotwic

Jedynym źródłem jest `ANCHORS` w `assistant/shared/positions.ts` (plan demo, 120 sztuk).
Numery nieparzyste wiszą przy lewej burcie, parzyste przy prawej, numeracja od rufy do dziobu.

```sh
node --experimental-strip-types firmware/tools/anchors.mjs         # podsumowanie
node --experimental-strip-types firmware/tools/anchors.mjs --csv   # id, nazwa BLE, pokład, x/y/z, tx
```

| Pokład | Liczba | Identyfikatory |
|---|---|---|
| Pod pokładem 1 (maszynownia) | 10 | E-01 .. E-10 |
| Pokład 1 | 22 | D1-01 .. D1-22 |
| Pokład 2 | 22 | D2-01 .. D2-22 |
| Pokład 3 | 24 | D3-01 .. D3-24 |
| Pokład 4 | 24 | D4-01 .. D4-24 |
| Pokład 5 (szalupowy) | 12 | D5-01 .. D5-12 |
| Mostek | 6 | BR-01 .. BR-06 |

Po zamontowaniu kotwicy w innym miejscu niż w planie trzeba poprawić jej `at` w `ANCHORS`.

## Kalibracja TX_1M

`TX_1M` (-59 dBm) to RSSI odebrane przez opaskę 1 m od kotwicy. Zależy od modułu, anteny,
obudowy i mocy nadawania, więc warto je zmierzyć:

1. Wgraj wszystkim kotwicom tę samą moc `ANCHOR_TX_POWER`.
2. Podłącz opaskę do komputera, stań 1 m od kotwicy, ręka z opaską na wysokości klatki piersiowej,
   antena w stronę kotwicy, bez ludzi i metalu pomiędzy.
3. Uruchom:

   ```sh
   cd firmware/wristband
   pio device monitor | python3 ../tools/calibrate.py D3-05 30
   ```

   Skrypt zbiera 30 odczytów tej kotwicy i podaje średnią i medianę.
4. Powtórz w 3 lub 4 miejscach i dla kilku kotwic. Jeśli wyniki są podobne, wpisz średnią do `TX_1M`.
   Jeśli któraś kotwica wyraźnie odstaje (inna obudowa, montaż przy stali), ustaw jej własne pole `tx`
   w `ANCHORS`, np. `{ id: 'D3-05', ..., tx: -63 }`.
5. Opcjonalnie sprawdź `PATH_N`: zmierz RSSI na 5 i 10 m. `PATH_N = (TX_1M - rssi) / (10 * log10(d))`.

Opaska zawsze wypisuje na porcie szeregowym linie `rssi <id> <dBm>`, więc te same dane służą do diagnozy zasięgu.

## Montaż kotwic

- Pod sufitem (deckhead), ok. 2,4 m nad podłogą, z dala od rur i kanałów metalowych, antena nie przy stali.
- Co ok. 10 do 14 m wzdłuż pokładu, w 2 rzędach: przy lewej i przy prawej burcie.
- Na każdym pokładzie osobno. Stalowe pokłady prawie całkiem tłumią BLE (ok. 28 dB),
  więc kotwica z pokładu niżej praktycznie nie pomaga. Właśnie dzięki temu centrala pewnie rozpoznaje pokład.
- Na klatkach schodowych, w korytarzach przy kabinach, w maszynowni, na mostku i przy miejscach zbiórki.
- Pomieszczenia za stalowymi drzwiami (kabiny, magazyny) dostają własną kotwicę, jeśli trzeba tam kogoś znaleźć.
- Zasilanie z gniazd USB albo z obwodu awaryjnego, żeby kotwice działały przy zaniku zasilania (blackout).
  Przy zasilaniu bateryjnym: 0 dBm i 150 ms daje ok. 20 do 30 mA na ESP32-C3, więc to rozwiązanie na krótko.

## Ograniczenia

- BLE daje dokładność ok. 2 do 5 m, a nie centymetry. Wystarczy, by wiedzieć, w której części pokładu
  i w którym pomieszczeniu ktoś jest.
- Ciało człowieka tłumi sygnał o 5 do 15 dB: opaska po stronie zasłoniętej ciałem widzi kotwice słabiej.
- Metal odbija i tłumi fale, więc przy ścianach stalowych i w maszynowni błąd jest większy.
- Tłum ludzi w czasie ewakuacji pogarsza pomiar, dlatego serwer wygładza ślad i używa kilku kotwic naraz.
- Wi-Fi musi sięgać wszędzie, gdzie mają działać opaski, także na pokładzie szalupowym.
- Firmware nie używa uśpienia (light sleep) między skanami: CPU chodzi na 80 MHz, Wi-Fi ma modem sleep.
  Czas pracy na baterii nie był mierzony.

## Prywatność

Pozycje załogi służą wyłącznie bezpieczeństwu: ewakuacji, liczeniu osób na miejscach zbiórki
i szukaniu osób, które się nie zgłosiły. Opaska wysyła tylko UID tagu, RSSI kotwic, stan baterii, SOS i ack.
Mapa w centrali pokazuje imię, stanowisko i dział, bez numeru kabiny, telefonu czy danych zdrowotnych.
Zgodnie z RODO trzeba: poinformować załogę o celu i zakresie przetwarzania, określić podstawę prawną
(obowiązek armatora w zakresie bezpieczeństwa), ograniczyć dostęp do osób odpowiedzialnych za ewakuację,
ustalić krótki czas przechowywania historii pozycji i nie używać tych danych do kontroli czasu pracy.
