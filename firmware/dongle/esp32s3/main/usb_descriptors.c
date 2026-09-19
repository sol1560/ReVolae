#include "tusb.h"
#include "tinyusb.h"

enum { REPORT_ID_KEYBOARD = 1, REPORT_ID_MOUSE = 2 };
const uint8_t cuaremote_hid_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(REPORT_ID_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(REPORT_ID_MOUSE)),
};

enum { ITF_NCM = 0, ITF_NCM_DATA, ITF_HID, ITF_TOTAL };
enum { STR_LANG = 0, STR_MANUFACTURER, STR_PRODUCT, STR_SERIAL, STR_NCM, STR_MAC, STR_HID };
#define TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_NCM_DESC_LEN + TUD_HID_DESC_LEN)

static const tusb_desc_device_t device_descriptor = {
    .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200, .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON, .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE, .idVendor = 0x303A, .idProduct = 0x4015,
    .bcdDevice = 0x0100, .iManufacturer = STR_MANUFACTURER, .iProduct = STR_PRODUCT,
    .iSerialNumber = STR_SERIAL, .bNumConfigurations = 1,
};

static const uint8_t configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_TOTAL, 0, TOTAL_LEN,
                          TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_CDC_NCM_DESCRIPTOR(ITF_NCM, STR_NCM, STR_MAC, 0x81, 64,
                           0x02, 0x82, 64, CFG_TUD_NET_MTU),
    TUD_HID_DESCRIPTOR(ITF_HID, STR_HID, false,
                       sizeof(cuaremote_hid_report_descriptor), 0x83, 16, 10),
};

static const char *string_descriptor[] = {
    (const char[]){0x09, 0x04}, "CuaRemote", "CuaRemote iPad Dongle", "0001",
    "USB NCM", "020211223301", "Keyboard + Mouse",
};

const tinyusb_config_t cuaremote_tinyusb_config = {
    .port = TINYUSB_PORT_FULL_SPEED_0,
    .phy = {.skip_setup = false, .self_powered = false},
    .task = {.size = 4096, .priority = 5, .xCoreID = 0},
    .descriptor = {
        .device = &device_descriptor,
        .string = string_descriptor,
        .string_count = sizeof(string_descriptor) / sizeof(string_descriptor[0]),
        .full_speed_config = configuration_descriptor,
    },
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance)
{
    (void)instance;
    return cuaremote_hid_report_descriptor;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                               hid_report_type_t type, uint8_t *buffer, uint16_t length)
{
    (void)instance; (void)report_id; (void)type; (void)buffer; (void)length;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                           hid_report_type_t type, const uint8_t *buffer, uint16_t size)
{
    (void)instance; (void)report_id; (void)type; (void)buffer; (void)size;
}
