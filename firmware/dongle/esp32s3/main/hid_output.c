#include "dongle.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "tusb.h"

enum { REPORT_ID_KEYBOARD = 1, REPORT_ID_MOUSE = 2 };
static QueueHandle_t queue;
static volatile bool busy;
static volatile uint32_t reports;

static void send_action(const hid_action_t *action)
{
    while (!tud_mounted() || tud_suspended() || !tud_hid_ready()) vTaskDelay(pdMS_TO_TICKS(2));
    if (action->kind == ACTION_MOUSE) {
        tud_hid_mouse_report(REPORT_ID_MOUSE, action->buttons, action->x, action->y,
                             action->wheel, action->pan);
    } else if (action->kind == ACTION_KEYBOARD) {
        uint8_t keys[6] = { action->keycode };
        tud_hid_keyboard_report(REPORT_ID_KEYBOARD, action->modifiers,
                                action->keycode ? keys : NULL);
    } else {
        vTaskDelay(pdMS_TO_TICKS(action->wait_ms));
        return;
    }
    reports++;
    vTaskDelay(pdMS_TO_TICKS(CUAREMOTE_REPORT_INTERVAL_MS));
}

static void worker(void *unused)
{
    (void)unused;
    hid_action_t action;
    while (true) {
        if (xQueueReceive(queue, &action, portMAX_DELAY) == pdTRUE) {
            busy = true;
            send_action(&action);
            busy = uxQueueMessagesWaiting(queue) != 0;
        }
    }
}

esp_err_t cuaremote_hid_start(void)
{
    queue = xQueueCreate(512, sizeof(hid_action_t));
    if (!queue) return ESP_ERR_NO_MEM;
    return xTaskCreate(worker, "hid-output", 4096, NULL, 8, NULL) == pdPASS ? ESP_OK : ESP_FAIL;
}

esp_err_t cuaremote_hid_enqueue(const hid_action_t *items, size_t count)
{
    if (!items || !count || count > uxQueueSpacesAvailable(queue)) return ESP_ERR_NO_MEM;
    for (size_t i = 0; i < count; i++) {
        if (xQueueSend(queue, &items[i], 0) != pdTRUE) return ESP_FAIL;
    }
    return ESP_OK;
}

bool cuaremote_hid_busy(void) { return busy || uxQueueMessagesWaiting(queue); }
uint32_t cuaremote_hid_reports(void) { return reports; }
