#pragma once
#include <stdint.h>

struct Reading {
  char id[12];   // anchor id without the "JU-A-" prefix, e.g. "D3-05"
  int8_t rssi;   // strongest RSSI heard in the window (dBm)
};

void scanBegin();
// Scans for `seconds`, returns up to `max` anchors sorted by RSSI (strongest first).
int scanAnchors(uint32_t seconds, Reading *out, int max);
