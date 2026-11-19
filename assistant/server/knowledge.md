# Wiedza asystentki Mewki (MF Jantar Unity, szkolenie załogi)

WAŻNE: to materiał szkoleniowy. Liczby i rozmieszczenie pomieszczeń pochodzą z uproszczonego modelu 3D użytego w aplikacji,
a procedury z ogólnej praktyki SOLAS / IMO. Obowiązujące dane i procedury są wyłącznie w dokumentach statku:
Muster List (rozkład alarmowy), plan ochrony przeciwpożarowej, SMS (system zarządzania bezpieczeństwem) i polecenia kapitana.
Gdy pytanie dotyczy konkretnych danych statku, których tu nie ma, Mewka mówi, że trzeba je sprawdzić w dokumentach statku
albo u oficera wachtowego.

## Statek (fakty publiczne)
- MF Jantar Unity to prom pasażersko-samochodowy typu ro-pax armatora Unity Line (grupa Polskiej Żeglugi Morskiej).
- Pływa na linii Świnoujście - Ystad (Polska - Szwecja) przez Bałtyk.
- Przewozi pasażerów, samochody osobowe i ciężarówki z naczepami.

## Model 3D w aplikacji (rekonstrukcja stylizowana, nie dokumentacja statku)
- Długość w modelu 195,6 m, szerokość 32,2 m.
- Pokłady w modelu, od dołu:
  - maszynownia i centrala manewrowo-kontrolna (CMK);
  - pokład samochodowy 1 i pokład samochodowy 2 (ładunek ro-ro);
  - pokład 3: kabiny (część dziobowa, śródokręcie, część rufowa), korytarz wzdłuż osi statku;
  - pokład 4: część publiczna, restauracja, salon, sala foteli lotniczych, recepcja;
  - pokład 5 (pokład szalupowy): łodzie ratunkowe po obu burtach i tratwy ratunkowe;
  - mostek nawigacyjny w części dziobowej nadbudówki.
- Dwie klatki schodowe przez wszystkie pokłady: rufowa i dziobowa. Z maszynowni wyjście na pokład samochodowy 1 klatką rufową.
- Miejsca zbiórki w modelu: A na rufowej części pokładu 5, B na dziobowej części pokładu 5, przy łodziach ratunkowych.
- Gdy jedna klatka jest zablokowana (dym, ogień), droga prowadzi drugą klatką.

## Sygnały i zasady ogólne (SOLAS / IMO)
- Alarm ogólny: siedem lub więcej krótkich sygnałów i jeden długi, dzwonkiem i syreną. Oznacza zbiórkę: załoga udaje się
  do swoich stanowisk według Muster List, pasażerowie do miejsc zbiórki.
- Opuszczenie statku zarządza wyłącznie kapitan, ustnie. Sam alarm ogólny nie oznacza opuszczenia statku.
- Każdy członek załogi ma przydział w Muster List i kartę z obowiązkami; musi go znać przed wyjściem w morze.

## Pożar
- Kolejność: zaalarmuj (ręczny ostrzegacz, okrzyk "pożar"), zgłoś na mostek miejsce, rodzaj i rozmiar pożaru,
  ogranicz (zamknij drzwi, drzwi pożarowe, wentylację, jeśli to Twoje zadanie), gaś podręcznym sprzętem tylko gdy to bezpieczne
  i masz drogę odwrotu. Potem działaj według poleceń z mostka i grupy awaryjnej.
- Nie używaj wind. Ewakuuj ludzi z zagrożonej strefy drogą omijającą dym.
- Pożar w maszynowni może wymagać użycia stałej instalacji gaśniczej; decyzję podejmuje kapitan lub starszy mechanik,
  a przed uruchomieniem trzeba upewnić się, że w pomieszczeniu nikt nie został.

## Człowiek za burtą (MOB)
- Krzycz "człowiek za burtą" i podaj burtę, rzuć koło ratunkowe z pławką świetlno-dymną, nie trać człowieka z oczu
  i wskazuj go ręką, natychmiast zgłoś na mostek. Mostek oznacza pozycję (przycisk MOB), wykonuje manewr i ogłasza alarm.
- Przygotowanie łodzi ratowniczej (szybkiej) według Muster List.

## Opuszczenie statku
- Tylko na polecenie kapitana. Załoga prowadzi pasażerów do miejsc zbiórki, sprawdza kamizelki ratunkowe,
  liczy osoby i melduje, przygotowuje łodzie i tratwy według przydziału.

## Inne
- Przeciek i zalanie: alarm, zgłoszenie na mostek, zamknięcie drzwi wodoszczelnych na polecenie, nie przechodzić przez
  zamykające się drzwi wodoszczelne.
- Zanieczyszczenie olejem: zgłoszenie na mostek, zatrzymanie źródła, procedura SOPEP.
- Zanik zasilania (blackout): oświetlenie awaryjne i agregat awaryjny startują automatycznie; maszynownia przywraca zasilanie,
  załoga uspokaja pasażerów i czeka na komunikaty.
- Nagły wypadek medyczny: zabezpiecz miejsce, wezwij pomoc i oficera odpowiedzialnego za opiekę medyczną przez mostek,
  udziel pierwszej pomocy w zakresie swojego przeszkolenia.

## Ćwiczenia (ogólnie wg SOLAS)
- Ćwiczenia opuszczania statku i ćwiczenia przeciwpożarowe: na statku pasażerskim co tydzień
  (każdy członek załogi uczestniczy co najmniej raz w miesiącu).
- Gdy w rejsie ponad 25% załogi nie brało udziału w ćwiczeniach na tym statku w ostatnim miesiącu, ćwiczenie przed wyjściem lub
  zaraz po wyjściu w morze.
- Ćwiczenia człowiek za burtą, przeciekowe, rozlewu oleju i inne według planu ćwiczeń w SMS.


## Smart opaski załogi (koncepcja, w budowie)
Załoga może nosić opaskę z tagiem RFID zamiast karty: odbicie przy terminalach i stacjach zbiórki. Docelowo opaska ma też BLE (strefa, w której jest osoba), silnik wibracyjny (alarm wyczuwalny w hałasie i przez sen, wzór zależny od rodzaju alarmu, potwierdzenie przyciskiem), akcelerometr (upadek, bezruch przy pracy w pojedynkę), czujnik zanurzenia (automatyczny alarm człowiek za burtą) oraz pomiar tętna, SpO2 i temperatury skóry (stres cieplny, zmęczenie). Na mostek trafiają tylko alerty, nie surowe dane medyczne (RODO art. 9). Na dziś działa tylko identyfikacja RFID opaski; wibracje i czujniki to plan.
