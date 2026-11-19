#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
Odczyt kart RFID (RC522 / MFRC522 / Velleman VMA405) na Raspberry Pi 4,
z interfejsem graficznym (Tkinter).

PODŁĄCZENIE czytnika -> Raspberry Pi (złącze 40-pin, numeracja fizyczna):
    SDA (SS) -> pin 24  (GPIO8,  SPI0 CE0)
    SCK      -> pin 23  (GPIO11, SPI0 SCLK)
    MOSI     -> pin 19  (GPIO10, SPI0 MOSI)
    MISO     -> pin 21  (GPIO9,  SPI0 MISO)
    IRQ      -> nie podłączać
    GND      -> pin 6
    RST      -> pin 22  (GPIO25)
    3.3V     -> pin 1   (UWAGA: tylko 3.3V, NIE 5V!)

Na tym Raspberry SPI jest już włączone (dtparam=spi=on), a użytkownik jest
w grupach spi i gpio, więc nie potrzeba sudo.

URUCHOMIENIE:
    python3 rfid_reader.py
    python3 rfid_reader.py --server http://192.168.1.10:8790 --terminal T-D4-01-A
    python3 rfid_reader.py --no-server        # bez wysyłania do bazy załogi

Każda odczytana karta jest wysyłana do bazy załogi (crew/, POST /api/checkin),
ustawienia w config.json - patrz serwer.py.
"""

import argparse
import csv
import datetime
import queue
import threading
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

try:
    import spidev
except ImportError:
    spidev = None

try:
    import RPi.GPIO as GPIO
except ImportError:
    GPIO = None

import serwer


# ----------------------------------------------------------------- konfiguracja
SPI_BUS = 0            # /dev/spidev0.0 -> bus 0, device 0 (CE0 = pin 24)
SPI_DEVICE = 0
SPI_SPEED_HZ = 1000000
RST_PIN = 22           # pin fizyczny (BOARD) podłączony do RST; None = nie sterujemy
POLL_INTERVAL = 0.1    # co ile sekund sprawdzać obecność karty
MISSES_TO_REMOVE = 3   # ile nieudanych odczytów z rzędu = karta zabrana


# ======================================================================
#  Sterownik MFRC522 (bezpośrednio przez spidev)
# ======================================================================
class MFRC522(object):
    CommandReg = 0x01
    CommIEnReg = 0x02
    CommIrqReg = 0x04
    ErrorReg = 0x06
    FIFODataReg = 0x09
    FIFOLevelReg = 0x0A
    ControlReg = 0x0C
    BitFramingReg = 0x0D
    ModeReg = 0x11
    TxControlReg = 0x14
    TxASKReg = 0x15
    TModeReg = 0x2A
    TPrescalerReg = 0x2B
    TReloadRegH = 0x2C
    TReloadRegL = 0x2D
    VersionReg = 0x37

    PCD_IDLE = 0x00
    PCD_TRANSCEIVE = 0x0C
    PCD_SOFTRESET = 0x0F

    PICC_REQIDL = 0x26
    PICC_ANTICOLL = 0x93

    OK = 0
    NOTAG = 1
    ERR = 2

    def __init__(self, bus=SPI_BUS, device=SPI_DEVICE, speed=SPI_SPEED_HZ, rst_pin=RST_PIN):
        if spidev is None:
            raise RuntimeError("Brak modułu spidev (sudo apt install python3-spidev)")
        self.spi = spidev.SpiDev()
        try:
            self.spi.open(bus, device)
        except (IOError, OSError) as e:
            raise RuntimeError(
                "Nie można otworzyć /dev/spidev%d.%d (%s).\n"
                "Włącz SPI: sudo raspi-config -> Interface Options -> SPI" % (bus, device, e))
        self.spi.max_speed_hz = speed
        self.spi.mode = 0

        self.rst_pin = None
        if GPIO is not None and rst_pin is not None:
            try:
                GPIO.setwarnings(False)
                GPIO.setmode(GPIO.BOARD)
                GPIO.setup(rst_pin, GPIO.OUT, initial=GPIO.HIGH)
                self.rst_pin = rst_pin
                GPIO.output(rst_pin, GPIO.LOW)      # sprzętowy reset
                time.sleep(0.05)
                GPIO.output(rst_pin, GPIO.HIGH)
                time.sleep(0.05)
            except Exception as e:
                print("[RFID] Uwaga: nie udało się ustawić pinu RST (%s). "
                      "Kontynuuję bez niego." % e)

        self.init()

    # ---------------------------------------------------------- niskopoziomowe
    def write_reg(self, addr, val):
        self.spi.xfer2([(addr << 1) & 0x7E, val & 0xFF])

    def read_reg(self, addr):
        return self.spi.xfer2([((addr << 1) & 0x7E) | 0x80, 0])[1]

    def set_bits(self, reg, mask):
        self.write_reg(reg, self.read_reg(reg) | mask)

    def clear_bits(self, reg, mask):
        self.write_reg(reg, self.read_reg(reg) & (~mask))

    # ---------------------------------------------------------------- obsługa
    def reset(self):
        self.write_reg(self.CommandReg, self.PCD_SOFTRESET)
        time.sleep(0.05)

    def init(self):
        self.reset()
        self.write_reg(self.TModeReg, 0x8D)
        self.write_reg(self.TPrescalerReg, 0x3E)
        self.write_reg(self.TReloadRegL, 30)
        self.write_reg(self.TReloadRegH, 0)
        self.write_reg(self.TxASKReg, 0x40)
        self.write_reg(self.ModeReg, 0x3D)
        self.antenna_on()

    def antenna_on(self):
        if (self.read_reg(self.TxControlReg) & 0x03) != 0x03:
            self.set_bits(self.TxControlReg, 0x03)

    def version(self):
        return self.read_reg(self.VersionReg)

    def _to_card(self, command, data):
        back_data = []
        back_len = 0
        status = self.ERR
        irq_en = 0x77
        wait_irq = 0x30

        self.write_reg(self.CommIEnReg, irq_en | 0x80)
        self.clear_bits(self.CommIrqReg, 0x80)
        self.set_bits(self.FIFOLevelReg, 0x80)          # wyczyść FIFO
        self.write_reg(self.CommandReg, self.PCD_IDLE)

        for b in data:
            self.write_reg(self.FIFODataReg, b)
        self.write_reg(self.CommandReg, command)
        if command == self.PCD_TRANSCEIVE:
            self.set_bits(self.BitFramingReg, 0x80)      # StartSend

        i = 2000
        while True:
            n = self.read_reg(self.CommIrqReg)
            i -= 1
            if i == 0 or (n & 0x01) or (n & wait_irq):
                break

        self.clear_bits(self.BitFramingReg, 0x80)

        if i != 0:
            if (self.read_reg(self.ErrorReg) & 0x1B) == 0x00:
                status = self.OK
                if n & irq_en & 0x01:
                    status = self.NOTAG
                if command == self.PCD_TRANSCEIVE:
                    n = self.read_reg(self.FIFOLevelReg)
                    last_bits = self.read_reg(self.ControlReg) & 0x07
                    back_len = (n - 1) * 8 + last_bits if last_bits else n * 8
                    n = max(1, min(n, 16))
                    back_data = [self.read_reg(self.FIFODataReg) for _ in range(n)]
            else:
                status = self.ERR

        return status, back_data, back_len

    def request(self):
        self.write_reg(self.BitFramingReg, 0x07)
        status, _, back_bits = self._to_card(self.PCD_TRANSCEIVE, [self.PICC_REQIDL])
        return status == self.OK and back_bits == 0x10

    def anticoll(self):
        self.write_reg(self.BitFramingReg, 0x00)
        status, data, _ = self._to_card(self.PCD_TRANSCEIVE, [self.PICC_ANTICOLL, 0x20])
        if status != self.OK or len(data) != 5:
            return None
        check = 0
        for b in data[:4]:
            check ^= b
        if check != data[4]:
            return None
        return data[:4]

    def read_uid(self):
        """Zwraca listę 4 bajtów UID lub None, gdy brak karty."""
        if not self.request():
            return None
        return self.anticoll()

    def close(self):
        try:
            self.spi.close()
        except Exception:
            pass
        if self.rst_pin is not None and GPIO is not None:
            try:
                GPIO.cleanup(self.rst_pin)
            except Exception:
                pass


def uid_to_str(uid):
    return ":".join("%02X" % b for b in uid)


def uid_to_int(uid):
    value = 0
    for b in uid:
        value = (value << 8) | b
    return value


# ======================================================================
#  Wątek odczytujący czytnik w tle
# ======================================================================
class RFIDWorker(threading.Thread):
    """Wysyła do kolejki zdarzenia:
        ("status", tekst) | ("error", tekst) | ("card", uid_str, uid_int) | ("removed", uid_str)
    """

    def __init__(self, out_queue):
        threading.Thread.__init__(self)
        self.daemon = True
        self.q = out_queue
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def run(self):
        reader = None
        try:
            reader = MFRC522()
            ver = reader.version()
            if ver in (0x00, 0xFF):
                raise RuntimeError(
                    "Brak komunikacji z czytnikiem (VersionReg=0x%02X).\n"
                    "Sprawdź przewody (MISO -> pin 21), lutowanie listwy\n"
                    "i zasilanie 3.3V (pin 1)." % ver)
            self.q.put(("status", "Czytnik OK (wersja układu 0x%02X)" % ver))

            last_uid = None
            misses = 0
            while not self._stop_event.is_set():
                uid = reader.read_uid()
                if uid:
                    misses = 0
                    if uid != last_uid:
                        last_uid = uid
                        self.q.put(("card", uid_to_str(uid), uid_to_int(uid)))
                else:
                    misses += 1
                    if last_uid is not None and misses >= MISSES_TO_REMOVE:
                        self.q.put(("removed", uid_to_str(last_uid)))
                        last_uid = None
                time.sleep(POLL_INTERVAL)
        except Exception as e:
            self.q.put(("error", str(e)))
        finally:
            if reader is not None:
                reader.close()


# ======================================================================
#  Panel GUI (osadzany też w rfid_kamera.py)
# ======================================================================
class RFIDPanel(ttk.Frame):
    def __init__(self, parent, on_card=None, on_removed=None, server_config=None, **kwargs):
        ttk.Frame.__init__(self, parent, padding=10, **kwargs)
        self.on_card = on_card
        self.on_removed = on_removed
        self.q = queue.Queue()
        self.server_q = queue.Queue()
        self.worker = None
        self.count = 0
        self.rows = {}           # nr odczytu -> id wiersza w tabeli (do wpisania wyniku z serwera)
        cfg = server_config if server_config is not None else serwer.load_config()
        self.client = serwer.CheckinClient(cfg, self.server_q.put)
        self._build()
        self.after(200, self._poll_server)

    def _build(self):
        ttk.Label(self, text="Czytnik RFID", font=("Helvetica", 16, "bold")).pack(anchor="w")

        self.status_var = tk.StringVar(value="Czytnik zatrzymany")
        self.status_lbl = tk.Label(self, textvariable=self.status_var, fg="gray",
                                   anchor="w", justify="left", wraplength=420)
        self.status_lbl.pack(fill="x", pady=(2, 8))

        card_box = tk.Frame(self, bd=2, relief="groove")
        card_box.pack(fill="x", pady=4)
        tk.Label(card_box, text="Ostatnia karta (UID):").pack(anchor="w", padx=8, pady=(6, 0))
        self.uid_var = tk.StringVar(value="--")
        tk.Label(card_box, textvariable=self.uid_var,
                 font=("Courier", 24, "bold")).pack(padx=8)
        self.dec_var = tk.StringVar(value="")
        tk.Label(card_box, textvariable=self.dec_var, fg="gray").pack(padx=8)
        self.person_var = tk.StringVar(value="")
        self.person_lbl = tk.Label(card_box, textvariable=self.person_var,
                                   font=("Helvetica", 13, "bold"), wraplength=420)
        self.person_lbl.pack(padx=8)
        self.presence_lbl = tk.Label(card_box, text="BRAK KARTY", bg="#888888", fg="white",
                                     font=("Helvetica", 12, "bold"))
        self.presence_lbl.pack(fill="x", padx=8, pady=8)

        # Baza załogi (POST /api/checkin)
        self.server_var = tk.StringVar(value=self.client.describe())
        self.server_lbl = tk.Label(self, textvariable=self.server_var, fg="gray",
                                   anchor="w", justify="left", wraplength=420)
        self.server_lbl.pack(fill="x", pady=(4, 0))

        ttk.Label(self, text="Historia odczytów:").pack(anchor="w", pady=(8, 2))
        tree_frame = ttk.Frame(self)
        tree_frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(tree_frame, columns=("nr", "czas", "uid", "dec", "serwer"),
                                 show="headings", height=10)
        for col, title, width in (("nr", "#", 40), ("czas", "Czas", 140),
                                  ("uid", "UID", 110), ("dec", "Dziesiętnie", 100),
                                  ("serwer", "Baza załogi", 180)):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=width, anchor="center")
        sb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        btns = ttk.Frame(self)
        btns.pack(fill="x", pady=(8, 0))
        self.start_btn = ttk.Button(btns, text="Start", command=self.toggle)
        self.start_btn.pack(side="left")
        ttk.Button(btns, text="Wyczyść", command=self.clear).pack(side="left", padx=4)
        ttk.Button(btns, text="Zapisz CSV", command=self.save_csv).pack(side="left")

    # ------------------------------------------------------------- sterowanie
    def start(self):
        if self.worker is not None and self.worker.is_alive():
            return
        self.worker = RFIDWorker(self.q)
        self.worker.start()
        self.status_var.set("Uruchamianie czytnika...")
        self.status_lbl.config(fg="gray")
        self.start_btn.config(text="Stop")
        self.after(100, self._poll)

    def stop(self):
        if self.worker is not None:
            self.worker.stop()
            self.worker.join(timeout=1.0)
            self.worker = None
        self.status_var.set("Czytnik zatrzymany")
        self.status_lbl.config(fg="gray")
        self.start_btn.config(text="Start")
        self._set_presence(False)

    def toggle(self):
        if self.worker is not None and self.worker.is_alive():
            self.stop()
        else:
            self.start()

    def close(self):
        self.stop()
        self.client.stop()

    # ------------------------------------------------------- odpowiedzi serwera
    def _set_row_status(self, uid_str, text):
        item = self.rows.get(uid_str)
        if item is not None and self.tree.exists(item):
            self.tree.set(item, "serwer", text)

    def _poll_server(self):
        try:
            while True:
                ev = self.server_q.get_nowait()
                kind = ev[0]
                if kind == "ok":
                    label = serwer.person_label(ev[2])
                    self.person_var.set(label)
                    self.person_lbl.config(fg="#2e7d32")
                    self._set_row_status(ev[1], label)
                    self.server_var.set(self.client.describe() + "\nOdbicie zapisane: " + label)
                    self.server_lbl.config(fg="green")
                    print("[SERWER] %s -> %s" % (ev[1], label))
                elif kind == "rejected":
                    self.person_var.set("Karta nieprzypisana w bazie załogi")
                    self.person_lbl.config(fg="#c62828")
                    self._set_row_status(ev[1], "odrzucone: " + ev[2])
                    self.server_var.set(self.client.describe() + "\nSerwer odrzucił kartę %s: %s" % (ev[1], ev[2]))
                    self.server_lbl.config(fg="red")
                    print("[SERWER] %s odrzucone: %s" % (ev[1], ev[2]))
                elif kind == "offline":
                    self.person_var.set("")
                    self._set_row_status(ev[1], "czeka na wysłanie")
                    self.server_var.set(self.client.describe() + "\nBRAK POŁĄCZENIA: %s\n"
                                        "Odbicia czekają w kolejce (%d)." % (ev[2], len(self.client.pending)))
                    self.server_lbl.config(fg="#e65100")
                    print("[SERWER] %s czeka: %s" % (ev[1], ev[2]))
                elif kind == "sent_pending":
                    self.server_var.set(self.client.describe() + "\nWysłano zaległe odbicia: %d" % ev[1])
                    self.server_lbl.config(fg="green")
        except queue.Empty:
            pass
        try:
            self.after(200, self._poll_server)
        except tk.TclError:
            pass   # okno zamknięte

    # --------------------------------------------------------------- zdarzenia
    def _poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                kind = ev[0]
                if kind == "status":
                    self.status_var.set(ev[1])
                    self.status_lbl.config(fg="green")
                elif kind == "error":
                    self.status_var.set("BŁĄD: " + ev[1])
                    self.status_lbl.config(fg="red")
                    self.start_btn.config(text="Ponów")
                    self.worker = None
                elif kind == "card":
                    self._card(ev[1], ev[2])
                elif kind == "removed":
                    self._set_presence(False)
                    if self.on_removed:
                        self.on_removed(ev[1])
        except queue.Empty:
            pass
        if self.worker is not None:
            self.after(100, self._poll)

    def _card(self, uid_str, uid_int):
        self.count += 1
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.uid_var.set(uid_str)
        self.dec_var.set("dziesiętnie: %d" % uid_int)
        self._set_presence(True)
        status = "wysyłanie..." if self.client.enabled else "-"
        item = self.tree.insert("", 0, values=(self.count, now, uid_str, uid_int, status))
        self.tree.selection_set(item)
        self.rows[uid_str] = item
        if self.client.enabled:
            self.person_var.set("Sprawdzam w bazie załogi...")
            self.person_lbl.config(fg="gray")
        self.client.send(uid_str)
        print("[RFID] %s  karta: %s  (%d)" % (now, uid_str, uid_int))
        if self.on_card:
            self.on_card(uid_str)

    def _set_presence(self, present):
        if present:
            self.presence_lbl.config(text="KARTA PRZY CZYTNIKU", bg="#2e9e3e")
        else:
            self.presence_lbl.config(text="BRAK KARTY", bg="#888888")

    def clear(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.count = 0
        self.rows = {}
        self.uid_var.set("--")
        self.dec_var.set("")
        self.person_var.set("")

    def save_csv(self):
        rows = [self.tree.item(i)["values"] for i in self.tree.get_children()]
        if not rows:
            messagebox.showinfo("Zapis", "Brak odczytów do zapisania.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv",
                                            filetypes=[("CSV", "*.csv")],
                                            initialfile="rfid_log.csv")
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["nr", "czas", "uid", "dziesietnie", "baza_zalogi"])
            for r in reversed(rows):
                w.writerow(r)
        messagebox.showinfo("Zapis", "Zapisano: " + path)


# ======================================================================
def main():
    p = argparse.ArgumentParser(description="Czytnik RFID z wysyłaniem odbić do bazy załogi")
    serwer.add_arguments(p)
    args = p.parse_args()

    root = tk.Tk()
    root.title("Raspberry Pi - czytnik RFID")
    root.geometry("640x700")

    panel = RFIDPanel(root, server_config=serwer.config_from_args(args))
    panel.pack(fill="both", expand=True)
    panel.start()

    def on_close():
        panel.close()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.bind("<Escape>", lambda e: on_close())
    root.mainloop()


if __name__ == "__main__":
    main()
