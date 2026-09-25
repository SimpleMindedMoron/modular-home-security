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

// Enrollment topics (legacy/fallback — scoped versions built dynamically)
const char* TOPIC_ENROLL_REQUEST = "security/door/enroll/request";
const char* TOPIC_ENROLL_CONFIRM = "security/door/enroll/confirm";
const char* TOPIC_ENROLL_DELETE  = "security/door/enroll/delete";
const char* TOPIC_ENROLL_SCAN    = "security/door/enroll/scan";
const char* TOPIC_ENROLL_ACK     = "security/door/enroll/ack";
const char* TOPIC_ENROLL_LIST    = "security/door/enroll/list";

// =====================================================================
// CARD REGISTRY — NVS-BACKED DYNAMIC WHITELIST
// =====================================================================
// Stored in NVS namespace "door-cards" as:
//   "count"      → int  (number of enrolled cards, max MAX_ENROLLED_CARDS)
//   "uid_0" …    → String  ("AA:BB:CC:DD")
//   "lbl_0" …    → String  (user-defined label)
//
#define MAX_ENROLLED_CARDS 20
#define CARD_NS "door-cards"

struct EnrolledCard {
  char uid[20];   // "AA:BB:CC:DD\0"
  char label[49]; // Up to 48 chars + null
};

EnrolledCard enrolledCards[MAX_ENROLLED_CARDS];
int numEnrolledCards = 0;

// Enrollment state machine
bool enrollMode = false;
unsigned long enrollModeStartedAt = 0;
const unsigned long ENROLL_TIMEOUT_MS = 30000; // 30 seconds to tap a card

// Static fallback PINs (keypad — unchanged from original design)
String authorizedPins[] = {"1234", "9999"};
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

// Enroll sub-topic builder
String getTopicEnroll(const char* sub) {
  if (strlen(userClaimToken) > 0) {
    return "users/" + String(userClaimToken) + "/doors/" + String(deviceUid) + "/enroll/" + String(sub);
  }
  return String("security/door/enroll/") + String(sub);
}

// =====================================================================
// NVS — LOAD ENROLLED CARDS
// =====================================================================
void loadEnrolledCards() {
  preferences.begin(CARD_NS, true); // read-only
  numEnrolledCards = preferences.getInt("count", 0);
  if (numEnrolledCards > MAX_ENROLLED_CARDS) numEnrolledCards = MAX_ENROLLED_CARDS;
  for (int i = 0; i < numEnrolledCards; i++) {
    String uidKey = "uid_" + String(i);
    String lblKey = "lbl_" + String(i);
    String uid = preferences.getString(uidKey.c_str(), "");
    String lbl = preferences.getString(lblKey.c_str(), uid);
    uid.toCharArray(enrolledCards[i].uid, sizeof(enrolledCards[i].uid));
    lbl.toCharArray(enrolledCards[i].label, sizeof(enrolledCards[i].label));
  }
  preferences.end();
  Serial.printf("[NVS] Loaded %d enrolled card(s).\n", numEnrolledCards);
}

// =====================================================================
// NVS — PERSIST ENROLLED CARDS (writes ALL slots in a single namespace)
// =====================================================================
void saveEnrolledCards() {
  preferences.begin(CARD_NS, false); // read-write
  preferences.putInt("count", numEnrolledCards);
  for (int i = 0; i < numEnrolledCards; i++) {
    String uidKey = "uid_" + String(i);
    String lblKey = "lbl_" + String(i);
    preferences.putString(uidKey.c_str(), enrolledCards[i].uid);
    preferences.putString(lblKey.c_str(), enrolledCards[i].label);
  }
  preferences.end();
  Serial.printf("[NVS] Saved %d enrolled card(s).\n", numEnrolledCards);
}

// =====================================================================
// CARD REGISTRY HELPERS
// =====================================================================
bool isEnrolledUID(const char* uidStr) {
  for (int i = 0; i < numEnrolledCards; i++) {
    if (strcmp(enrolledCards[i].uid, uidStr) == 0) return true;
  }
  return false;
}

// Returns index of card in registry, -1 if not found
int findCardIndex(const char* uidStr) {
  for (int i = 0; i < numEnrolledCards; i++) {
    if (strcmp(enrolledCards[i].uid, uidStr) == 0) return i;
  }
  return -1;
}

// =====================================================================
// PUBLISH CARD LIST TO DASHBOARD (on connect + after every change)
// =====================================================================
void publishCardList() {
  // Build JSON array: [{"uid":"AA:BB:CC:DD","label":"My Card"},...]
  // PubSubClient default buffer is small; bump to 1024 in setup
  const size_t cap = JSON_ARRAY_SIZE(MAX_ENROLLED_CARDS) +
                     MAX_ENROLLED_CARDS * JSON_OBJECT_SIZE(2);
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < numEnrolledCards; i++) {
    JsonObject obj = arr.add<JsonObject>();
    obj["uid"]   = enrolledCards[i].uid;
    obj["label"] = enrolledCards[i].label;
  }
  char buf[1024];
  serializeJson(doc, buf, sizeof(buf));

  String listTopic = getTopicEnroll("list");
  mqttClient.publish(listTopic.c_str(), buf);
  mqttClient.publish(TOPIC_ENROLL_LIST, buf);
  Serial.println("[Enroll] Published card list to dashboard.");
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
// MQTT TELEMETRY & AUDIT LOGGING
// =====================================================================
void publishDoorStatus(bool unlocked) {
  const char *payload = unlocked ? "UNLOCKED" : "LOCKED";
  // Retained = true per API contract so web dashboard immediately reflects lock state
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
// ENROLLMENT MQTT HANDLERS
// =====================================================================

// Dashboard requested card list or start enroll mode
void handleEnrollRequest(const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) return;

  const char* action = doc["action"] | "start";

  if (strcmp(action, "list") == 0) {
    publishCardList();
    return;
  }

  // action == "start" → enter scan mode
  enrollMode = true;
  enrollModeStartedAt = millis();
  Serial.println("[Enroll] Enrollment mode ACTIVE. Tap a card within 30 seconds...");
}

// Dashboard confirmed save of a scanned card
void handleEnrollConfirm(const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    Serial.println("[Enroll] Failed to parse confirm payload.");
    return;
  }

  const char* uid   = doc["uid"]   | "";
  const char* label = doc["label"] | uid;

  if (strlen(uid) == 0) return;

  // If card already registered, update label
  int existing = findCardIndex(uid);
  if (existing >= 0) {
    strncpy(enrolledCards[existing].label, label, sizeof(enrolledCards[existing].label) - 1);
    enrolledCards[existing].label[sizeof(enrolledCards[existing].label) - 1] = '\0';
    saveEnrolledCards();
    Serial.printf("[Enroll] Updated label for card %s → \"%s\"\n", uid, label);
  } else if (numEnrolledCards < MAX_ENROLLED_CARDS) {
    strncpy(enrolledCards[numEnrolledCards].uid,   uid,   sizeof(enrolledCards[numEnrolledCards].uid) - 1);
    strncpy(enrolledCards[numEnrolledCards].label, label, sizeof(enrolledCards[numEnrolledCards].label) - 1);
    enrolledCards[numEnrolledCards].uid[sizeof(enrolledCards[numEnrolledCards].uid) - 1] = '\0';
    enrolledCards[numEnrolledCards].label[sizeof(enrolledCards[numEnrolledCards].label) - 1] = '\0';
    numEnrolledCards++;
    saveEnrolledCards();
    Serial.printf("[Enroll] Card %s registered as \"%s\" (%d/%d slots used).\n",
                  uid, label, numEnrolledCards, MAX_ENROLLED_CARDS);
  } else {
    // Registry full
    JsonDocument ack;
    ack["status"]  = "error";
    ack["uid"]     = uid;
    ack["message"] = "Registry full (20 cards max). Delete a card first.";
    char buf[256];
    serializeJson(ack, buf);
    mqttClient.publish(getTopicEnroll("ack").c_str(), buf);
    mqttClient.publish(TOPIC_ENROLL_ACK, buf);
    return;
  }

  // Publish ack + updated list
  JsonDocument ack;
  ack["status"] = "saved";
  ack["uid"]    = uid;
  ack["label"]  = label;
  char buf[256];
  serializeJson(ack, buf);
  mqttClient.publish(getTopicEnroll("ack").c_str(), buf);
  mqttClient.publish(TOPIC_ENROLL_ACK, buf);
  publishCardList();
}

// Dashboard requested deletion of a card by UID
void handleEnrollDelete(const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) return;

  const char* uid = doc["uid"] | "";
  if (strlen(uid) == 0) return;

  int idx = findCardIndex(uid);
  if (idx < 0) {
    Serial.printf("[Enroll] Delete: card %s not found in registry.\n", uid);
    return;
  }

  // Compact array (shift left)
  for (int i = idx; i < numEnrolledCards - 1; i++) {
    memcpy(&enrolledCards[i], &enrolledCards[i + 1], sizeof(EnrolledCard));
  }
  memset(&enrolledCards[numEnrolledCards - 1], 0, sizeof(EnrolledCard));
  numEnrolledCards--;
  saveEnrolledCards();

  Serial.printf("[Enroll] Card %s deleted. %d card(s) remaining.\n", uid, numEnrolledCards);

  // Ack + updated list
  JsonDocument ack;
  ack["status"] = "deleted";
  ack["uid"]    = uid;
  char buf[128];
  serializeJson(ack, buf);
  mqttClient.publish(getTopicEnroll("ack").c_str(), buf);
  mqttClient.publish(TOPIC_ENROLL_ACK, buf);
  publishCardList();
}

// =====================================================================
// MQTT CALLBACK (REMOTE COMMANDS + ENROLLMENT)
// =====================================================================
void mqttCallback(char *topic, byte *payload, unsigned int length) {
  char message[512];
  unsigned int copyLen = (length < sizeof(message) - 1) ? length : sizeof(message) - 1;
  memcpy(message, payload, copyLen);
  message[copyLen] = '\0';

  String topicStr = String(topic);

  // ── Door commands ─────────────────────────────────────────
  bool isCmd = (topicStr == TOPIC_COMMAND);
  if (strlen(userClaimToken) > 0 && topicStr == getTopicCommand()) isCmd = true;
  if (isCmd) {
    String msg = String(message);
    msg.trim();
    if (msg == "OPEN") {
      unlockDoor("REMOTE", "Dashboard Command");
    } else if (msg == "CLOSE") {
      lockDoor();
    }
    return;
  }

  // ── Enrollment: start scan mode / list request ────────────
  if (topicStr == TOPIC_ENROLL_REQUEST || topicStr == getTopicEnroll("request")) {
    handleEnrollRequest(message);
    return;
  }

  // ── Enrollment: dashboard confirmed card save ─────────────
  if (topicStr == TOPIC_ENROLL_CONFIRM || topicStr == getTopicEnroll("confirm")) {
    handleEnrollConfirm(message);
    return;
  }

  // ── Enrollment: dashboard requested delete ────────────────
  if (topicStr == TOPIC_ENROLL_DELETE || topicStr == getTopicEnroll("delete")) {
    handleEnrollDelete(message);
    return;
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

    // Subscribe to door commands (legacy + scoped)
    mqttClient.subscribe(TOPIC_COMMAND);
    // Subscribe to enrollment topics (legacy)
    mqttClient.subscribe(TOPIC_ENROLL_REQUEST);
    mqttClient.subscribe(TOPIC_ENROLL_CONFIRM);
    mqttClient.subscribe(TOPIC_ENROLL_DELETE);

    if (strlen(userClaimToken) > 0) {
      // Scoped command topic
      String scopedCmd = getTopicCommand();
      mqttClient.subscribe(scopedCmd.c_str());
      Serial.print("Subscribed to scoped command topic: ");
      Serial.println(scopedCmd);

      // Scoped enrollment topics
      mqttClient.subscribe(getTopicEnroll("request").c_str());
      mqttClient.subscribe(getTopicEnroll("confirm").c_str());
      mqttClient.subscribe(getTopicEnroll("delete").c_str());
    }

    publishDoorStatus(doorUnlocked); // Announce current state (retained)
    publishCardList();               // Send registered cards to dashboard
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

  // Build UID string ("AA:BB:CC:DD")
  char uidStr[20];
  snprintf(uidStr, sizeof(uidStr), "%02X:%02X:%02X:%02X",
           rfid.uid.uidByte[0], rfid.uid.uidByte[1],
           rfid.uid.uidByte[2], rfid.uid.uidByte[3]);

  // ── Enrollment mode: publish scanned UID, exit enroll mode ─
  if (enrollMode) {
    enrollMode = false;
    Serial.printf("[Enroll] Card scanned in enroll mode: %s\n", uidStr);

    // Publish the UID back to the dashboard for confirmation
    JsonDocument doc;
    doc["uid"] = uidStr;
    char buf[128];
    serializeJson(doc, buf);
    mqttClient.publish(getTopicEnroll("scan").c_str(), buf);
    mqttClient.publish(TOPIC_ENROLL_SCAN, buf);

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  // ── Normal access check ───────────────────────────────────
  if (isEnrolledUID(uidStr)) {
    // Find label for the log
    int idx = findCardIndex(uidStr);
    const char* label = (idx >= 0) ? enrolledCards[idx].label : uidStr;
    unlockDoor("RFID", label);
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

bool isAuthorizedPin(const String &pin) {
  for (int i = 0; i < numAuthorizedPins; i++) {
    if (authorizedPins[i] == pin) return true;
  }
  return false;
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

  // 3. Load NVS enrolled cards
  loadEnrolledCards();

  // 4. Wi-Fi & NVS Provisioning
  setupWiFiAndConfig();

  // 5. MQTT Client setup — HiveMQ Cloud TLS on port 8883
  mqttClient.setServer(mqttBrokerHost, 8883);
  mqttClient.setCallback(mqttCallback);
  // Increase buffer for card list JSON (up to 1024 bytes)
  mqttClient.setBufferSize(1024);

  // 6. Initial MQTT connection attempt
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

  // Enrollment mode auto-timeout (30 seconds)
  if (enrollMode && (millis() - enrollModeStartedAt >= ENROLL_TIMEOUT_MS)) {
    enrollMode = false;
    Serial.println("[Enroll] Enrollment mode timed out. No card was scanned.");
  }

  delay(10);
}
