#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_http_server.h"

#define CUAREMOTE_REPORT_INTERVAL_MS 15
#define CUAREMOTE_MAX_STEPS 128

typedef enum { ACTION_MOUSE, ACTION_KEYBOARD, ACTION_WAIT } action_kind_t;
typedef struct {
    action_kind_t kind;
    uint8_t buttons;
    int8_t x, y, wheel, pan;
    uint8_t modifiers, keycode;
    uint16_t wait_ms;
} hid_action_t;

esp_err_t cuaremote_hid_start(void);
esp_err_t cuaremote_hid_enqueue(const hid_action_t *items, size_t count);
bool cuaremote_hid_busy(void);
uint32_t cuaremote_hid_reports(void);
esp_err_t cuaremote_usb_network_init(void);
httpd_handle_t cuaremote_http_start(void);
