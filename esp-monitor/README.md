# esp-monitor

Podgląd na żywo danych z ESP32 po porcie COM: tętno i SpO2 (MAX30102) oraz akcelerometr (ADXL345).

```
py -3 -m pip install -r requirements.txt
py -3 monitor.py            # sam znajdzie port (CP210x, CH340, ESP32-S3/C3 USB)
py -3 monitor.py COM12      # albo podaj port
py -3 monitor.py --raw      # surowe linie z ESP ze znacznikiem czasu
```

Port otwierany jest bez resetu ESP (DTR/RTS wyłączone). `--reset` restartuje płytkę przy połączeniu.
Po odłączeniu kabla skrypt sam ponawia połączenie. Zamknij Serial Monitor w Arduino/PlatformIO,
bo port może mieć otwarty tylko jeden program.

Oczekiwany format linii (115200 baud):

```
HR: 72  SpO2: 98
ACC [m/s^2] X: -0.314  Y: 4.354  Z: 9.885
```

Pozostałe linie (np. `AP started`, `MAX30102 ready`) trafiają do sekcji „Inne komunikaty ESP”.
