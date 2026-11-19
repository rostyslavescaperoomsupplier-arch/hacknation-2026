# Dokumenty statku dla asystenta (Mewka)

Ten folder to miejsce na dokumenty statku, z których asystent ma odpowiadać: procedury SMS, Muster List, plany
ewakuacji, checklisty alarmowe, instrukcje urządzeń.

## Jak dodać dokument

1. Wrzuć plik do tego folderu (`server/knowledge/`).
2. Zrestartuj serwer (`npm run start` lokalnie, na serwerze `systemctl restart jantar-assistant`). Dokumenty są
   wczytywane tylko przy starcie.
3. Sprawdź `GET /api/health`: pole `knowledge.files` pokazuje, ile plików zostało wczytanych, a log startowy
   wymienia ich nazwy.

## Obsługiwane formaty

- `.md` i `.txt` (UTF-8): wysyłane jako dokument tekstowy.
- `.pdf`: wysyłany w całości jako blok `document` zakodowany w base64. Claude czyta tekst i obraz stron, więc
  skany też działają, ale PDF z warstwą tekstową daje lepsze cytaty (z numerem strony).

Inne pliki oraz ten `README.md` są pomijane.

## Jak to działa

Każdy plik staje się blokiem `document` z włączonymi cytatami (`citations: { enabled: true }`) i tytułem równym nazwie
pliku bez rozszerzenia. Dokumenty trafiają na początek pierwszej wiadomości użytkownika w każdym zapytaniu i są
cache'owane, więc kolejne pytania nie płacą pełnej ceny za ich ponowne wysłanie. Cytaty z odpowiedzi trafiają do
`sources` jako `{ label: "<tytuł> - <cytowany fragment>", href: "#doc:<plik>" }` (maks. 4).

Pusty folder = asystent działa tak jak wcześniej, tylko na `server/knowledge.md`.

## Rozmiar

- Plik większy niż 5 MB jest pomijany (ostrzeżenie w logu). Łącznie wczytywane jest do 20 MB.
- Wszystkie dokumenty idą w każdym zapytaniu, więc liczy się każda strona: wrzucaj tylko to, czego załoga
  naprawdę potrzebuje. Kilka do kilkudziesięciu stron na dokument to rozsądna skala; duże podręczniki lepiej
  podzielić na rozdziały i wybrać potrzebne.
- Nazywaj pliki opisowo (np. `procedura-pozarowa-poklad-3.pdf`): nazwa jest tytułem widocznym w źródłach.

## Uwaga

Nie wrzucaj tu danych osobowych załogi ani pasażerów. Pliki oznaczone jako przykład lub materiał szkoleniowy
asystent tak właśnie przedstawia.
