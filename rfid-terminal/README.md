# Terminal RFID na Raspberry Pi

Fizyczny terminal dla bazy załogi (`crew/`). Członek załogi przykłada kartę do czytnika RC522 / VMA405, a terminal
wysyła `POST /api/checkin` (`{ rfid, terminal, direction }`) i pokazuje w oknie, kto się odbił. Opcjonalnie robi też
zdjęcie z kamery.

| Plik | Co robi |
|---|---|
| `rfid_reader.py` | okno czytnika: UID, osoba z bazy, historia odczytów z wynikiem z serwera, zapis CSV |
| `kamera_podglad.py` | okno podglądu kamery (Camera Module 3 przez Picamera2 albo kamera USB), zdjęcia spacją |
| `rfid_kamera.py` | kamera i czytnik w jednym oknie; po odbiciu napis na obrazie i zdjęcie z UID w nazwie |
| `serwer.py` | wysyłanie odbić do bazy załogi w tle, z kolejką odbić, które czekają, gdy serwer nie odpowiada |

## Podłączenie czytnika (złącze 40-pin)

SDA/NSS → 24, SCK → 23, MOSI → 19, MISO → 21, RST → 22, GND → 6, 3.3V → 1 (nie 5V), IRQ niepodłączone.
SPI musi być włączone (`raspi-config` → Interface Options → SPI).

## Ustawienia serwera

`config.json` tworzy się przy pierwszym uruchomieniu (nie trafia do gita):

```json
{ "enabled": true, "server": "http://localhost:8790", "terminal": "T-D4-01-A", "direction": "in", "timeout_s": 3 }
```

Kod terminala musi istnieć w bazie (`GET /api/terminals`). `T-D4-01-A` to mostek nawigacyjny. Te same ustawienia
można podać jednorazowo z linii poleceń: `--server`, `--terminal`, `--direction in|out`, `--key` albo `--no-server`.

Karta musi być przypisana do osoby w bazie (`crew.rfid_uid`). Jeśli nie jest, serwer odpowiada 404 „Nieznany
identyfikator RFID”, a okno pokazuje „Karta nieprzypisana w bazie załogi”.

Gdy serwer bazy działa na laptopie, a zapora blokuje połączenia przychodzące, wystarczy tunel SSH uruchomiony
z laptopa (Raspberry widzi wtedy bazę pod `http://localhost:8790`):

```
ssh -N -R 8790:localhost:8790 user@<adres-raspberry>
```

Na serwerze demo (`jantar.byst.re`) baza załogi przyjmuje połączenia tylko z localhost, więc odbicia przyjmuje
asystent: to samo `POST /api/checkin`, z kluczem urządzenia w nagłówku `x-terminal-key`
(`assistant/server/terminals.ts`). Klucz to `TERMINAL_KEY` z `/etc/jantar-assistant.env` (gdy go nie ma, działa
`BAND_KEY` opasek). Bez żadnego klucza na serwerze odbicia z zewnątrz są odrzucane (403).

```json
{ "enabled": true, "server": "https://jantar.byst.re", "terminal": "T-D4-01-A", "direction": "in", "key": "<TERMINAL_KEY>", "timeout_s": 3 }
```

## Karty

Czytnik odczytuje UID 4-bajtowe (MIFARE Classic, np. `59:BA:E9:5A`) i 7-bajtowe (NTAG, Ultralight, DESFire, np.
`04:95:34:A7:E8:60:AC`, drugi poziom kaskady). Serwer porównuje same cyfry szesnastkowe, więc separatory nie mają
znaczenia.

## Uruchomienie

```
python3 rfid_reader.py
python3 rfid_kamera.py --flip 2
```

Programy z kamerą nie mogą działać jednocześnie, bo kamerę CSI może używać tylko jeden z nich naraz.
