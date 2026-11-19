# -*- coding: utf-8 -*-
"""
Wysyłanie odbić kart RFID do bazy załogi (crew/, POST /api/checkin).

Terminal (Raspberry Pi z czytnikiem) po odczytaniu karty wysyła:
    POST <server>/api/checkin
    { "rfid": "59:BA:E9:5A", "terminal": "T-D4-01-A", "direction": "in" }
Serwer odpowiada danymi osoby (imię, nazwisko, stopień, gdzie jest) albo
404 "Nieznany identyfikator RFID" / "Nieznany terminal".

Ustawienia w pliku config.json obok programu (tworzony przy pierwszym
uruchomieniu), można je też nadpisać z linii poleceń: --server, --terminal,
--direction, --key, --no-server.

Serwer demo: "server": "https://jantar.byst.re" i "key" = TERMINAL_KEY
z /etc/jantar-assistant.env. Asystent przyjmuje to samo POST /api/checkin
i przekazuje je do bazy załogi.

Wysyłanie odbywa się w osobnym wątku, więc wolny lub niedostępny serwer nie
blokuje okna. Odbicia, których nie udało się wysłać (brak sieci), czekają
w kolejce i są wysyłane ponownie, gdy serwer znów odpowiada.
"""

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "config.json")

DEFAULT_CONFIG = {
    "enabled": True,
    # adres serwera bazy załogi (crew/, domyślnie port 8790)
    "server": "http://localhost:8790",
    # kod terminala z bazy (GET /api/terminals), np. T-D4-01-A = Mostek nawigacyjny
    "terminal": "T-D4-01-A",
    # "in" = wejście do pomieszczenia, "out" = wyjście
    "direction": "in",
    "timeout_s": 3,
    # klucz urządzenia (nagłówek x-terminal-key), potrzebny przy wysyłaniu przez asystenta,
    # np. "server": "https://jantar.byst.re"; bazie załogi w sieci lokalnej nie jest potrzebny
    "key": "",
}

RETRY_EVERY_S = 10       # co ile ponawiać wysyłkę zaległych odbić
MAX_PENDING = 500        # ile odbić trzymać w kolejce, gdy serwer nie odpowiada


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print("[SERWER] Błąd w config.json (%s), używam ustawień domyślnych" % e)
    else:
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(DEFAULT_CONFIG, f, indent=2, ensure_ascii=False)
        except Exception:
            pass
    return cfg


def add_arguments(parser):
    """Dodaje do argparse opcje serwera (wspólne dla rfid_reader.py i rfid_kamera.py)."""
    parser.add_argument("--server", help="adres bazy załogi, np. http://192.168.1.10:8790")
    parser.add_argument("--terminal", help="kod terminala, np. T-D4-01-A")
    parser.add_argument("--direction", choices=("in", "out"), help="in = wejście, out = wyjście")
    parser.add_argument("--key", help="klucz urządzenia dla asystenta (nagłówek x-terminal-key)")
    parser.add_argument("--no-server", action="store_true", help="nie wysyłaj odbić do serwera")


def config_from_args(args):
    cfg = load_config()
    if args is not None:
        if getattr(args, "server", None):
            cfg["server"] = args.server
        if getattr(args, "terminal", None):
            cfg["terminal"] = args.terminal
        if getattr(args, "direction", None):
            cfg["direction"] = args.direction
        if getattr(args, "key", None):
            cfg["key"] = args.key
        if getattr(args, "no_server", False):
            cfg["enabled"] = False
    return cfg


class CheckinError(Exception):
    def __init__(self, message, retry):
        Exception.__init__(self, message)
        self.retry = retry   # True = problem z siecią/serwerem, warto ponowić


def post_checkin(server, uid, terminal, direction="in", timeout=3, key=""):
    """Jedno odbicie. Zwraca słownik z danymi osoby albo rzuca CheckinError."""
    url = server.rstrip("/") + "/api/checkin"
    body = json.dumps({"rfid": uid, "terminal": terminal, "direction": direction}).encode("utf-8")
    headers = {"content-type": "application/json"}
    if key:
        headers["x-terminal-key"] = key
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:
            msg = ""
        if e.code == 403:
            msg = "serwer nie przyjął klucza urządzenia (key w config.json)"
        # 4xx = serwer odrzucił odbicie (nieznana karta/terminal), ponawianie nic nie da;
        # 429 = za dużo odbić naraz, warto ponowić później
        raise CheckinError(msg or ("HTTP %d" % e.code), retry=e.code >= 500 or e.code == 429)
    except Exception as e:
        reason = getattr(e, "reason", e)
        raise CheckinError("brak połączenia z %s (%s)" % (server, reason), retry=True)


class CheckinClient(object):
    """Wysyła odbicia w tle. Wyniki trafiają do callbacku on_result(event):
        ("ok", uid, osoba)             - serwer przyjął odbicie
        ("rejected", uid, komunikat)   - serwer odrzucił (np. nieznana karta)
        ("offline", uid, komunikat)    - brak połączenia, odbicie czeka w kolejce
        ("sent_pending", liczba)       - wysłano zaległe odbicia
    Callback jest wołany z wątku w tle - GUI musi przekazać go dalej przez kolejkę.
    """

    def __init__(self, config, on_result):
        self.cfg = config
        self.on_result = on_result
        self.q = queue.Queue()
        self.pending = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    @property
    def enabled(self):
        return bool(self.cfg.get("enabled"))

    def describe(self):
        if not self.enabled:
            return "Wysyłanie do serwera wyłączone"
        return "Serwer: %s, terminal %s (%s)" % (
            self.cfg["server"], self.cfg["terminal"],
            "wejście" if self.cfg.get("direction", "in") == "in" else "wyjście")

    def send(self, uid):
        if self.enabled:
            self.q.put(uid)

    def stop(self):
        self._stop.set()
        self.q.put(None)

    def _post(self, uid):
        return post_checkin(self.cfg["server"], uid, self.cfg["terminal"],
                            self.cfg.get("direction", "in"), self.cfg.get("timeout_s", 3),
                            self.cfg.get("key", ""))

    def _run(self):
        last_retry = 0.0
        while not self._stop.is_set():
            try:
                uid = self.q.get(timeout=1.0)
            except queue.Empty:
                uid = None
            if self._stop.is_set():
                break
            if uid is not None:
                try:
                    self.on_result(("ok", uid, self._post(uid)))
                except CheckinError as e:
                    if e.retry:
                        if len(self.pending) < MAX_PENDING:
                            self.pending.append(uid)
                        self.on_result(("offline", uid, str(e)))
                    else:
                        self.on_result(("rejected", uid, str(e)))
            if self.pending and time.time() - last_retry > RETRY_EVERY_S:
                last_retry = time.time()
                self._flush_pending()

    def _flush_pending(self):
        sent = 0
        while self.pending:
            uid = self.pending[0]
            try:
                self._post(uid)
            except CheckinError as e:
                if e.retry:
                    break           # serwer dalej nie odpowiada, spróbujemy później
            self.pending.pop(0)     # wysłane albo odrzucone na stałe
            sent += 1
        if sent:
            self.on_result(("sent_pending", sent))


def person_label(p):
    """'Tomasz Kozłowski (Kapitan) - Mostek nawigacyjny'"""
    name = ("%s %s" % (p.get("first_name", ""), p.get("last_name", ""))).strip() or "?"
    rank = p.get("rank")
    room = p.get("room_name")
    s = name + (" (%s)" % rank if rank else "")
    if room:
        s += " - " + room
    return s
