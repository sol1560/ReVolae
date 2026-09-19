#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "dongle.h"
#include "esp_http_server.h"
#include "tusb.h"

#define MAX_BODY 16384
#define MAX_ACTIONS 512

typedef struct { hid_action_t *items; size_t count; uint32_t waits; } batch_t;

static esp_err_t json_error(httpd_req_t *request, const char *status, const char *message)
{
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json");
    char body[192];
    snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", message);
    return httpd_resp_sendstr(request, body);
}

static bool add(batch_t *batch, hid_action_t action)
{
    if (batch->count >= MAX_ACTIONS) return false;
    batch->items[batch->count++] = action;
    return true;
}

static bool json_int(cJSON *object, const char *name, int minimum, int maximum, int fallback, int *output)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!item && fallback >= minimum) { *output = fallback; return true; }
    if (!cJSON_IsNumber(item) || item->valuedouble != item->valueint ||
        item->valueint < minimum || item->valueint > maximum) return false;
    *output = item->valueint;
    return true;
}

static bool ascii_key(char character, uint8_t *key, uint8_t *modifier)
{
    *modifier = 0;
    if (character >= 'a' && character <= 'z') { *key = character - 'a' + 0x04; return true; }
    if (character >= 'A' && character <= 'Z') { *key = character - 'A' + 0x04; *modifier = 0x02; return true; }
    if (character >= '1' && character <= '9') { *key = character - '1' + 0x1e; return true; }
    if (character == '0') { *key = 0x27; return true; }
    const char plain[] = " -=[]\\;'`,./\n\t";
    const uint8_t codes[] = {0x2c,0x2d,0x2e,0x2f,0x30,0x31,0x33,0x34,0x35,0x36,0x37,0x38,0x28,0x2b};
    const char *found = strchr(plain, character);
    if (found) { *key = codes[found - plain]; return true; }
    const char shifted[] = "_+{}|:\"~<>?!@#$%^&*()";
    const char bases[] =   "-=[]\\;'`,./1234567890";
    found = strchr(shifted, character);
    if (!found) return false;
    *modifier = 0x02;
    return ascii_key(bases[found - shifted], key, &(uint8_t){0});
}

static bool append_key(batch_t *batch, uint8_t modifier, uint8_t key)
{
    return add(batch, (hid_action_t){.kind=ACTION_KEYBOARD,.modifiers=modifier,.keycode=key}) &&
           add(batch, (hid_action_t){.kind=ACTION_KEYBOARD});
}

static const char *expand(const char *path, cJSON *body, batch_t *batch)
{
    int x, y;
    if (!strcmp(path, "/mouse/move")) {
        if (!json_int(body,"dx",-32767,32767,40000,&x) || !json_int(body,"dy",-32767,32767,40000,&y)) return "dx/dy invalid";
        while (x || y) {
            int sx = x < -127 ? -127 : x > 127 ? 127 : x;
            int sy = y < -127 ? -127 : y > 127 ? 127 : y;
            if (!add(batch,(hid_action_t){.kind=ACTION_MOUSE,.x=sx,.y=sy})) return "too many HID reports";
            x -= sx; y -= sy;
        }
        return NULL;
    }
    if (!strcmp(path, "/mouse/click")) {
        cJSON *button_item = cJSON_GetObjectItem(body,"button");
        const char *name = cJSON_IsString(button_item) ? button_item->valuestring : "left";
        uint8_t button = !strcmp(name,"left") ? 1 : !strcmp(name,"right") ? 2 : !strcmp(name,"middle") ? 4 : 0;
        int count;
        if (!button || !json_int(body,"count",1,3,1,&count)) return "button/count invalid";
        while (count--) if (!add(batch,(hid_action_t){.kind=ACTION_MOUSE,.buttons=button}) ||
                           !add(batch,(hid_action_t){.kind=ACTION_MOUSE})) return "too many HID reports";
        return NULL;
    }
    if (!strcmp(path, "/mouse/scroll")) {
        if (!json_int(body,"dx",-127,127,0,&x) || !json_int(body,"dy",-127,127,0,&y)) return "scroll invalid";
        return add(batch,(hid_action_t){.kind=ACTION_MOUSE,.wheel=y,.pan=x}) ? NULL : "too many HID reports";
    }
    if (!strcmp(path, "/key/type")) {
        cJSON *text = cJSON_GetObjectItem(body,"text");
        if (!cJSON_IsString(text) || strlen(text->valuestring)>1024) return "text invalid";
        for (const unsigned char *p=(unsigned char *)text->valuestring; *p; p++) {
            uint8_t key, modifier;
            if (*p > 127 || !ascii_key(*p,&key,&modifier)) return "Unicode requires iPad clipboard then Cmd+V";
            if (!append_key(batch,modifier,key)) return "too many HID reports";
        }
        return NULL;
    }
    if (!strcmp(path, "/key/press")) {
        cJSON *key_item=cJSON_GetObjectItem(body,"key"), *modifiers=cJSON_GetObjectItem(body,"modifiers");
        if (!cJSON_IsString(key_item)) return "key invalid";
        uint8_t key=0, implicit=0, modifier=0;
        if (strlen(key_item->valuestring)==1) {
            if (!ascii_key(key_item->valuestring[0],&key,&implicit)) return "key invalid";
        } else {
            struct named { const char *name; uint8_t code; } names[]={{"enter",0x28},{"escape",0x29},{"backspace",0x2a},{"tab",0x2b},{"space",0x2c},{"delete",0x4c},{"right",0x4f},{"left",0x50},{"down",0x51},{"up",0x52},{"home",0x4a},{"end",0x4d}};
            for (size_t i=0;i<sizeof(names)/sizeof(names[0]);i++) if (!strcmp(key_item->valuestring,names[i].name)) key=names[i].code;
            if (!key) return "key invalid";
        }
        modifier=implicit;
        if (modifiers) {
            if (!cJSON_IsArray(modifiers)) return "modifiers invalid";
            cJSON *item;
            cJSON_ArrayForEach(item,modifiers) {
                if (!cJSON_IsString(item)) return "modifiers invalid";
                if (!strcmp(item->valuestring,"ctrl")) modifier|=1;
                else if (!strcmp(item->valuestring,"shift")) modifier|=2;
                else if (!strcmp(item->valuestring,"alt")||!strcmp(item->valuestring,"option")) modifier|=4;
                else if (!strcmp(item->valuestring,"cmd")||!strcmp(item->valuestring,"command")||!strcmp(item->valuestring,"meta")) modifier|=8;
                else return "modifiers invalid";
            }
        }
        return append_key(batch,modifier,key) ? NULL : "too many HID reports";
    }
    return "unknown endpoint";
}

static esp_err_t post(httpd_req_t *request)
{
    if (request->content_len <= 0 || request->content_len > MAX_BODY) return json_error(request,"413 Payload Too Large","body invalid");
    char *raw=malloc(request->content_len+1);
    hid_action_t *items=calloc(MAX_ACTIONS,sizeof(*items));
    if (!raw || !items) { free(raw);free(items);return json_error(request,"500 Internal Server Error","out of memory"); }
    int received=0;
    while (received < request->content_len) {
        int chunk=httpd_req_recv(request,raw+received,request->content_len-received);
        if (chunk<=0) { free(raw);free(items);return json_error(request,"400 Bad Request","body incomplete"); }
        received+=chunk;
    }
    raw[request->content_len]=0;
    cJSON *body=cJSON_Parse(raw); free(raw);
    if (!cJSON_IsObject(body)) { cJSON_Delete(body);free(items);return json_error(request,"400 Bad Request","JSON object required"); }
    batch_t batch={.items=items}; const char *error=NULL;
    if (!strcmp(request->uri,"/macro")) {
        cJSON *steps=cJSON_GetObjectItem(body,"steps");
        int count=cJSON_IsArray(steps)?cJSON_GetArraySize(steps):0;
        if (count<1||count>CUAREMOTE_MAX_STEPS) error="steps invalid";
        for (int i=0;!error&&i<count;i++) {
            cJSON *step=cJSON_GetArrayItem(steps,i), *delay=cJSON_GetObjectItem(step,"delayMs"), *action=cJSON_GetObjectItem(step,"action");
            if (delay) {
                int ms;if(!json_int(step,"delayMs",1,5000,-1,&ms)||(batch.waits+=ms)>10000) error="macro wait invalid";
                else if(!add(&batch,(hid_action_t){.kind=ACTION_WAIT,.wait_ms=ms})) error="too many HID reports";
            } else if(cJSON_IsString(action)) {
                char path[40];snprintf(path,sizeof(path),"/%s",action->valuestring);for(char *p=path;*p;p++)if(*p=='.')*p='/';
                error=expand(path,step,&batch);
            } else error="step invalid";
        }
    } else error=expand(request->uri,body,&batch);
    cJSON_Delete(body);
    if (error) { free(items);return json_error(request,"400 Bad Request",error); }
    esp_err_t queued=cuaremote_hid_enqueue(items,batch.count);free(items);
    if (queued!=ESP_OK) return json_error(request,"409 Conflict","HID queue busy");
    httpd_resp_set_status(request,"202 Accepted");httpd_resp_set_type(request,"application/json");
    return httpd_resp_sendstr(request,"{\"ok\":true,\"queued\":true}");
}

static esp_err_t status_get(httpd_req_t *request)
{
    char body[160];snprintf(body,sizeof(body),"{\"device\":\"CuaRemote ESP32-S3\",\"hidReady\":%s,\"busy\":%s,\"reports\":%lu}",tud_hid_ready()?"true":"false",cuaremote_hid_busy()?"true":"false",(unsigned long)cuaremote_hid_reports());
    httpd_resp_set_type(request,"application/json");return httpd_resp_sendstr(request,body);
}

httpd_handle_t cuaremote_http_start(void)
{
    httpd_config_t config=HTTPD_DEFAULT_CONFIG();config.server_port=80;config.lru_purge_enable=true;config.stack_size=8192;
    httpd_handle_t server=NULL;if(httpd_start(&server,&config)!=ESP_OK)return NULL;
    const char *paths[]={"/mouse/move","/mouse/click","/mouse/scroll","/key/press","/key/type","/macro"};
    static httpd_uri_t handlers[6];
    for(size_t i=0;i<6;i++){handlers[i]=(httpd_uri_t){.uri=paths[i],.method=HTTP_POST,.handler=post};httpd_register_uri_handler(server,&handlers[i]);}
    static const httpd_uri_t status={.uri="/status",.method=HTTP_GET,.handler=status_get};httpd_register_uri_handler(server,&status);
    return server;
}
