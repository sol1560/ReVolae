#include <stdlib.h>
#include <string.h>
#include "dongle.h"
#include "esp_netif.h"
#include "esp_netif_net_stack.h"
#include "freertos/FreeRTOS.h"
#include "lwip/ip4_addr.h"
#include "tinyusb_net.h"
#include "tusb.h"

static esp_netif_t *netif;

static esp_err_t usb_receive(void *buffer, uint16_t length, void *context)
{
    (void)context;
    void *copy = malloc(length);
    if (!copy) return ESP_ERR_NO_MEM;
    memcpy(copy, buffer, length);
    return esp_netif_receive(netif, copy, length, NULL);
}

static esp_err_t transmit(void *handle, void *buffer, size_t length)
{
    (void)handle;
    return tinyusb_net_send_sync(buffer, length, NULL, pdMS_TO_TICKS(100));
}

static void free_receive(void *handle, void *buffer) { (void)handle; free(buffer); }

esp_err_t cuaremote_usb_network_init(void)
{
    static esp_netif_ip_info_t address;
    IP4_ADDR(&address.ip, 172, 31, 254, 1);
    IP4_ADDR(&address.gw, 172, 31, 254, 1);
    IP4_ADDR(&address.netmask, 255, 255, 255, 248);
    esp_netif_inherent_config_t base = {
        .flags = ESP_NETIF_DHCP_SERVER | ESP_NETIF_FLAG_AUTOUP,
        .ip_info = &address, .if_key = "USB_NCM", .if_desc = "CuaRemote USB NCM", .route_prio = 10,
    };
    esp_netif_driver_ifconfig_t driver = {
        .handle = (void *)1, .transmit = transmit, .driver_free_rx_buffer = free_receive,
    };
    struct esp_netif_netstack_config stack = { .lwip = {
        .init_fn = ethernetif_init, .input_fn = ethernetif_input,
    }};
    esp_netif_config_t config = { .base = &base, .driver = &driver, .stack = &stack };
    netif = esp_netif_new(&config);
    if (!netif) return ESP_ERR_NO_MEM;
    uint8_t local_mac[6] = { 0x02, 0x02, 0x11, 0x22, 0x33, 0x02 };
    ESP_ERROR_CHECK(esp_netif_set_mac(netif, local_mac));
    ESP_ERROR_CHECK(esp_netif_action_start(netif, NULL, 0, NULL));
    const tinyusb_net_config_t ncm = {
        .mac_addr = { 0x02, 0x02, 0x11, 0x22, 0x33, 0x01 }, .on_recv_callback = usb_receive,
    };
    ESP_ERROR_CHECK(tinyusb_net_init(&ncm));
    tud_network_link_state(0, true);
    return ESP_OK;
}
