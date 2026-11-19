#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
Podgląd kamery na Raspberry Pi 4 (Camera Module 3 / imx708 przez Picamera2,
albo kamera USB przez OpenCV) z interfejsem graficznym (Tkinter).

URUCHOMIENIE:
    python3 kamera_podglad.py              # kamera CSI (taśma)
    python3 kamera_podglad.py --flip 2     # obrót o 180°
    python3 kamera_podglad.py --usb 0      # kamera USB zamiast CSI

SKRÓTY: Spacja = zdjęcie, Esc = wyjście
Zdjęcia trafiają do folderu "zdjecia" obok programu.

Uwaga: kamerę CSI może używać tylko jeden program naraz - zamknij
kamera_podglad.py zanim uruchomisz rfid_kamera.py (i odwrotnie).
"""

import argparse
import datetime
import os
import threading
import time
import tkinter as tk
from tkinter import ttk

from PIL import Image, ImageDraw, ImageFont, ImageTk

HERE = os.path.dirname(os.path.abspath(__file__))
PHOTO_DIR = os.path.join(HERE, "zdjecia")

CAPTURE_SIZE = (1280, 720)   # rozdzielczość pobierana z kamery (zdjęcia)
VIEW_SIZE = (800, 450)       # rozmiar podglądu w oknie


def _load_font(size):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


# ======================================================================
#  Źródła obrazu (wątek w tle trzyma najnowszą klatkę jako PIL.Image RGB)
# ======================================================================
class _CameraSource(object):
    def __init__(self):
        self._frame = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.error = None

    def latest(self):
        with self._lock:
            return self._frame

    def _set(self, img):
        with self._lock:
            self._frame = img

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)


class PiCameraSource(_CameraSource):
    """Kamera CSI przez Picamera2 (libcamera)."""

    def __init__(self, flip_method=0):
        _CameraSource.__init__(self)
        from picamera2 import Picamera2
        from libcamera import Transform
        hflip = flip_method in (2, 4)
        vflip = flip_method in (2, 6)
        self.cam = Picamera2()
        # "BGR888" w Picamera2 daje tablicę w kolejności R,G,B - gotową dla PIL
        cfg = self.cam.create_video_configuration(
            main={"size": CAPTURE_SIZE, "format": "BGR888"},
            transform=Transform(hflip=hflip, vflip=vflip))
        self.cam.configure(cfg)
        self.cam.start()

    def _run(self):
        try:
            while not self._stop.is_set():
                arr = self.cam.capture_array("main")
                self._set(Image.fromarray(arr[:, :, :3]))
        except Exception as e:
            self.error = str(e)
        finally:
            try:
                self.cam.stop()
                self.cam.close()
            except Exception:
                pass


class USBCameraSource(_CameraSource):
    """Kamera USB przez OpenCV."""

    def __init__(self, index=0, flip_method=0):
        _CameraSource.__init__(self)
        import cv2
        self.cv2 = cv2
        self.flip_method = flip_method
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            raise RuntimeError("Nie można otworzyć kamery USB nr %d" % index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_SIZE[0])
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_SIZE[1])

    def _run(self):
        cv2 = self.cv2
        try:
            while not self._stop.is_set():
                ok, frame = self.cap.read()
                if not ok:
                    time.sleep(0.05)
                    continue
                if self.flip_method == 2:
                    frame = cv2.flip(frame, -1)
                elif self.flip_method == 4:
                    frame = cv2.flip(frame, 1)
                elif self.flip_method == 6:
                    frame = cv2.flip(frame, 0)
                self._set(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
        except Exception as e:
            self.error = str(e)
        finally:
            self.cap.release()


# ======================================================================
#  Panel GUI (osadzany też w rfid_kamera.py)
# ======================================================================
class CameraPanel(ttk.Frame):
    def __init__(self, parent, flip_method=0, usb_index=None, **kwargs):
        ttk.Frame.__init__(self, parent, padding=10, **kwargs)
        self.flip_method = flip_method
        self.usb_index = usb_index
        self.source = None
        self._tk_img = None
        self._overlay_text = None
        self._overlay_until = 0.0
        self._flash_until = 0.0
        self._font = _load_font(36)
        self._build()

    def _build(self):
        ttk.Label(self, text="Kamera", font=("Helvetica", 16, "bold")).pack(anchor="w")
        self.status_var = tk.StringVar(value="Kamera zatrzymana")
        self.status_lbl = tk.Label(self, textvariable=self.status_var, fg="gray", anchor="w")
        self.status_lbl.pack(fill="x", pady=(2, 8))

        self.view = tk.Label(self, bg="black", width=VIEW_SIZE[0], height=VIEW_SIZE[1])
        self.view.pack()

        btns = ttk.Frame(self)
        btns.pack(fill="x", pady=(8, 0))
        self.start_btn = ttk.Button(btns, text="Start", command=self.toggle)
        self.start_btn.pack(side="left")
        ttk.Button(btns, text="Zdjęcie (spacja)", command=self.take_photo).pack(side="left", padx=4)
        ttk.Button(btns, text="Otwórz folder zdjęć", command=self.open_folder).pack(side="left")
        self.last_photo_var = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.last_photo_var, foreground="gray").pack(anchor="w", pady=(4, 0))

    # ------------------------------------------------------------- sterowanie
    def start_camera(self):
        if self.source is not None:
            return
        try:
            if self.usb_index is not None:
                self.source = USBCameraSource(self.usb_index, self.flip_method)
                name = "USB %d" % self.usb_index
            else:
                self.source = PiCameraSource(self.flip_method)
                name = "CSI (Picamera2)"
        except Exception as e:
            self.source = None
            msg = str(e)
            if "busy" in msg.lower() or "acquire" in msg.lower():
                msg += "\nKamera jest zajęta przez inny program - zamknij go."
            self._status("BŁĄD kamery: " + msg, "red")
            self.start_btn.config(text="Ponów")
            return
        self.source.start()
        self._status("Kamera działa: " + name, "green")
        self.start_btn.config(text="Stop")
        self.after(30, self._update)

    def stop_camera(self):
        if self.source is not None:
            self.source.stop()
            self.source = None
        self.start_btn.config(text="Start")
        self._status("Kamera zatrzymana", "gray")

    def toggle(self):
        if self.source is None:
            self.start_camera()
        else:
            self.stop_camera()

    def close(self):
        self.stop_camera()

    def _status(self, text, color):
        self.status_var.set(text)
        self.status_lbl.config(fg=color)

    # ---------------------------------------------------------------- podgląd
    def show_overlay(self, text, seconds=3.0):
        self._overlay_text = text
        self._overlay_until = time.time() + seconds

    def _decorate(self, img):
        now = time.time()
        if self._overlay_text and now < self._overlay_until:
            draw = ImageDraw.Draw(img)
            x, y = 20, 20
            bbox = draw.textbbox((x, y), self._overlay_text, font=self._font)
            draw.rectangle((bbox[0] - 10, bbox[1] - 8, bbox[2] + 10, bbox[3] + 8), fill=(0, 0, 0))
            draw.text((x, y), self._overlay_text, font=self._font, fill=(80, 255, 80))
        if now < self._flash_until:
            draw = ImageDraw.Draw(img)
            draw.rectangle((0, 0, img.width - 1, img.height - 1), outline=(255, 255, 255), width=12)
        return img

    def _update(self):
        src = self.source
        if src is None:
            return
        if src.error:
            err = src.error
            self.stop_camera()
            self._status("BŁĄD kamery: " + err, "red")
            return
        frame = src.latest()
        if frame is not None:
            img = self._decorate(frame.resize(VIEW_SIZE))
            self._tk_img = ImageTk.PhotoImage(img)
            self.view.config(image=self._tk_img, width=VIEW_SIZE[0], height=VIEW_SIZE[1])
        self.after(30, self._update)

    # ---------------------------------------------------------------- zdjęcia
    def take_photo(self, tag=None):
        """Zapisuje bieżącą klatkę. Zwraca ścieżkę albo None."""
        frame = self.source.latest() if self.source is not None else None
        if frame is None:
            self.last_photo_var.set("Brak obrazu - zdjęcie nie zostało zrobione")
            return None
        os.makedirs(PHOTO_DIR, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = "%s_%s.jpg" % (stamp, tag) if tag else "%s.jpg" % stamp
        path = os.path.join(PHOTO_DIR, name)
        img = frame.copy()
        if tag:
            draw = ImageDraw.Draw(img)
            draw.text((20, img.height - 60), "Karta: %s   %s" % (tag, stamp),
                      font=self._font, fill=(80, 255, 80))
        img.save(path, quality=92)
        self._flash_until = time.time() + 0.3
        self.last_photo_var.set("Zapisano: " + path)
        print("[KAMERA] zapisano " + path)
        return path

    def open_folder(self):
        os.makedirs(PHOTO_DIR, exist_ok=True)
        os.system('xdg-open "%s" >/dev/null 2>&1 &' % PHOTO_DIR)


# ======================================================================
def parse_args():
    p = argparse.ArgumentParser(description="Podgląd kamery na Raspberry Pi")
    p.add_argument("--flip", type=int, default=0, help="0 = brak, 2 = obrót 180°, 4 = lustro, 6 = do góry nogami")
    p.add_argument("--usb", type=int, default=None, help="indeks kamery USB zamiast CSI")
    return p.parse_args()


def main():
    args = parse_args()
    root = tk.Tk()
    root.title("Raspberry Pi - podgląd kamery")
    panel = CameraPanel(root, flip_method=args.flip, usb_index=args.usb)
    panel.pack(fill="both", expand=True)
    panel.start_camera()

    def on_close():
        panel.close()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.bind("<Escape>", lambda e: on_close())
    root.bind("<space>", lambda e: panel.take_photo())
    root.mainloop()


if __name__ == "__main__":
    main()
