#include "ui.h"
#include "pins.h"
#include "config.h"
#include <Arduino.h>
#include <string.h>

// Each pattern: on/off durations in ms, starting with "on", played in a loop.
// general: 7 short + 1 long, like the ship's general emergency alarm signal
static const uint16_t P_GENERAL[] = {250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 1500, 2000};
// fire: continuous fast pulses
static const uint16_t P_FIRE[] = {200, 200};
// abandon ship: long buzz, short gap
static const uint16_t P_ABANDON[] = {3000, 700};
// man overboard: 3 long
static const uint16_t P_MOB[] = {900, 400, 900, 400, 900, 2000};
// anything else (flooding, blackout, medical, ...)
static const uint16_t P_GENERIC[] = {500, 300, 500, 2000};

struct Seq { const uint16_t *d; uint8_t n; };
#define SEQ(a) {a, (uint8_t)(sizeof(a) / sizeof(a[0]))}
static const Seq SEQS[] = {{nullptr, 0}, SEQ(P_GENERAL), SEQ(P_FIRE), SEQ(P_ABANDON), SEQ(P_MOB), SEQ(P_GENERIC)};

static volatile Pattern alarmPat = PAT_NONE;
static volatile bool alarmAcked = false;
static volatile bool shortPress = false;
static volatile bool sos = false;
static volatile uint32_t blinkUntil = 0;
static volatile int buzzLeft = 0;  // feedback buzzes still to play (on+off halves)

Pattern patternFor(const char *k) {
  if (!k) return PAT_GENERIC;
  if (!strcmp(k, "general")) return PAT_GENERAL;
  if (!strcmp(k, "fire")) return PAT_FIRE;
  if (!strcmp(k, "abandon")) return PAT_ABANDON;
  if (!strcmp(k, "mob")) return PAT_MOB;
  return PAT_GENERIC;
}

static void motor(bool on) { digitalWrite(PIN_MOTOR, on ? HIGH : LOW); }
static void led(bool on) { digitalWrite(PIN_LED, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW); }

// ---- button: short press = ack, hold = SOS toggle ----
static void buttonTick(uint32_t now) {
  static bool down = false, holdFired = false;
  static uint32_t since = 0;
  bool pressed = digitalRead(PIN_BUTTON) == LOW;
  if (pressed && !down) { down = true; holdFired = false; since = now; }
  if (pressed && down && !holdFired && now - since >= SOS_HOLD_MS) {
    holdFired = true;
    sos = !sos;
    uiBuzz(sos ? 3 : 1);
  }
  if (!pressed && down) {
    down = false;
    if (!holdFired && now - since >= 40) {  // 40 ms debounce
      shortPress = true;
      uiBuzz(1);
    }
  }
}

// ---- motor + LED ----
static void outputTick(uint32_t now) {
  static Pattern cur = PAT_NONE;
  static uint8_t step = 0;
  static uint32_t stepEnd = 0;
  static uint32_t buzzEnd = 0;

  // 1. feedback buzzes win over everything (100 ms on / 120 ms off)
  if (buzzLeft > 0) {
    if ((int32_t)(now - buzzEnd) >= 0) {
      buzzLeft = buzzLeft - 1;
      buzzEnd = now + ((buzzLeft & 1) ? 100 : 120);
    }
    bool on = buzzLeft & 1;
    motor(on);
    led(on);
    return;
  }

  // 2. alarm pattern, unless acknowledged
  Pattern p = alarmPat;
  if (p != PAT_NONE && !alarmAcked) {
    if (p != cur) { cur = p; step = 0; stepEnd = now + SEQS[p].d[0]; }
    if ((int32_t)(now - stepEnd) >= 0) {
      step = (step + 1) % SEQS[p].n;
      stepEnd = now + SEQS[p].d[step];
    }
    bool on = (step & 1) == 0;
    motor(on);
    led(on);
    return;
  }
  cur = PAT_NONE;
  motor(false);

  // 3. LED only: SOS double flash, acknowledged alarm slow blink, report flash
  uint32_t t = now % 2000;
  if (sos) led(t < 100 || (t >= 250 && t < 350));
  else if (p != PAT_NONE) led(t < 150 || (t >= 1000 && t < 1150));
  else led((int32_t)(blinkUntil - now) > 0);
}

static void uiTask(void *) {
  for (;;) {
    uint32_t now = millis();
    buttonTick(now);
    outputTick(now);
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void uiBegin() {
  pinMode(PIN_MOTOR, OUTPUT);
  motor(false);
  pinMode(PIN_LED, OUTPUT);
  led(false);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  xTaskCreate(uiTask, "ui", 2048, nullptr, 2, nullptr);
}

void uiSetAlarm(Pattern p, bool acknowledged) {
  alarmAcked = acknowledged;
  alarmPat = p;
}

bool uiTakeShortPress() {
  if (!shortPress) return false;
  shortPress = false;
  return true;
}

bool uiSosActive() { return sos; }
void uiBlink() { blinkUntil = millis() + 30; }
void uiBuzz(int times) { buzzLeft = times * 2; }
