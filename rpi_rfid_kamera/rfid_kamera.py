#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
Raspberry Pi 4: podgląd kamery + czytnik RFID w jednym oknie.

Po przyłożeniu karty:
  - UID pojawia się w panelu RFID i jako napis na obrazie z kamery,
  - (opcjonalnie) zapisywane jest zdjęcie z UID w nazwie pliku -> folder "zdjecia".

WYMAGA w tym samym folderze: rfid_reader.py i kamera_podglad.py
(instrukcja podłączenia czytnika jest na początku rfid_reader.py).

URUCHOMIENIE:
    python3 rfid_kamera.py
    python3 rfid_kamera.py --flip 2      # obrót obrazu o 180°
    python3 rfid_kamera.py --usb 0       # kamera USB zamiast CSI
    python3 rfid_kamera.py --server http://192.168.1.10:8790 --terminal T-D4-01-A

Każda karta jest też wysyłana do bazy załogi (crew/, POST /api/checkin),
a panel RFID pokazuje, kto się odbił. Ustawienia: config.json (patrz serwer.py).

SKRÓTY: Spacja = zdjęcie, Esc = wyjście
"""

import argparse
import datetime
import tkinter as tk
from tkinter import ttk

import serwer
from rfid_reader import RFIDPanel
from kamera_podglad import CameraPanel


class App(object):
    def __init__(self, root, args):
        self.root = root
        root.title("Raspberry Pi - kamera + RFID")

        main = ttk.Frame(root)
        main.pack(fill="both", expand=True)

        # Lewa strona: kamera
        left = ttk.Frame(main)
        left.pack(side="left", fill="both", expand=True)
        self.camera = CameraPanel(left, flip_method=args.flip, usb_index=args.usb)
        self.camera.pack(fill="x")

        opts = ttk.LabelFrame(left, text="Akcje przy odczycie karty", padding=8)
        opts.pack(fill="x", padx=10, pady=(0, 10))
        self.auto_photo = tk.BooleanVar(value=True)
        self.show_uid = tk.BooleanVar(value=True)
        ttk.Checkbutton(opts, text="Zrób zdjęcie", variable=self.auto_photo).pack(side="left")
        ttk.Checkbutton(opts, text="Pokaż UID na obrazie",
                        variable=self.show_uid).pack(side="left", padx=12)

        self.event_var = tk.StringVar(value="Czekam na kartę...")
        ttk.Label(left, textvariable=self.event_var, font=("Helvetica", 11, "bold")).pack(
            anchor="w", padx=10, pady=(0, 10))

        # Prawa strona: RFID
        ttk.Separator(main, orient="vertical").pack(side="left", fill="y", pady=10)
        self.rfid = RFIDPanel(main, on_card=self.on_card, on_removed=self.on_removed,
                              server_config=serwer.config_from_args(args))
        self.rfid.pack(side="left", fill="both", expand=True)

        root.protocol("WM_DELETE_WINDOW", self.close)
        root.bind("<Escape>", lambda e: self.close())
        root.bind("<space>", lambda e: self.camera.take_photo())

        self.camera.start_camera()
        self.rfid.start()

    def on_card(self, uid_str):
        now = datetime.datetime.now().strftime("%H:%M:%S")
        msg = "%s  karta %s" % (now, uid_str)
        if self.show_uid.get():
            self.camera.show_overlay("Karta: " + uid_str, seconds=3.0)
        if self.auto_photo.get():
            path = self.camera.take_photo(tag=uid_str.replace(":", ""))
            msg += "  ->  zdjęcie zapisane" if path else "  (brak obrazu - bez zdjęcia)"
        self.event_var.set(msg)

    def on_removed(self, uid_str):
        self.event_var.set(self.event_var.get() + "   [zabrana]")

    def close(self):
        self.rfid.close()
        self.camera.close()
        self.root.destroy()


def parse_args():
    p = argparse.ArgumentParser(description="Kamera + RFID na Raspberry Pi")
    p.add_argument("--flip", type=int, default=0, help="0 = brak, 2 = obrót 180°")
    p.add_argument("--usb", type=int, default=None, help="indeks kamery USB zamiast CSI")
    serwer.add_arguments(p)
    return p.parse_args()


def main():
    args = parse_args()
    root = tk.Tk()
    App(root, args)
    root.mainloop()


if __name__ == "__main__":
    main()
