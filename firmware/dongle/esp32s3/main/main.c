#include "dongle.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "tinyusb.h"

extern const tinyusb_config_t cuaremote_tinyusb_config;

void app_main(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(tinyusb_driver_install(&cuaremote_tinyusb_config));
    ESP_ERROR_CHECK(cuaremote_hid_start());
    ESP_ERROR_CHECK(cuaremote_usb_network_init());
    ESP_ERROR_CHECK(cuaremote_http_start() ? ESP_OK : ESP_FAIL);
    ESP_LOGI("cuaremote", "ready at http://172.31.254.1");
}
