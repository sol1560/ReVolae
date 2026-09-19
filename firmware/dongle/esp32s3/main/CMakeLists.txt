idf_component_register(SRCS "main.c" "usb_descriptors.c" "usb_network.c" "hid_output.c" "http_api.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_http_server esp_netif lwip json)
