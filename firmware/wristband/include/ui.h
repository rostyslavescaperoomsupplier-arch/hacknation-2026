#pragma once
// Button, vibration motor and LED. Runs in its own 10 ms task so the wearer gets feedback
// even while the main loop is blocked in a BLE scan or an HTTP request.

enum Pattern { PAT_NONE, PAT_GENERAL, PAT_FIRE, PAT_ABANDON, PAT_MOB, PAT_GENERIC };

Pattern patternFor(const char *alarmKind);

void uiBegin();
// What to signal: the alarm pattern, and whether the wearer already acknowledged it
// (acknowledged = motor off, LED slow blink).
void uiSetAlarm(Pattern p, bool acknowledged);
// True once after each short press.
bool uiTakeShortPress();
// SOS latch, toggled by holding the button SOS_HOLD_MS.
bool uiSosActive();
// Short LED flash (e.g. after a successful report).
void uiBlink();
// Short buzz to confirm an action.
void uiBuzz(int times);
