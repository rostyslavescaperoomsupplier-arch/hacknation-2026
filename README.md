# HackNation 2026

Projekt na hackathon HackNation 2026 (Bydgoszcz, 21-22.11.2026).

## Zawartość

| Folder | Co to jest |
|---|---|
| `mewka/` | Maskotka: animowana mewa 3D (three.js, model GLB) + fallback SVG + głos mewy z Web Audio. Strona demo ze wszystkimi stanami |
| `assistant/` | Asystentka Mewka: czat + rozmowa głosowa (mikrofon i czytanie odpowiedzi), odpowiedzi z Claude przez własny serwer, pamięta przebieg rozmowy |
| `crew/` | Terminal załogi: baza SQLite (pomieszczenia, załoga, terminale, odbicia) + panel statystyk w przeglądarce. `cd crew && npm start` → http://localhost:8790 |

## Asystentka: uruchomienie

```bash
cd mewka && npm install && cd ..
cd assistant && npm install
cp .env.example .env        # wpisz ANTHROPIC_API_KEY
npm run dev                 # serwer :8787 + front http://localhost:5173
```

Produkcja: `npm run build && npm start` (jeden proces, port 8787, serwuje też front).

Wiedzę asystentki (np. opis wybranego zadania) wpisuje się w `assistant/server/knowledge.md`. Kontakt pokazywany, gdy Mewka nie zna odpowiedzi: `assistant/src/i18n.ts` (`CONTACT`).

## Zadanie

TBD
