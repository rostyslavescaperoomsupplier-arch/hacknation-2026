#pragma once
// Anchor configuration. Every value can be overridden at build time, e.g. to flash a batch:
//   PLATFORMIO_BUILD_FLAGS='-DANCHOR_ID=\"D3-06\"' pio run -t upload

// Anchor id from ANCHORS in assistant/shared/positions.ts. BLE name = "JU-A-" + ANCHOR_ID.
#ifndef ANCHOR_ID
#define ANCHOR_ID "D3-05"
#endif

// Radio TX power (esp_power_level_t). Levels valid on both ESP32 and ESP32-C3:
// ESP_PWR_LVL_N12, N9, N6, N3, N0, P3, P6, P9. Keep it the same on every anchor and
// calibrate TX_1M / Anchor.tx with that value (see README).
#ifndef ANCHOR_TX_POWER
#define ANCHOR_TX_POWER ESP_PWR_LVL_N0
#endif

// Advertising interval in ms (BLE allows 20..10240). 100-200 ms is a good trade-off:
// a 1 s scan on the wristband catches 5-10 packets per anchor.
#ifndef ADV_INTERVAL_MS
#define ADV_INTERVAL_MS 150
#endif

// Status LED: blinks 3 times on boot. -1 = no LED.
#ifndef LED_PIN
#if CONFIG_IDF_TARGET_ESP32C3
#define LED_PIN 8          // SuperMini on-board blue LED
#define LED_ACTIVE_LOW 1
#else
#define LED_PIN 2          // ESP32 DevKit on-board LED
#define LED_ACTIVE_LOW 0
#endif
#endif
