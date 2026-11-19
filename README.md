# HackNation 2026

Projekt na hackathon HackNation 2026 (Bydgoszcz, 21-22.11.2026).

## Zawartość

| Folder | Co to jest |
|---|---|
| `mewka/` | Maskotka: animowana mewa 3D (three.js, model GLB) + fallback SVG + głos mewy z Web Audio. Strona demo ze wszystkimi stanami |
| `assistant/` | **Asystent załogi MF Jantar Unity**: zakładki Asystent (czat + rozmowa głosowa z Mewką, odpowiedzi z Claude, pamięta rozmowę, proponuje drogę ewakuacji / ćwiczenie), Statek 3D (model promu, pokład kabinowy, maszynownia), Ewakuacja (trasa z dowolnej strefy do punktu zbiórki A/B, objazd przy zablokowanej klatce), Ćwiczenia (pożar, opuszczenie statku, człowiek za burtą, przeciek, rozlew, blackout, medyczne: sygnał, role, checklista, stoper, dziennik CSV) |

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

System pomocy dla załogi i kapitana promu (MF Jantar Unity). Materiał szkoleniowy wg ogólnej praktyki SOLAS / IMO; wiążące są Muster List i SMS statku. Model 3D to stylizowana rekonstrukcja, nie plany statku.
