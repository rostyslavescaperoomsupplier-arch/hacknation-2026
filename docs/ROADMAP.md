# Plan rozwoju: cyfrowy asystent załogi (MF Jantar Unity)

Punkt wyjścia: plan z tablicy (`docs/PLAN.md`, zdjęcie `docs/tablica-plan.jpg`). Stan na 2026-11-19.

## 1. Stan planu z tablicy

| Z tablicy | Stan | Gdzie |
|---|---|---|
| Cyfrowy asystent załogi | jest | zakładka Asystent: Mewka, czat + głos, Claude, narzędzia do bazy załogi |
| Terminal logowania przez RFID | baza i API są (`POST /api/checkin` z UID karty/opaski), brak fizycznego czytnika | `crew/` |
| Informacje o statku / plan ewakuacji | jest | Statek 3D, Ewakuacja |
| Szkolenia z wydarzeń | częściowo | Ćwiczenia (7 scenariuszy, dziennik); brak studiów przypadków i omówień z prawdziwych alarmów |
| System alarmowy | w budowie | zakładka Alarmy: ogłaszanie z mostka, potwierdzenia, rozliczenie zbiórki |
| System anty-rzyg | jest | zawsze włączone wskazówki ruchu (kropki + horyzont), kalibracja, stan morza |
| Głosowe sterowanie | częściowo | rozmowa głosowa z Mewką; brak komend sterujących aplikacją |
| Statystyki statku, załogi | jest (panel `crew/`) | obłożenie pomieszczeń, obsada wacht, alerty |
| Ranking załogi | brak | |
| Mapa zalogowania | jest | warstwa Załoga na modelu 3D |
| Wideo/audio chat między terminalami | jest | zakładka Łączność, „Połącz z mostkiem” |

## 2. Na demo hackathonu (najbliższe godziny)

Cel: jeden spójny scenariusz, który pokazuje wszystko naraz.

1. **Klucz API na serwerze**, żeby Mewka odpowiadała na żywo (`assistant/deploy/set-key.sh`).
2. **Dane dla Jantar Unity zamiast MS Brda.** Przenieść seed bazy załogi na pokłady i strefy promu (te same co w modelu 3D), żeby `shared/crew-map.ts` było tożsamościowe.
3. **Scenariusz demo „pożar w kabinach na rufie”** (skrypt w `docs/DEMO.md`):
   1. czujnik / mostek ogłasza alarm;
   2. wszystkie terminale pokazują alarm i drogę ewakuacji z objazdem;
   3. Mewka na pytanie „kto jest w strefie?” podaje osoby z bazy;
   4. rozliczenie zbiórki rośnie w miarę odbić kart przy szalupach;
   5. koniec alarmu → automatyczne omówienie z czasami reakcji.
4. **Fizyczny czytnik RFID przy jednym terminalu** (czytnik USB-klawiatura albo płytka z czytnikiem wysyłająca `POST /api/checkin`).
5. **Tablet jako terminal w trybie kiosku** (PWA na pełnym ekranie, bez paska przeglądarki).

## 3. Co warto dodać do systemu (ponad plan z tablicy)

### Bezpieczeństwo i ratownictwo
- **Automatyczne rozliczenie zbiórki z odbić RFID** przy stacjach zbiórki/szalupach: lista „brakuje N osób” z ostatnim znanym miejscem każdej z nich. Najmocniejsza funkcja dla kapitana w prawdziwym alarmie.
- **Opaska RFID/BLE i „człowiek za burtą”**: osoba na pokładzie otwartym, która zniknęła z zasięgu, uruchamia alarm MOB z ostatnią pozycją.
- **Eskalacja pracy w pojedynkę** (maszynownia, pompownia): przypomnienie na terminalu, potem alarm na mostek, potem wideo-połączenie.
- **Integracja z centralą pożarową i drzwiami wodoszczelnymi** (Modbus/NMEA przez bramkę tylko do odczytu): czujka w strefie → propozycja alarmu z gotową strefą i zablokowaną klatką.
- **Pozycja statku i pogoda** (AIS/NMEA, prognoza): Mewka i alarm MOB znają pozycję i dryf.

### Ludzie i zgodność z przepisami
- **Godziny pracy i odpoczynku (MLC 2006 / STCW)** liczone z odbić kart: ostrzeżenie przed przekroczeniem, raport dla armatora. Duża wartość, dane już są.
- **Raport z ćwiczeń dla inspekcji (PSC)**: automatyczny dziennik zgodny z SOLAS (data, rodzaj, uczestnicy, czasy), eksport PDF.
- **Ważność certyfikatów i szkoleń** (STCW, medyczne) z przypomnieniami.
- **Ranking załogi** liczony uczciwie: udział w ćwiczeniach, wyniki quizów ze studiów przypadków, czas potwierdzenia alarmu. Ranking zespołów zamiast osób, żeby nie karać ludzi za pracę na wachcie.
- **Szkolenia z wydarzeń**: studia przypadków prawdziwych katastrof promów (Herald of Free Enterprise, Scandinavian Star, Estonia, Norman Atlantic, Lisco Gloria) z quizem i odniesieniem do naszego statku, plus omówienia z naszych własnych alarmów.

### Terminal i obsługa
- **Komendy głosowe** sterujące aplikacją („pokaż drogę ewakuacji z maszynowni”, „ogłoś alarm ćwiczebny pożar”, z potwierdzeniem przy alarmach).
- **Tryb nocny mostka** (czerwony, przyciemniony) i obsługa w rękawicach: w trakcie.
- **Języki załogi**: polski, angielski, ukraiński, tagalog (TTS i interfejs).
- **Powiadomienia push i dźwięk na telefonach załogi** (PWA), także z zablokowanym ekranem.

## 3a. Smart opaski załogi (RFID + czujniki)

Baza załogi już przewiduje opaskę jako identyfikator (`crew.rfid_type = 'opaska'`). Docelowo opaska to więcej niż tag:

| Element | Do czego |
|---|---|
| Tag RFID/NFC (UID) | odbicie przy terminalach, drzwiach i stacjach zbiórki, logowanie do terminala bez karty |
| BLE (beacon) | pozycja między czytnikami: w której strefie jest osoba, także na pokładzie otwartym |
| Silnik wibracyjny + dioda | alarm odczuwalny w hałasie maszynowni i przez sen: inny wzór wibracji dla alarmu ogólnego, pożaru, MOB; potwierdzenie przyciskiem na opasce |
| Akcelerometr | wykrycie upadku i bezruchu (praca w pojedynkę), liczenie aktywności |
| Czujnik zanurzenia + utrata sygnału BLE | automatyczny alarm „człowiek za burtą” z ostatnią pozycją |
| Tętno (PPG), SpO2, temperatura skóry | stan osoby: stres cieplny w maszynowni, zmęczenie, nagły problem zdrowotny |
| Bateria | stan widoczny na mostku, przypomnienie o ładowaniu na terminalu |

Jak działa w alarmie:
1. Mostek ogłasza alarm → wszystkie opaski wibrują wzorem tego alarmu, dioda pokazuje kolor.
2. Osoba potwierdza przyciskiem; terminal i asystent pokazują jej drogę ewakuacji.
3. Przy stacji zbiórki opaska jest odczytywana automatycznie → rozliczenie zbiórki rośnie bez ręcznego liczenia.
4. Mostek widzi: kto nie potwierdził, ostatnią strefę każdej brakującej osoby, alerty zdrowotne (upadek, bezruch, tętno).

Statystyki (zbiorczo, bez surowych danych medycznych dla przełożonych): czas reakcji na alarmy, obciążenie cieplne na wachcie w maszynowni, godziny pracy i odpoczynku (MLC 2006), aktywność i sen.

Warunki:
- **RODO art. 9**: tętno, SpO2 i temperatura to dane o zdrowiu. Podstawa: ochrona żywotnych interesów w alarmie, poza tym dobrowolna zgoda; na mostek trafiają tylko alerty, nie surowe pomiary; krótka retencja; DPIA.
- **Sprzęt**: wodoszczelność IP68, odporność na sól, w strefach zagrożonych wybuchem wersja ATEX; ładowanie bez kontaktów.
- **Łączność**: bramki BLE w strefach (te same co terminale), działanie bez internetu na statku.
- **Prototyp na hackathon**: opaska z tagiem RFID (odbicia już działają w bazie) + ESP32 z silnikiem wibracyjnym i BLE, sterowany przez ten sam system alarmowy.

## 3b. Głos Mewki: plan ulepszeń

Stan 2026-11-19: półdupleks. Gdy Mewka mówi, mikrofon jest wyłączony (przeglądarka nie usuwa echa `speechSynthesis`, więc słyszała samą siebie); mikrofon wraca 1,4 s po końcu wypowiedzi, a końcówka jej własnej odpowiedzi złapana zaraz potem jest odrzucana. Przerwać można przyciskiem mikrofonu, Escape, pisaniem albo dotknięciem.

### Teraz (hackathon, małe i pewne)
1. **Krótka odpowiedź głosem, pełna na ekranie.** W trybie głosowym Mewka czyta 1–2 zdania (sedno + pierwszy krok), resztę pokazuje. Krócej mówi = krócej zamknięty mikrofon.
2. **Wyraźny stan „mówię / słucham”** na Mewce i przycisku (kolor + ikona mikrofonu przekreślona podczas mowy), żeby nikt nie mówił do wyłączonego mikrofonu.
3. **Przycisk „Przerwij” w zasięgu kciuka** podczas mowy (duży, obsługa w rękawicach), skrót: spacja.
4. **Panel diagnostyczny głosu** (`?debug=voice`): co usłyszał rozpoznawacz, co odrzucono jako echo, czasy. Do strojenia na prawdziwym mostku.

### Po hackathonie
5. **Naciśnij i mów (push-to-talk)** jako tryb domyślny na głośnym mostku i w maszynowni: przytrzymanie przycisku ekranowego albo fizycznego przycisku przy terminalu. Zero fałszywych startów od hałasu.
6. **Komendy głosowe aplikacji** z lokalnym rozpoznaniem intencji („pokaż drogę ewakuacji z maszynowni”, „ogłoś alarm ćwiczebny”). Przy alarmach **potwierdzenie z powtórzeniem**, jak w łączności morskiej (SMCP): Mewka powtarza komendę, wykonuje dopiero po „potwierdzam”.
7. **Alarm ma pierwszeństwo:** ogłoszony alarm natychmiast ucisza Mewkę i zamyka mikrofon; po alarmie Mewka sama nie wraca do rozmowy.
8. **Mieszane PL/EN:** rozpoznawanie fraz SMCP i nazw sprzętu po angielsku w polskiej rozmowie (słownik podpowiedzi + normalizacja przed wysłaniem).

### Pilot (warunek na prawdziwym statku)
9. **Rozpoznawanie mowy offline.** Web Speech API w Chrome wysyła dźwięk do Google, czyli na morzu bez łącza głos nie działa. Docelowo: Whisper (np. whisper.cpp / faster-whisper) na serwerze centrali albo Vosk w przeglądarce (jest model polski). Dźwięk nie opuszcza statku (RODO).
10. **Własny syntezator mowy** (Piper, polskie głosy) na centrali: ten sam głos Mewki na każdym terminalu, niezależnie od systemu tabletu.
11. **Prawdziwe przerywanie głosem (pełny dupleks).** Możliwe dopiero przy 9 + 10: odpowiedź grana jako `<audio>` ze strony, mikrofon przez `getUserMedia` z `echoCancellation`, własny STT na tym strumieniu. Do sprawdzenia na sprzęcie terminala, czy AEC przeglądarki faktycznie wycina dźwięk strony.
12. **Słowo budzące „Mewka”** (lokalne wykrywanie, np. openWakeWord) zamiast ciągłego nasłuchu: mikrofon otwiera się dopiero na zawołanie.
13. **Głos tylko dla zalogowanych** (RFID): bez logowania Mewka nie odpowiada głosem na pytania o załogę i lokalizacje.

## 4. Platforma (warunek wdrożenia na prawdziwy statek)

- **Prawdziwe uwierzytelnianie terminali i osób**: karta RFID + PIN, role (mostek, oficer, załoga), log audytu. Dziś rola terminala jest deklaratywna, a lokalizacja załogi jest widoczna bez logowania (patrz `docs/ADVERSARIAL-REPORT.md`).
- **Serwer na statku + synchronizacja z lądem.** Statek bywa bez internetu: centrala, baza, alarmy i wideo muszą działać lokalnie; Claude przez łącze satelitarne, a bez łącza Mewka odpowiada z lokalnych procedur (tryb offline).
- **RODO**: lokalizacja załogi to dane osobowe. Potrzebne DPIA, podstawa prawna (bezpieczeństwo, art. 6 ust. 1 lit. c/d), retencja odbić (np. 30 dni), dostęp tylko dla uprawnionych.
- **Cyberbezpieczeństwo statku**: wymagania IACS UR E26/E27 i wytyczne IMO dla systemów na statkach; segmentacja sieci, aktualizacje, testy penetracyjne (pierwsze testy adwersaryjne już są).
- **Monitoring i CI**: testy przy każdym pushu (GitHub Actions), alarm gdy serwer padnie.

## 5. Kolejność (propozycja)

| Etap | Zakres |
|---|---|
| Teraz (hackathon) | klucz API, dane Jantar Unity, scenariusz demo, czytnik RFID, kiosk, głos 1–4 |
| Po hackathonie (1–2 mies.) | uwierzytelnianie, rozliczenie zbiórki z RFID, godziny odpoczynku, raport PSC, głos 5–8 (push-to-talk, komendy z potwierdzeniem), CI |
| Pilot (3–6 mies.) | serwer na statku + offline, integracje (centrala pożarowa, AIS), RODO/DPIA, cyberbezpieczeństwo, pilot z armatorem, głos 9–13 (STT/TTS offline, pełny dupleks, słowo budzące) |
