"""Podgląd na żywo danych z ESP32 (MAX30102 tętno/SpO2 + ADXL345 akcelerometr) w terminalu.

Firmware wysyła po serialu (115200) linie w stylu:
    HR: 72  SpO2: 98        (albo "HR: --  SpO2: --" gdy brak palca)
    ACC [m/s^2] X: -0.314  Y: 4.354  Z: 9.885

Użycie:
    py -3 monitor.py              # sam znajdzie port ESP
    py -3 monitor.py COM12        # konkretny port
    py -3 monitor.py --raw        # tylko surowe linie
    py -3 monitor.py --reset      # zresetuj ESP przy otwarciu portu
"""
import argparse
import math
import os
import re
import sys
import time
from collections import deque

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("Brak pyserial. Zainstaluj: py -3 -m pip install pyserial")

G = 9.80665
RE_HR = re.compile(r"HR:\s*(--|-?\d+(?:\.\d+)?)", re.I)
RE_SPO2 = re.compile(r"SpO2:\s*(--|-?\d+(?:\.\d+)?)", re.I)
RE_ACC = re.compile(
    r"X:\s*(-?\d+(?:\.\d+)?)\s+Y:\s*(-?\d+(?:\.\d+)?)\s+Z:\s*(-?\d+(?:\.\d+)?)", re.I
)
USB_HINTS = ("CP210", "CH340", "CH910", "USB-SERIAL", "USB SERIAL", "UART", "FTDI", "JTAG")


def find_port():
    ports = list(list_ports.comports())
    for p in ports:
        desc = f"{p.description} {p.manufacturer or ''}".upper()
        if any(h in desc for h in USB_HINTS) or p.vid in (0x10C4, 0x1A86, 0x303A, 0x0403):
            return p.device
    names = ", ".join(f"{p.device} ({p.description})" for p in ports) or "brak"
    sys.exit(f"Nie znalazłem ESP. Dostępne porty: {names}. Podaj port, np. monitor.py COM12")


def open_port(port, baud, reset):
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, baud, 0.2
    if not reset:
        s.dtr = False  # bez tego otwarcie portu restartuje ESP32
        s.rts = False
    s.open()
    if reset:
        s.dtr = False
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    return s


def num(v):
    return None if v == "--" else float(v)


def bar(value, lo, hi, width=24):
    if value is None:
        return "·" * width
    frac = min(max((value - lo) / (hi - lo), 0.0), 1.0)
    n = round(frac * width)
    return "█" * n + "·" * (width - n)


def centered_bar(value, limit, width=25):
    """Pasek z zerem na środku, dla osi akcelerometru."""
    half = width // 2
    cells = ["·"] * width
    cells[half] = "│"
    if value is not None:
        n = round(min(abs(value) / limit, 1.0) * half)
        for i in range(1, n + 1):
            cells[half + i if value > 0 else half - i] = "█"
    return "".join(cells)


def spark(values, width=40):
    chars = "▁▂▃▄▅▆▇█"
    vals = [v for v in list(values)[-width:] if v is not None]
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    span = hi - lo or 1
    return "".join(chars[int((v - lo) / span * (len(chars) - 1))] for v in vals)


class State:
    def __init__(self):
        self.hr = self.spo2 = None
        self.acc = None
        self.jerk = 0.0  # zmiana wektora przyspieszenia między kolejnymi próbkami
        self.t_hr = self.t_acc = 0.0
        self.hr_hist = deque(maxlen=60)
        self.mag_hist = deque(maxlen=60)
        self.log = deque(maxlen=6)
        self.lines = 0

    def feed(self, line):
        self.lines += 1
        now = time.time()
        m_hr, m_sp, m_acc = RE_HR.search(line), RE_SPO2.search(line), RE_ACC.search(line)
        if m_hr or m_sp:
            self.hr = num(m_hr.group(1)) if m_hr else self.hr
            self.spo2 = num(m_sp.group(1)) if m_sp else self.spo2
            self.t_hr = now
            if self.hr is not None:
                self.hr_hist.append(self.hr)
        if m_acc:
            acc = tuple(float(g) for g in m_acc.groups())
            if self.acc:
                self.jerk = math.dist(acc, self.acc)
            self.acc = acc
            self.t_acc = now
            self.mag_hist.append(math.sqrt(sum(a * a for a in self.acc)))
        if not (m_hr or m_sp or m_acc):
            self.log.append(line)


def age(t):
    if not t:
        return "brak danych"
    d = time.time() - t
    return f"{d:4.1f} s temu" + ("  (!) cisza" if d > 5 else "")


def render(st, port):
    out = []
    w = out.append
    w(f"\x1b[1mESP monitor\x1b[0m  port {port}  linii: {st.lines}   Ctrl+C = wyjście")
    w("")

    hr = f"{st.hr:5.0f} bpm" if st.hr is not None else "   -- bpm"
    sp = f"{st.spo2:5.0f} %  " if st.spo2 is not None else "   -- %  "
    w("\x1b[1;31m♥ TĘTNO\x1b[0m   (MAX30102)   " + age(st.t_hr))
    w(f"  HR    {hr}  {bar(st.hr, 40, 180)}")
    w(f"  SpO2  {sp}  {bar(st.spo2, 80, 100)}")
    w(f"  trend {spark(st.hr_hist)}")
    if st.hr is None:
        w("  \x1b[2mpołóż palec na czujniku i trzymaj nieruchomo\x1b[0m")
    w("")

    w("\x1b[1;36m↻ RUCH\x1b[0m    (ADXL345, m/s²)   " + age(st.t_acc))
    if st.acc:
        x, y, z = st.acc
        mag = math.sqrt(x * x + y * y + z * z)
        for name, v in (("X", x), ("Y", y), ("Z", z)):
            w(f"  {name}  {v:+8.3f}  {centered_bar(v, 2 * G)}")
        roll = math.degrees(math.atan2(y, z))
        pitch = math.degrees(math.atan2(-x, math.hypot(y, z)))
        dyn = st.jerk
        state = "spokój" if dyn < 0.6 else "ruch" if dyn < 4 else "WSTRZĄS / UPADEK?"
        color = "32" if dyn < 0.6 else "33" if dyn < 4 else "1;41"
        w(f"  |a| {mag:6.2f} m/s² ({mag / G:4.2f} g)   przechył: roll {roll:+6.1f}°  pitch {pitch:+6.1f}°")
        w(f"  stan \x1b[{color}m{state}\x1b[0m (Δ {dyn:4.2f})   |a| {spark(st.mag_hist)}")
    else:
        w("  brak danych")
    w("")

    w("\x1b[2mInne komunikaty ESP:\x1b[0m")
    for line in st.log:
        w("  \x1b[2m" + line[:100] + "\x1b[0m")
    # \x1b[K czyści resztę linii, \x1b[J resztę ekranu
    return "\x1b[H" + "\n".join(l + "\x1b[K" for l in out) + "\x1b[J"


def main():
    ap = argparse.ArgumentParser(description="Podgląd tętna i akcelerometru z ESP po COM")
    ap.add_argument("port", nargs="?", help="np. COM12 (domyślnie: wykryj)")
    ap.add_argument("-b", "--baud", type=int, default=115200)
    ap.add_argument("--raw", action="store_true", help="wypisuj surowe linie")
    ap.add_argument("--reset", action="store_true", help="zresetuj ESP przy połączeniu")
    args = ap.parse_args()

    os.system("")  # włącza kody ANSI w konsoli Windows
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    port = args.port or find_port()
    st = State()
    ser = None
    last_draw = 0.0
    if not args.raw:
        print("\x1b[2J\x1b[?25l", end="")  # wyczyść ekran, ukryj kursor
    try:
        while True:
            if ser is None:
                try:
                    ser = open_port(port, args.baud, args.reset)
                    st.log.append(f"połączono z {port}")
                except serial.SerialException as e:
                    st.log.append(f"nie mogę otworzyć {port}: {e}. Ponawiam...")
                    if args.raw:
                        print(st.log[-1])
                    time.sleep(2)
            else:
                try:
                    raw = ser.readline()
                except serial.SerialException:
                    st.log.append("rozłączono, ponawiam...")
                    ser.close()
                    ser = None
                    raw = b""
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    if args.raw:
                        print(time.strftime("%H:%M:%S"), line, flush=True)
                    st.feed(line)
            if not args.raw and time.time() - last_draw > 0.1:
                print(render(st, port), end="", flush=True)
                last_draw = time.time()
    except KeyboardInterrupt:
        pass
    finally:
        if not args.raw:
            print("\x1b[?25h")
        if ser:
            ser.close()


if __name__ == "__main__":
    main()
