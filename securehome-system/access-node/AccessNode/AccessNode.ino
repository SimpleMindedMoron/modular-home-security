#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

// =====================================================================
// PIN DEFINITIONS
// =====================================================================
// RC522 RFID SPI (VSPI): SCK=18, MISO=19, MOSI=23
// Using GPIO 21 for SS to avoid strapping pin GPIO 5 boot interference
#define RFID_SS_PIN   21
#define RFID_RST_PIN  22
#define SERVO_PIN     16

// 4x3 Matrix Keypad (Row pins: 13, 14, 27, 26 | Col pins: 25, 33, 32)
// Note: If using a 4x4 keypad, set KEYPAD_COLS to 4 and add GPIO 4 to colPins
const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 3;
byte rowPins[KEYPAD_ROWS] = {13, 14, 27, 26};
byte colPins[KEYPAD_COLS] = {25, 33, 32};
char keys[KEYPAD_ROWS][KEYPAD_COLS] = {
  {'1', '2', '3'},
  {'4', '5', '6'},
  {'7', '8', '9'},
  {'*', '0', '#'}
};

// =====================================================================
// SERVO ANGLES & TIMING
// =====================================================================
const int SERVO_LOCKED_ANGLE   = 0;
const int SERVO_UNLOCKED_ANGLE = 90;
const unsigned long UNLOCK_HOLD_MS = 5000; // 5-second unlock pulse

// =====================================================================
// MQTT TOPICS (Strictly adhering to docs/api-contract.md)
// =====================================================================
const char* TOPIC_COMMAND    = "security/door/command";
const char* TOPIC_STATUS     = "security/door/status";
const char* TOPIC_ACCESS_LOG = "security/door/access_log";

// =====================================================================
// LOCAL ACCESS CONTROL LISTS (White-list)
// =====================================================================
struct AuthorizedCard {
  byte uid[4];
  byte length;
};

AuthorizedCard authorizedCards[] = {
  {{0xDE, 0xAD, 0xBE, 0xEF}, 4},   // Replace with real card/fob UIDs
  {{0x12, 0x34, 0x56, 0x78}, 4},
};
const int numAuthorizedCards = sizeof(authorizedCards) / sizeof(authorizedCards[0]);

String authorizedPins[] = {"1234", "9999"}; // Replace with real PINs
const int numAuthorizedPins = sizeof(authorizedPins) / sizeof(authorizedPins[0]);

// =====================================================================
// GLOBALS & PERIPHERALS
// =====================================================================
Preferences preferences;
// HiveMQ Cloud host (max 80 chars), e.g. xxxx.s1.eu.hivemq.cloud
char mqttBrokerHost[80] = "";
char mqttUser[48] = "";
char mqttPass[48] = "";
char userClaimToken[64] = "";
char deviceUid[32] = "ESP32_ACCESS_01";

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, KEYPAD_ROWS, KEYPAD_COLS);
Servo doorServo;

// WiFiClientSecure enables TLS — required for HiveMQ Cloud port 8883
WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);

String pinBuffer = "";
bool doorUnlocked = false;
unsigned long unlockStartedAt = 0;
unsigned long lastMqttReconnectAttempt = 0;
unsigned long lastWifiReconnectAttempt = 0;
bool shouldSaveConfig = false;

// =====================================================================
// DYNAMIC SCOPED TOPICS (MULTI-TENANCY)
// =====================================================================
String getTopicCommand() {
  if (strlen(userClaimToken) > 0) {
    return "users/" + String(userClaimToken) + "/doors/" + String(deviceUid) + "/command";
  }
  return TOPIC_COMMAND;
}

String getTopicStatus() {
  if (strlen(userClaimToken) > 0) {
    return "users/" + String(userClaimToken) + "/doors/" + String(deviceUid) + "/status";
  }
  return TOPIC_STATUS;
}

String getTopicAccessLog() {
  if (strlen(userClaimToken) > 0) {
    return "users/" + String(userClaimToken) + "/doors/" + String(deviceUid) + "/access_log";
  }
  return TOPIC_ACCESS_LOG;
}

// =====================================================================
// WIFI CONFIGURATION & NVS PERSISTENCE
// =====================================================================
void saveConfigCallback() {
  shouldSaveConfig = true;
}

void setupWiFiAndConfig() {
  preferences.begin("door-cfg", false);
  String savedHost = preferences.getString("mqtt_host", "");
  if (savedHost.length() > 0) {
    savedHost.toCharArray(mqttBrokerHost, sizeof(mqttBrokerHost));
  }
  String savedUser = preferences.getString("mqtt_user", "");
  savedUser.toCharArray(mqttUser, sizeof(mqttUser));
  String savedPass = preferences.getString("mqtt_pass", "");
  savedPass.toCharArray(mqttPass, sizeof(mqttPass));
  String savedClaim = preferences.getString("claim_token", "");
  if (savedClaim.length() > 0) {
    savedClaim.toCharArray(userClaimToken, sizeof(userClaimToken));
  }
  String savedUid = preferences.getString("device_uid", "ESP32_ACCESS_01");
  if (savedUid.length() > 0) {
    savedUid.toCharArray(deviceUid, sizeof(deviceUid));
  }
  preferences.end();

  WiFiManagerParameter customMqttServer("server", "MQTT Broker Host (e.g. xxxx.hivemq.cloud)", mqttBrokerHost, sizeof(mqttBrokerHost));
  WiFiManagerParameter customMqttUser("mqttuser", "MQTT Username", mqttUser, sizeof(mqttUser));
  WiFiManagerParameter customMqttPass("mqttpass", "MQTT Password", mqttPass, sizeof(mqttPass), "type='password'");
  WiFiManagerParameter customClaimToken("claim", "Account Claim Token (from dashboard)", userClaimToken, sizeof(userClaimToken));
  WiFiManagerParameter customDeviceUid("device_uid", "Device UID (e.g. ESP32_ACCESS_01)", deviceUid, sizeof(deviceUid));

  WiFiManager wm;
  wm.setSaveConfigCallback(saveConfigCallback);
  wm.addParameter(&customMqttServer);
  wm.addParameter(&customMqttUser);
  wm.addParameter(&customMqttPass);
  wm.addParameter(&customClaimToken);
  wm.addParameter(&customDeviceUid);

  Serial.println("\nStarting Access Node Wi-Fi provisioning...");

  // Skip cert verification — TLS is still encrypted, just without pinning
  // This is appropriate for embedded IoT devices using HiveMQ Cloud
  espClient.setInsecure();

  // Check if '*' is pressed on boot to force a factory reset
  char bootKey = keypad.getKey();
  if (bootKey == '*') {
    Serial.println("[*] Keypad '*' pressed on boot. Clearing Wi-Fi & MQTT settings...");
    wm.resetSettings();
    preferences.begin("door-cfg", false);
    preferences.clear();
    preferences.end();
    mqttBrokerHost[0] = '\0';
    userClaimToken[0] = '\0';
  }

  bool wifiReady = false;
  // If MQTT broker host is missing, force the configuration portal so the user can enter it!
  if (strlen(mqttBrokerHost) == 0) {
    Serial.println("\n[!] No MQTT Broker Host found. Starting configuration portal...");
    Serial.println("[!] Connect to AP 'ESP32-DoorLock-Setup' to enter your Wi-Fi & MQTT Host.");
    wifiReady = wm.startConfigPortal("ESP32-DoorLock-Setup");
  } else {
    Serial.println("Connecting using saved Wi-Fi credentials...");
    wifiReady = wm.autoConnect("ESP32-DoorLock-Setup");
  }

  if (!wifiReady) {
    Serial.println("Wi-Fi provisioning failed. Restarting in 3 seconds...");
    delay(3000);
    ESP.restart();
  }

  // Safely copy bounded string parameters
  strncpy(mqttBrokerHost, customMqttServer.getValue(), sizeof(mqttBrokerHost) - 1);
  mqttBrokerHost[sizeof(mqttBrokerHost) - 1] = '\0';
  strncpy(mqttUser, customMqttUser.getValue(), sizeof(mqttUser) - 1);
  mqttUser[sizeof(mqttUser) - 1] = '\0';
  strncpy(mqttPass, customMqttPass.getValue(), sizeof(mqttPass) - 1);
  mqttPass[sizeof(mqttPass) - 1] = '\0';
  strncpy(userClaimToken, customClaimToken.getValue(), sizeof(userClaimToken) - 1);
  userClaimToken[sizeof(userClaimToken) - 1] = '\0';
  strncpy(deviceUid, customDeviceUid.getValue(), sizeof(deviceUid) - 1);
  deviceUid[sizeof(deviceUid) - 1] = '\0';

  if (shouldSaveConfig || strlen(mqttBrokerHost) > 0) {
    preferences.begin("door-cfg", false);
    preferences.putString("mqtt_host", mqttBrokerHost);
    preferences.putString("mqtt_user", mqttUser);
    preferences.putString("mqtt_pass", mqttPass);
    preferences.putString("claim_token", userClaimToken);
    preferences.putString("device_uid", deviceUid);
    preferences.end();
    shouldSaveConfig = false;
  }

  Serial.println("\nWi-Fi connected successfully!");
  Serial.print("ESP32 Local IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("MQTT Broker Host: ");
  Serial.println(mqttBrokerHost);
  Serial.println(mqttUser[0] ? "MQTT Auth: credentials set" : "MQTT Auth: none configured");
  if (strlen(userClaimToken) > 0) {
    Serial.print("Claim Token: ");
    Serial.println(userClaimToken);
    Serial.print("Device UID: ");
    Serial.println(deviceUid);
  }
}

// =====================================================================
// ACCESS CONTROL CHECKS
// =====================================================================
bool isAuthorizedUID(byte *uid, byte size) {
  for (int i = 0; i < numAuthorizedCards; i++) {
    if (authorizedCards[i].length != size) continue;
    if (memcmp(authorizedCards[i].uid, uid, size) == 0) return true;
  }
  return false;
}

bool isAuthorizedPin(const String &pin) {
  for (int i = 0; i < numAuthorizedPins; i++) {
    if (authorizedPins[i] == pin) return true;
  }
  return false;
}

// =====================================================================
// MQTT TELEMETRY & AUDIT LOGGING
// =====================================================================
void publishDoorStatus(bool unlocked) {
  const char *payload = unlocked ? "UNLOCKED" : "LOCKED";
  // Retained = true per API contract so web dashboard immediately receives lock state
  mqttClient.publish(TOPIC_STATUS, payload, true);
  if (strlen(userClaimToken) > 0) {
    mqttClient.publish(getTopicStatus().c_str(), payload, true);
  }
}

void publishAccessLog(const char *method, bool granted, const char *identifier = "") {
  // JsonDocument is compatible with both ArduinoJson v6 and v7
  JsonDocument doc;
  doc["method"] = method;
  doc["status"] = granted ? "GRANTED" : "DENIED";
  if (strlen(identifier) > 0) {
    doc["identifier"] = identifier;
  }

  char buffer[192];
  serializeJson(doc, buffer);
  mqttClient.publish(TOPIC_ACCESS_LOG, buffer);
  if (strlen(userClaimToken) > 0) {
    mqttClient.publish(getTopicAccessLog().c_str(), buffer);
  }
}

// =====================================================================
// SERVO ACTUATION (DEADBOLT LOCK / UNLOCK)
// =====================================================================
void unlockDoor(const char *method, const char *identifier = "") {
  doorServo.write(SERVO_UNLOCKED_ANGLE);
  doorUnlocked = true;
  unlockStartedAt = millis();

  publishDoorStatus(true);
  publishAccessLog(method, true, identifier);
  Serial.printf("Door UNLOCKED via %s (Identifier: %s)\n", method, identifier);
}

void lockDoor() {
  doorServo.write(SERVO_LOCKED_ANGLE);
  doorUnlocked = false;

  publishDoorStatus(false);
  Serial.println("Door LOCKED");
}

// =====================================================================
// MQTT CALLBACK (REMOTE COMMANDS)
// =====================================================================
void mqttCallback(char *topic, byte *payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();

  bool isCmd = (String(topic) == TOPIC_COMMAND);
  if (strlen(userClaimToken) > 0 && String(topic) == getTopicCommand()) {
    isCmd = true;
  }

  if (isCmd) {
    if (message == "OPEN") {
      unlockDoor("REMOTE", "Dashboard Command"); // REMOTE enum per API Contract
    } else if (message == "CLOSE") {
      lockDoor();
    }
  }
}

// =====================================================================
// NON-BLOCKING MQTT CONNECTION
// =====================================================================
bool reconnectMQTT() {
  if (strlen(mqttBrokerHost) == 0) return false;

  String clientId = "securehome-access-" + String(WiFi.macAddress());
  // Always use credentials — HiveMQ Cloud requires authentication
  bool connected = mqttClient.connect(clientId.c_str(), mqttUser, mqttPass);

  if (connected) {
    Serial.println("MQTT connected to HiveMQ Cloud!");
    mqttClient.subscribe(TOPIC_COMMAND);
    if (strlen(userClaimToken) > 0) {
      String scopedCmd = getTopicCommand();
      mqttClient.subscribe(scopedCmd.c_str());
      Serial.print("Subscribed to scoped command topic: ");
      Serial.println(scopedCmd);
    }
    publishDoorStatus(doorUnlocked); // Announce current state (retained)
    return true;
  } else {
    Serial.printf("MQTT connection failed (state: %d)\n", mqttClient.state());
    return false;
  }
}

// =====================================================================
// RFID HARDWARE SCAN
// =====================================================================
void checkRFID() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  char uidStr[20];
  snprintf(uidStr, sizeof(uidStr), "%02X:%02X:%02X:%02X",
           rfid.uid.uidByte[0], rfid.uid.uidByte[1], rfid.uid.uidByte[2], rfid.uid.uidByte[3]);

  if (isAuthorizedUID(rfid.uid.uidByte, rfid.uid.size)) {
    unlockDoor("RFID", uidStr);
  } else {
    publishAccessLog("RFID", false, uidStr);
    Serial.printf("Access DENIED for card: %s\n", uidStr);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// =====================================================================
// KEYPAD SCAN
// =====================================================================
void checkKeypad() {
  char key = keypad.getKey();
  if (!key) return;

  if (key == '#') {
    Serial.printf("\n[Keypad] '#' pressed -> Submitting PIN: \"%s\"\n", pinBuffer.c_str());

    if (pinBuffer == "000000" || pinBuffer == "999999") {
      Serial.println("[RESET] Factory reset triggered via keypad! Clearing Wi-Fi & MQTT settings...");
      WiFiManager wm;
      wm.resetSettings();
      preferences.begin("door-cfg", false);
      preferences.clear();
      preferences.end();
      Serial.println("Restarting into setup portal in 2 seconds...");
      delay(2000);
      ESP.restart();
    } else if (pinBuffer.length() > 0 && isAuthorizedPin(pinBuffer)) {
      Serial.printf("[Keypad] PIN \"%s\" MATCHED! Access GRANTED.\n", pinBuffer.c_str());
      unlockDoor("PIN", "Authorized PIN");
    } else {
      Serial.printf("[Keypad] PIN \"%s\" INVALID. Access DENIED.\n", pinBuffer.c_str());
      publishAccessLog("PIN", false, "Invalid PIN");
    }
    pinBuffer = "";
  } else if (key == '*') {
    pinBuffer = ""; // Clear buffer
    Serial.println("\n[Keypad] '*' pressed -> PIN buffer cleared.");
  } else {
    pinBuffer += key;
    if (pinBuffer.length() > 8) {
      pinBuffer = pinBuffer.substring(pinBuffer.length() - 8);
    }
    Serial.printf("[Keypad] Key: '%c' | Current Buffer: \"%s\"\n", key, pinBuffer.c_str());
  }
}

// =====================================================================
// SETUP
// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n======================================");
  Serial.println(" SecureHome Access Node (Door Lock)   ");
  Serial.println("======================================");

  // 1. SPI & RFID initialization
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("MFRC522 RFID reader initialized.");

  // 2. Servo configuration (50Hz PWM, 500-2400us pulse width)
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  doorServo.setPeriodHertz(50);
  doorServo.attach(SERVO_PIN, 500, 2400);
  doorServo.write(SERVO_LOCKED_ANGLE);
  Serial.println("MG90S Servo initialized (LOCKED position).");

  // 3. Wi-Fi & NVS Provisioning
  setupWiFiAndConfig();

  // 4. MQTT Client setup — HiveMQ Cloud TLS on port 8883
  mqttClient.setServer(mqttBrokerHost, 8883);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(256);

  // 5. Initial MQTT connection attempt
  reconnectMQTT();

  Serial.println("Access Node ready. Local entry active.");
}

// =====================================================================
// MAIN LOOP (AUTONOMOUS EXECUTION)
// =====================================================================
void loop() {
  // Non-blocking network management: ensures RFID & Keypad are never stalled
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      unsigned long now = millis();
      if (now - lastMqttReconnectAttempt > 5000) {
        lastMqttReconnectAttempt = now;
        reconnectMQTT();
      }
    } else {
      mqttClient.loop();
    }
  } else {
    unsigned long now = millis();
    if (now - lastWifiReconnectAttempt > 10000) {
      lastWifiReconnectAttempt = now;
      Serial.println("Wi-Fi disconnected. Reconnecting in background...");
      WiFi.reconnect();
    }
  }

  // Autonomous local authentication checks (run continuously)
  checkRFID();
  checkKeypad();

  // Auto-relock after UNLOCK_HOLD_MS (5 seconds)
  if (doorUnlocked && (millis() - unlockStartedAt >= UNLOCK_HOLD_MS)) {
    lockDoor();
  }

  delay(10);
}
