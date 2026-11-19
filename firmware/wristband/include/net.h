#pragma once
#include <Arduino.h>

void netBegin();
// True when Wi-Fi is up. Otherwise (re)starts the connection with exponential backoff; never blocks.
bool netReady();
// POSTs JSON to SERVER_URL + path. Returns the HTTP status (<= 0 = transport error), body in `reply`.
int netPost(const char *path, const String &body, String &reply);
