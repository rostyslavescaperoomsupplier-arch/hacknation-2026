// BLE scan: collect "JU-A-*" anchors and keep the max RSSI per anchor in one window.
#include "scan.h"
#include <NimBLEDevice.h>
#include <string.h>
#include <stdlib.h>

static const char PREFIX[] = "JU-A-";
static const int TABLE = 64;  // anchors seen in one window (more than enough per deck)

static Reading table[TABLE];
static volatile int count = 0;

// "D3-05": 1..11 chars of A-Z, 0-9, '-'
static bool validId(const char *s, size_t n) {
  if (n == 0 || n >= sizeof(Reading::id)) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

class Collector : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *d) override {
    if (!d->haveName()) return;
    std::string name = d->getName();
    if (name.compare(0, sizeof(PREFIX) - 1, PREFIX) != 0) return;
    const char *id = name.c_str() + sizeof(PREFIX) - 1;
    size_t len = name.size() - (sizeof(PREFIX) - 1);
    if (!validId(id, len)) return;
    int rssi = d->getRSSI();
    for (int i = 0; i < count; i++) {
      if (strcmp(table[i].id, id) == 0) {
        if (rssi > table[i].rssi) table[i].rssi = rssi;
        return;
      }
    }
    if (count >= TABLE) return;
    memcpy(table[count].id, id, len);
    table[count].id[len] = 0;
    table[count].rssi = rssi;
    count = count + 1;
  }
};
static Collector collector;

void scanBegin() {
  NimBLEDevice::init("");
  NimBLEScan *s = NimBLEDevice::getScan();
  s->setAdvertisedDeviceCallbacks(&collector, true);  // true = report every packet, we want max RSSI
  s->setActiveScan(false);  // anchors put the name in the advertising packet
  s->setInterval(100);
  s->setWindow(99);         // listen almost all the time during the window
  s->setMaxResults(0);      // callback only, do not store devices
}

static int byRssi(const void *a, const void *b) {
  return ((const Reading *)b)->rssi - ((const Reading *)a)->rssi;
}

int scanAnchors(uint32_t seconds, Reading *out, int max) {
  count = 0;
  NimBLEScan *s = NimBLEDevice::getScan();
  s->start(seconds, false);  // blocking
  s->clearResults();
  int n = count;
  qsort(table, n, sizeof(Reading), byRssi);
  if (n > max) n = max;
  memcpy(out, table, n * sizeof(Reading));
  return n;
}
