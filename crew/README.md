# Terminal załogi: baza danych i statystyki

Cyfrowy pomocnik załogi statku. Członek załogi przykłada kartę do terminala w pomieszczeniu, a system zapisuje, gdzie teraz jest. Panel w przeglądarce pokazuje statystyki pomieszczeń: nazwy, role, liczbę osób i obłożenie.

## Uruchomienie

Wymaga Node 24 lub nowszego. Nie ma zależności do instalowania: baza to wbudowany `node:sqlite`.

```bash
cd crew
npm start          # http://localhost:8790
npm run dev        # to samo, z restartem po zmianie kodu
npm run seed       # wyczyść bazę i wygeneruj przykładowe dane od nowa
npm run simulate   # demo bez sprzętu: udaje terminale i co 2,5 s wysyła odbicia do API (serwer musi działać)
```

Terminale to fizyczne urządzenia (czytniki kart przy pomieszczeniach). Każdy po przyłożeniu karty wysyła `POST /api/checkin`. Panel w przeglądarce służy tylko do podglądu i niczego nie zapisuje.

Przy pierwszym starcie z pustą bazą przykładowe dane generują się same. Baza leży w `crew/data/crew.db` i nie trafia do gita. Inną ścieżkę można podać przez `CREW_DB`, a inny port przez `PORT`.

## Model danych (`server/db.ts`)

| Tabela | Co zawiera |
|---|---|
| `decks` | pokłady statku (poziom, nazwa) |
| `rooms` | pomieszczenia: kod, nazwa, rola (Nawigacja, Maszynownia, Kwatery…), opis, pokład, powierzchnia m², bezpieczna pojemność, czy dostęp jest ograniczony |
| `crew` | załoga: numer karty, imię, nazwisko, stanowisko, dział, wachta, narodowość, data urodzenia, telefon wewnętrzny, kabina, data zaokrętowania |
| `terminals` | terminale (czytniki kart) i pomieszczenie, w którym wiszą |
| `checkins` | log odbić: kto, który terminal, które pomieszczenie, `in`/`out`, kiedy |

Widoki: `last_checkin` to ostatnie odbicie każdej osoby, a `crew_location` to miejsce, w którym ktoś jest teraz. Ostatnie odbicie `in` oznacza, że osoba jest w tym pomieszczeniu, a `out` albo brak odbić oznacza, że jest poza systemem, np. na lądzie.

Statystyki pomieszczenia:
- **osoby**: liczba osób, które mają tu aktualne odbicie,
- **obłożenie**: osoby / pojemność × 100% (OK < 70%, Wysokie 70–99%, Przekroczone ≥ 100%).

Bezpieczeństwo (`server/alerts.ts`). Liczone przez odtworzenie logu odbić w kolejności czasu. Progi są w `LIMITS`.
- **Obsada stanowisk**: pomieszczenia z `rooms.min_staff > 0` w godzinach `rooms.staff_hours`. W przykładowych danych to mostek (min. 2 osoby, cała doba), centrala manewrowa ECR (min. 1, cała doba) i kuchnia (min. 1, 06–19). Widać, czy obsada jest teraz pełna, od kiedy jej brakuje i przez jaką część ostatnich 24 h była pełna.
- **Praca w pojedynkę**: ktoś jest sam w pomieszczeniu z `rooms.hazardous = 1` (maszynownia, warsztat, pompownia, chłodnie). Ostrzeżenie po 30 min, alarm po 60 min.
- **Czas od ostatniego odbicia**: ostrzeżenie po 4 h, alarm po 8 h. We własnej kabinie progi wynoszą 12 h i 16 h, bo to sen i odpoczynek. Może oznaczać zgubioną kartę albo osobę, którą trzeba sprawdzić.

## Przykładowe dane (`server/seed.ts`)

Kontenerowiec „MS Brda”: 4 pokłady, 24 pomieszczenia, 28 terminali i 45 osób załogi w działach Pokład, Maszynownia, Hotel i Medyczny, z realistycznymi stanowiskami i wachtami. Do tego około 800 odbić z ostatnich 24 godzin, wygenerowanych według grafiku: na wachcie w miejscu pracy, w porze posiłku w mesie, w nocy w kabinie, a poza tym w świetlicy lub siłowni. Trzy osoby są na lądzie, a dwie nie odbiły się od około 5,5 h i 9 h (do pokazania alertów). Oficer i obserwator wachtowy stoją na mostku, a mechanik wachtowy w ECR. Generator jest deterministyczny (zawsze ta sama załoga), ale czasy liczy względem „teraz”.

## API

| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/api/summary` | liczby zbiorcze |
| GET | `/api/rooms` | pomieszczenia ze statystykami |
| GET | `/api/rooms/:id` | pomieszczenie i lista osób w środku |
| GET | `/api/crew?q=` | załoga z aktualnym położeniem (wyszukiwanie) |
| GET | `/api/terminals` | lista terminali |
| GET | `/api/activity` | odbicia na godzinę, ostatnie 24 h |
| GET | `/api/alerts` | obsada stanowisk, praca w pojedynkę, czas od ostatniego odbicia |
| POST | `/api/checkin` | wysyła go fizyczny terminal: `{ "badge": "B-1001", "terminal": "T-D4-01-A", "direction": "in" }` (`direction`: `in` albo `out`, domyślnie `in`) |

## Panel w przeglądarce (`public/`)

Tylko do podglądu, odświeża się co 5 s.

- **Obsada i alerty** (zakładka domyślna; liczba alertów jest na zakładce): karty obsady stanowisk, lista osób pracujących w pojedynkę i tabela czasu od ostatniego odbicia.
- **Pomieszczenia**: plan statku z pokładami, gdzie szerokość kafelka odpowiada powierzchni, a kolor obłożenia. Do tego wykres osób według roli pomieszczenia, wykres odbić w każdej godzinie i sortowana tabela wszystkich pomieszczeń. Kliknięcie otwiera szczegóły z listą osób.
- **Załoga**: tabela z danymi i aktualnym położeniem, z wyszukiwarką.
