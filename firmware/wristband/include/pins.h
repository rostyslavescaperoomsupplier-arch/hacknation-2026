#pragma once
// Pin map. Picked automatically from the target chip. -1 = not fitted.
#if CONFIG_IDF_TARGET_ESP32C3
// ESP32-C3 SuperMini
#define PIN_LED 8           // on-board blue LED, active LOW
#define LED_ACTIVE_LOW 1
#define PIN_BUTTON 10       // to GND, internal pull-up (do not use GPIO9 = BOOT)
#define PIN_MOTOR 4         // gate/base of the motor driver, HIGH = vibrate
#define PIN_BAT_ADC 3       // ADC1_CH3, middle of the 100k/100k divider
#else
// ESP32 DevKit (WROOM-32)
#define PIN_LED 2           // on-board LED, active HIGH
#define LED_ACTIVE_LOW 0
#define PIN_BUTTON 27
#define PIN_MOTOR 25
#define PIN_BAT_ADC 34      // ADC1_CH6, input only (ADC2 is unusable while Wi-Fi is on)
#endif
// Battery voltage = ADC voltage * BAT_DIVIDER
#define BAT_DIVIDER 2.0f
