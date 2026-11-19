// Wi-Fi with reconnect backoff + one JSON POST helper.
#include "net.h"
#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

static uint32_t nextTry = 0;
static uint32_t backoff = 1000;
static const uint32_t BACKOFF_MAX = 30000;

void netBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // we reconnect ourselves, with backoff
  WiFi.setSleep(true);           // modem sleep between packets (needed with BLE anyway)
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  nextTry = millis() + backoff;
}

bool netReady() {
  if (WiFi.status() == WL_CONNECTED) {
    backoff = 1000;
    return true;
  }
  if ((int32_t)(millis() - nextTry) >= 0) {
    Serial.printf("wifi: reconnect (next try in %lu ms)\n", backoff);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    nextTry = millis() + backoff;
    backoff = min(backoff * 2, BACKOFF_MAX);
  }
  return false;
}

int netPost(const char *path, const String &body, String &reply) {
  String url = String(SERVER_URL) + path;
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure tls;
  bool ok;
  if (url.startsWith("https://")) {
    tls.setInsecure();  // demo: no CA pinning, see README
    ok = http.begin(tls, url);
  } else {
    ok = http.begin(plain, url);
  }
  if (!ok) return -1;
  http.setTimeout(3000);
  http.setConnectTimeout(3000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-band-key", BAND_KEY);
  int code = http.POST(body);
  reply = code > 0 ? http.getString() : String();
  http.end();
  return code;
}
