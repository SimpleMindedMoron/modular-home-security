#include "esp_camera.h"
#include "esp_http_server.h"
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiManager.h>

// =====================================================
// AI-THINKER ESP32-CAM PIN DEFINITIONS
// =====================================================

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27

#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5

#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// =====================================================
// NETWORK & MQTT CONFIGURATION
// =====================================================

#define MQTT_PORT 1883
#define CAMERA_HTTP_PORT 81

const char *AP_NAME = "ESP32-Security-Setup";

const char *MQTT_DISCOVERY_TOPIC = "security/camera/discovery";
const char *MQTT_STATUS_TOPIC = "security/camera/status";

// =====================================================
// GLOBAL INSTANCES & STATE
// =====================================================

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
Preferences preferences;

char mqttBrokerIP[40] = "";
httpd_handle_t cameraServer = NULL;
unsigned long lastMqttReconnectAttempt = 0;

// =====================================================
// NVS STORAGE (PREFERENCES)
// =====================================================

void loadSettings() {
  preferences.begin("camera", true);
  String broker = preferences.getString("mqtt_ip", "");
  preferences.end();

  broker.toCharArray(mqttBrokerIP, sizeof(mqttBrokerIP));
}

void saveSettings(const char *broker) {
  preferences.begin("camera", false);
  preferences.putString("mqtt_ip", broker);
  preferences.end();
}

// =====================================================
// CAMERA INITIALIZATION
// =====================================================

bool initializeCamera() {
  camera_config_t config = {};

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA; // 640x480
    config.jpeg_quality = 10;          // 10-63 lower means higher quality
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST; // Always deliver fresh frames
  } else {
    config.frame_size = FRAMESIZE_QVGA; // 320x240 fallback if no PSRAM
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t result = esp_camera_init(&config);

  if (result != ESP_OK) {
    Serial.printf("Camera initialization failed with error: 0x%x\n", result);
    return false;
  }

  Serial.println("OV2640 camera initialized successfully.");
  return true;
}

// =====================================================
// CAMERA STREAM HANDLER (MJPEG)
// =====================================================

static esp_err_t streamHandler(httpd_req_t *req) {
  esp_err_t result;

  result = httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
  if (result != ESP_OK)
    return result;

  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "15");

  while (true) {
    camera_fb_t *frame = esp_camera_fb_get();

    if (!frame) {
      Serial.println("Camera frame capture failed.");
      return ESP_FAIL;
    }

    char header[128];
    int headerLength = snprintf(header, sizeof(header),
                                "--frame\r\n"
                                "Content-Type: image/jpeg\r\n"
                                "Content-Length: %u\r\n\r\n",
                                frame->len);

    result = httpd_resp_send_chunk(req, header, headerLength);

    if (result == ESP_OK) {
      result = httpd_resp_send_chunk(req, (const char *)frame->buf, frame->len);
    }

    if (result == ESP_OK) {
      result = httpd_resp_send_chunk(req, "\r\n", 2);
    }

    esp_camera_fb_return(frame);

    if (result != ESP_OK)
      break;
  }

  return result;
}

// =====================================================
// CAMERA ROOT HANDLER (PREVIEW PAGE)
// =====================================================

static esp_err_t rootHandler(httpd_req_t *req) {
  const char html[] =
      "<!DOCTYPE html>"
      "<html>"
      "<head>"
      "<meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>SecureHome Camera</title>"
      "</head>"
      "<body "
      "style='text-align:center;font-family:Arial,sans-serif;margin-top:20px;"
      "background:#111;color:#eee;'>"
      "<h2>SecureHome Vision Node</h2>"
      "<p>Streaming on Port 81 (/stream)</p>"
      "<img src='/stream' "
      "style='width:95%;max-width:800px;border-radius:8px;border:1px solid "
      "#444;'>"
      "</body>"
      "</html>";

  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
}

// =====================================================
// START CAMERA HTTP SERVER
// =====================================================

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();

  // Standard port for SecureHome camera stream
  config.server_port = CAMERA_HTTP_PORT;
  config.ctrl_port = 32769;

  httpd_uri_t rootURI = {
      .uri = "/", .method = HTTP_GET, .handler = rootHandler, .user_ctx = NULL};

  httpd_uri_t streamURI = {.uri = "/stream",
                           .method = HTTP_GET,
                           .handler = streamHandler,
                           .user_ctx = NULL};

  if (httpd_start(&cameraServer, &config) == ESP_OK) {
    httpd_register_uri_handler(cameraServer, &rootURI);
    httpd_register_uri_handler(cameraServer, &streamURI);

    Serial.println("Camera HTTP streaming server started on port 81.");
    Serial.println("Preview: http://<ESP32-IP>:81/");
    Serial.println("Stream:  http://<ESP32-IP>:81/stream");
  } else {
    Serial.println("Failed to start Camera HTTP server.");
  }
}

// =====================================================
// MQTT DISCOVERY
// =====================================================

void publishCameraDiscovery() {
  String ip = WiFi.localIP().toString();

  // Adheres strictly to docs/api-contract.md schema
  String payload = "{\"node_id\":\"cam_front_door\","
                   "\"ip\":\"" +
                   ip +
                   "\","
                   "\"port\":81,"
                   "\"stream_path\":\"/stream\"}";

  mqttClient.publish(MQTT_DISCOVERY_TOPIC, payload.c_str(), true);

  Serial.print("Camera discovery published: ");
  Serial.println(payload);
}

// =====================================================
// MQTT CONNECTION
// =====================================================

bool connectMQTT() {
  if (strlen(mqttBrokerIP) == 0) {
    Serial.println("MQTT broker IP is empty. Connect to AP to configure.");
    return false;
  }

  Serial.print("Connecting to MQTT broker at ");
  Serial.print(mqttBrokerIP);
  Serial.print("...");

  String clientID =
      "securehome-camera-" + String((uint32_t)ESP.getEfuseMac(), HEX);

  // Last Will and Testament: if node disconnects abruptly, publish OFFLINE
  // (retained)
  bool connected = mqttClient.connect(clientID.c_str(), MQTT_STATUS_TOPIC, 1,
                                      true, "OFFLINE");

  if (connected) {
    Serial.println(" connected!");

    // Publish ONLINE status (retained)
    mqttClient.publish(MQTT_STATUS_TOPIC, "ONLINE", true);

    // Announce camera endpoint to Command Center & AI processor
    publishCameraDiscovery();
    return true;
  } else {
    Serial.print(" failed, MQTT error state: ");
    Serial.println(mqttClient.state());
    return false;
  }
}

// =====================================================
// WIFI + CAPTIVE PORTAL PROVISIONING
// =====================================================

void setupWiFi() {
  loadSettings();

  WiFiManager wifiManager;

  WiFiManagerParameter mqttParameter("mqtt_ip",
                                     "MQTT Broker IP (Command Center)",
                                     mqttBrokerIP, sizeof(mqttBrokerIP));

  wifiManager.addParameter(&mqttParameter);

  Serial.println();
  Serial.println("Starting WiFi provisioning...");
  Serial.println("If not connected, connect to AP: ESP32-Security-Setup");

  bool connected = wifiManager.autoConnect(AP_NAME);

  if (!connected) {
    Serial.println("Wi-Fi provisioning failed. Restarting...");
    delay(3000);
    ESP.restart();
  }

  // Save MQTT Broker IP permanently if entered or updated
  if (strlen(mqttParameter.getValue()) > 0) {
    strncpy(mqttBrokerIP, mqttParameter.getValue(), sizeof(mqttBrokerIP) - 1);
    mqttBrokerIP[sizeof(mqttBrokerIP) - 1] = '\0';
    saveSettings(mqttBrokerIP);
  }

  Serial.println();
  Serial.println("Wi-Fi connected successfully!");
  Serial.print("ESP32 Local IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Active MQTT Broker IP: ");
  Serial.println(mqttBrokerIP);
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("======================================");
  Serial.println(" SecureHome Vision Node (ESP32-CAM)   ");
  Serial.println("======================================");

  // 1. Wi-Fi / SoftAP Provisioning & Settings Load
  setupWiFi();

  // 2. Camera hardware initialization
  if (!initializeCamera()) {
    Serial.println("Camera initialization failed. Halting system.");
    while (true) {
      delay(1000);
    }
  }

  // 3. Start HTTP Server for MJPEG Video Streaming
  startCameraServer();

  // 4. Configure MQTT Client
  mqttClient.setServer(mqttBrokerIP, MQTT_PORT);
  mqttClient.setBufferSize(512); // Accommodate discovery payload comfortably

  // 5. Initial connection to MQTT Broker
  connectMQTT();

  Serial.println();
  Serial.println("Vision Node initialization complete.");
  Serial.print("Stream URL: http://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/stream");
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      unsigned long now = millis();
      // Non-blocking reconnect attempt every 5 seconds
      if (now - lastMqttReconnectAttempt > 5000) {
        lastMqttReconnectAttempt = now;
        connectMQTT();
      }
    } else {
      mqttClient.loop();
    }
  } else {
    Serial.println("Wi-Fi disconnected. Reconnecting...");
    WiFi.reconnect();
    delay(5000);
  }

  delay(10);
}
