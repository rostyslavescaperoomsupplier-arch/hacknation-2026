# Opaski ESP32: położenie załogi w czasie ewakuacji

Opaska załogi ma ESP32, który co 1-3 s skanuje BLE i wysyła do centrali siłę sygnału (RSSI) stałych kotwic. Centrala liczy z tego pozycję osoby na modelu statku, a w czasie alarmu jej status. Sprzęt i prowadzenie kabli: `firmware/README.md`.

## Jak liczona jest pozycja

1. **Kotwice**: ESP32 pod sufitem co 10-14 m, dwa rzędy (lewa i prawa burta), na każdym pokładzie, także na klatkach schodowych. Nadają nazwę BLE `JU-A-<id>`, np. `JU-A-D3-05`. Lista i pozycje: `ANCHORS` w `assistant/shared/positions.ts` (120 sztuk w wersji demo; `node --experimental-strip-types firmware/tools/anchors.mjs`).
2. **RSSI na odległość**: model log-distance, `RSSI = TX_1M - 10 * n * log10(d)`, n = 2,7 (stalowy kadłub). `TX_1M` mierzy się dla każdej kotwicy z 1 m (`firmware/tools/calibrate.py`).
3. **Pokład**: stalowy pokład tłumi BLE o ~25-30 dB, więc pokład to ten, którego 3 najsilniejsze kotwice dają najwięcej mocy. Zmiana pokładu wymaga dwóch skanów pod rząd (bez skakania między piętrami).
4. **x/z na pokładzie**: ważona metoda Gaussa-Newtona na okręgach z 3-8 najsilniejszych kotwic, potem wygładzanie (EMA). W symulacji: mediana błędu ok. 3 m, pokład zawsze dobry.
5. **Strefa**: pudełka stref z modelu (kabiny, maszynownia, schody, punkty zbiórki A/B).

## Statusy w czasie alarmu

| Status | Kiedy | Co robi mostek |
|---|---|---|
| na zbiórce | pozycja w strefie punktu zbiórki A lub B | nic, osoba rozliczona |
| w drodze | świeża pozycja, porusza się | obserwuje |
| bez ruchu | nie ruszyła się więcej niż 5 m przez 60 s w czasie alarmu | wysyła ratowników: uwięziona, ranna, nieprzytomna? |
| SOS | przytrzymała przycisk na opasce 3 s | wysyła ratowników od razu |
| brak sygnału | brak skanu od 30 s | szuka od ostatniej znanej pozycji (bateria, zasięg, człowiek za burtą?) |

Opaska dostaje w odpowiedzi aktywny alarm i wibruje jego wzorem; krótkie naciśnięcie = potwierdzenie.

## Gdzie to widać

- **Ewakuacja** (po zalogowaniu): kropki osób na modelu 3D, panel „Opaski: rozliczenie ewakuacji” z liczbami i listą „Do odnalezienia” (najpilniejsi na górze). Kliknięcie osoby zaznacza ją i pokazuje drogę między jej strefą a punktem zbiórki.
- **Mewka**: narzędzie `wristband_positions` („kogo brakuje na zbiórce”, „gdzie jest bosman”).

## API (centrala, `assistant/server/positions.ts`)

| | |
|---|---|
| `POST /api/bands/scan` | z opaski. Nagłówek `x-band-key` = `BAND_KEY` z `/etc/jantar-assistant.env` (bez klucza tylko z localhost, dla symulatora). Treść: `{ band: "<UID tagu RFID opaski>", anchors: [{ id: "D3-05", rssi: -71 }], bat?, sos?, ack?, fw? }`. Odpowiedź: `{ ok, alarm: null \| { id, kind, drill, muster, acked }, next }` |
| `GET /api/bands` | stan dla mapy: osoby (imię, stopień, pozycja, strefa, status), liczby, aktywny alarm. Tylko dla zalogowanych |

Opaska jest przypisana do osoby przez UID tagu RFID (`crew.rfid_uid` w bazie załogi). Pozycje są tylko w pamięci serwera, bez historii na dysku.

## Demo bez sprzętu

`npm run bands` w `assistant/` (serwer asystenta i baza załogi muszą działać): każda osoba z tagiem dostaje wirtualną opaskę. Po ogłoszeniu alarmu wszyscy idą drogą ewakuacji, poza trzema przypadkami: jedna osoba w maszynowni stoi (bez ruchu), jedna w kabinach rufowych traci sygnał po 10 s, jedna na pokładzie samochodowym zatrzymuje się w połowie i wysyła SOS. `SIM_SPEED=2` skraca pokaz, `SIM_SCENARIO=0` wyłącza te przypadki. Na serwerze demo działa jako usługa `jantar-bands` (na statku z prawdziwymi opaskami: `systemctl disable --now jantar-bands`).

## Ograniczenia

- BLE daje kilka metrów dokładności; ciało i metal osłabiają sygnał. Do wskazania pomieszczenia wystarcza, do metra nie.
- Wymaga Wi-Fi na całym statku (opaska wysyła przez Wi-Fi). W maszynowni i na pokładach samochodowych trzeba to sprawdzić pomiarem.
- RODO: położenie to dane osobowe. Tu tylko do bezpieczeństwa, widoczne po zalogowaniu, bez zapisu historii.
