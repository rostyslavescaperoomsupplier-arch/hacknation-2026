// Fixed BLE anchor for crew positioning.
// Advertises a non-connectable packet with the name "JU-A-<ANCHOR_ID>" every ADV_INTERVAL_MS
// at a fixed TX power. Nothing else: no Wi-Fi, no connections, no state.
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "config.h"

static const char *ANCHOR_PREFIX = "JU-A-";

static void blinkBoot() {
  if (LED_PIN < 0) return;
  pinMode(LED_PIN, OUTPUT);
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, LED_ACTIVE_LOW ? LOW : HIGH);
    delay(120);
    digitalWrite(LED_PIN, LED_ACTIVE_LOW ? HIGH : LOW);
    delay(120);
  }
}

void setup() {
  // 80 MHz is plenty for advertising and saves ~20 mA compared to 160/240 MHz.
  setCpuFrequencyMhz(80);
  Serial.begin(115200);
  blinkBoot();

  String name = String(ANCHOR_PREFIX) + ANCHOR_ID;
  NimBLEDevice::init(name.c_str());
  NimBLEDevice::setPower(ANCHOR_TX_POWER);  // all power types (adv, scan, default)

  // The name goes into the advertising packet itself (not the scan response),
  // so the wristband can use a passive scan.
  NimBLEAdvertisementData adv;
  adv.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  adv.setName(name.c_str());

  NimBLEAdvertising *a = NimBLEDevice::getAdvertising();
  a->setAdvertisementData(adv);
  a->setScanResponse(false);
  a->setAdvertisementType(BLE_GAP_CONN_MODE_NON);  // non-connectable
  uint16_t units = (uint16_t)(ADV_INTERVAL_MS / 0.625);  // BLE unit = 0.625 ms
  a->setMinInterval(units);
  a->setMaxInterval(units + 16);  // +10 ms of slack lets the controller avoid collisions
  a->start();

  Serial.printf("anchor %s advertising every %d ms\n", name.c_str(), ADV_INTERVAL_MS);
}

void loop() {
  // The BLE controller advertises on its own. Sleep the task; print a heartbeat once a minute.
  delay(60000);
  Serial.printf("alive %lus\n", millis() / 1000);
}
