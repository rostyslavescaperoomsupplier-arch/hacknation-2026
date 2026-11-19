// LiPo state of charge from the ADC divider (rough, open-circuit curve).
#include "battery.h"
#include "pins.h"
#include <Arduino.h>

// mV -> % for a 1S LiPo under a light load
static const uint16_t MV[] = {3300, 3500, 3600, 3700, 3750, 3800, 3850, 3900, 4000, 4100, 4200};
static const uint8_t PCT[] = {0, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100};

int batteryPercent() {
  if (PIN_BAT_ADC < 0) return -1;
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(PIN_BAT_ADC);
  int mv = (int)(sum / 8 * BAT_DIVIDER);
  if (mv < 2500) return -1;  // nothing connected
  if (mv <= MV[0]) return 0;
  const int n = sizeof(MV) / sizeof(MV[0]);
  if (mv >= MV[n - 1]) return 100;
  for (int i = 1; i < n; i++) {
    if (mv < MV[i]) return PCT[i - 1] + (PCT[i] - PCT[i - 1]) * (mv - MV[i - 1]) / (MV[i] - MV[i - 1]);
  }
  return 100;
}
