#pragma once
// Wristband configuration. Edit before flashing, or override per band at build time:
//   PLATFORMIO_BUILD_FLAGS='-DBAND_UID=\"04:A2:3B:1C\"' pio run -t upload

#ifndef WIFI_SSID
#define WIFI_SSID "ship-crew"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "change-me"
#endif

// Centrala base URL, no trailing slash. https:// works too (certificate is NOT verified, see README).
#ifndef SERVER_URL
#define SERVER_URL "http://192.168.1.10:8787"
#endif

// Shared secret sent as the x-band-key header.
#ifndef BAND_KEY
#define BAND_KEY "change-me"
#endif

// RFID tag UID of this wristband (hex, any separators) = crew.rfid_uid in the crew database.
#ifndef BAND_UID
#define BAND_UID "04:A2:3B:1C"
#endif

#define FW_VERSION "band-0.1.0"

// Scan window (NimBLE 1.x scans in whole seconds).
#define SCAN_SECONDS 1
// Max anchors per report (SCAN_MAX_ANCHORS in positions.ts).
#define SCAN_MAX_ANCHORS 40
// Seconds between scans when the server gives no `next`.
#define NEXT_IDLE_S 3
#define NEXT_ALARM_S 1
// Button: hold this long for SOS on/off.
#define SOS_HOLD_MS 3000
