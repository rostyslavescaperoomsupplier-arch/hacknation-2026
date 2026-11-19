// Crew wristband: BLE scan of "JU-A-*" anchors -> POST /api/bands/scan -> vibrate on alarm.
// Protocol: BandScan / BandReply in assistant/shared/positions.ts.
#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "battery.h"
#include "net.h"
#include "scan.h"
#include "ui.h"

// Alarm as last reported by the centrala. Kept when the server is unreachable,
// so the band keeps vibrating during an alarm even without Wi-Fi.
static String alarmId;
static Pattern alarmPat = PAT_NONE;
static bool alarmAcked = false;  // server confirmed the ack
static bool ackPending = false;  // wearer pressed, keep sending ack:true until confirmed
static int nextS = NEXT_IDLE_S;
static int battery = -1;
static uint32_t batteryAt = 0;

static Reading readings[SCAN_MAX_ANCHORS];

static void showAlarm() { uiSetAlarm(alarmPat, alarmAcked || ackPending); }

static void readButton() {
  if (uiTakeShortPress() && alarmPat != PAT_NONE && !alarmAcked) {
    ackPending = true;  // silence right away, report on the next scans
    showAlarm();
  }
}

static String buildScan(int n) {
  JsonDocument doc;
  doc["band"] = BAND_UID;
  JsonArray arr = doc["anchors"].to<JsonArray>();
  for (int i = 0; i < n; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["id"] = readings[i].id;
    o["rssi"] = readings[i].rssi;
  }
  if (battery >= 0) doc["bat"] = battery;
  doc["sos"] = uiSosActive();
  doc["ack"] = ackPending;
  doc["fw"] = FW_VERSION;
  String out;
  serializeJson(doc, out);
  return out;
}

static void applyReply(const String &body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) { Serial.println("reply: bad json"); return; }
  JsonVariant a = doc["alarm"];
  if (a.isNull()) {
    alarmId = "";
    alarmPat = PAT_NONE;
    alarmAcked = ackPending = false;
  } else {
    String id = a["id"] | "";
    if (id != alarmId) {  // a new alarm: forget the old ack
      alarmId = id;
      ackPending = false;
    }
    alarmPat = patternFor(a["kind"] | "");
    alarmAcked = a["acked"] | false;
    if (alarmAcked) ackPending = false;
  }
  int def = alarmPat != PAT_NONE ? NEXT_ALARM_S : NEXT_IDLE_S;
  nextS = constrain((int)(doc["next"] | def), 1, 60);
  showAlarm();
}

void setup() {
  Serial.begin(115200);
  setCpuFrequencyMhz(80);  // enough for BLE + Wi-Fi, saves power
  uiBegin();
  scanBegin();
  netBegin();
  Serial.printf("wristband %s, band %s, server %s\n", FW_VERSION, BAND_UID, SERVER_URL);
}

void loop() {
  uint32_t start = millis();

  if (start - batteryAt > 60000 || batteryAt == 0) {
    battery = batteryPercent();
    batteryAt = start;
  }

  if (!netReady()) {
    // no Wi-Fi: keep the last alarm pattern running, try again soon
    readButton();
    delay(1000);
    return;
  }

  int n = scanAnchors(SCAN_SECONDS, readings, SCAN_MAX_ANCHORS);
  // serial log, also used for TX_1M calibration (tools/calibrate.py)
  for (int i = 0; i < n; i++) Serial.printf("rssi %s %d\n", readings[i].id, readings[i].rssi);

  readButton();
  String reply;
  int code = netPost("/api/bands/scan", buildScan(n), reply);
  if (code == 200) {
    applyReply(reply);
    uiBlink();
  } else {
    Serial.printf("post failed: %d\n", code);
    nextS = alarmPat != PAT_NONE ? NEXT_ALARM_S : NEXT_IDLE_S;
  }

  // wait until the next scan; a short press during the wait sends the ack at once
  while (millis() - start < (uint32_t)nextS * 1000) {
    bool hadAck = ackPending;
    readButton();
    if (ackPending && !hadAck) break;
    delay(50);
  }
}
