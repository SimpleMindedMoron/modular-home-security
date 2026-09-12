# 📡 SecureHome MQTT API Contract & Communication Specification

This document defines the strict API contract for communication between all system nodes:
- **Broker:** Eclipse Mosquitto (Ports `1883` standard TCP, `9001` WebSockets)
- **Node 1:** Command Center (Web Dashboard & Python OpenCV AI Service)
- **Node 2:** Vision Node (ESP32-CAM)
- **Node 3:** Access Node (ESP32 Dev Board)

---

## 🌐 Broker Network Settings

- **TCP Port:** `1883` (Used by ESP32 microcontrollers and Python AI service)
- **WebSockets Port:** `9001` (Used by Next.js browser client via MQTT.js)
- **Default Base Topic:** `security/`

Recommended Mosquitto configuration (`mosquitto.conf`):
```conf
listener 1883
allow_anonymous true

listener 9001
protocol websockets
allow_anonymous true
```

---

## 📋 Topic Catalog

| Topic | Origin / Publisher | Consumer / Subscriber | Payload Format | Retain | QoS | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `security/door/command` | Web Dashboard | Access Node | String (`"OPEN"` / `"CLOSE"`) | No | 1 | Remote command to unlock or lock the door. |
| `security/door/status` | Access Node | Web Dashboard | String (`"LOCKED"` / `"UNLOCKED"`) | Yes | 1 | Current state of the physical lock mechanism. |
| `security/door/access_log` | Access Node | Web Dashboard | JSON Object | No | 1 | Audit log of NFC/Keypad entry attempts. |
| `security/camera/discovery` | Vision Node | Web Dashboard, AI | JSON Object | Yes | 1 | Dynamic IP address announcement after Wi-Fi connection. |
| `security/camera/status` | Vision Node | Web Dashboard, AI | String (`"ONLINE"` / `"OFFLINE"`) | Yes | 1 | Node availability status; uses MQTT Last Will & Testament (LWT). |
| `security/alerts/person` | AI Processor | Web Dashboard | JSON Object | No | 0 | Alert triggered when computer vision detects a person. |

---

## 📦 Detailed Topic Schemas & Payloads

### 1. `security/door/command`
Sent by the Web Dashboard to command the physical door servo.

- **Payload:** Raw string
- **Allowed values:**
  - `"OPEN"`: Triggers servo sweep to unlock (e.g., 90 degrees), waits 5 seconds, and automatically closes.
  - `"CLOSE"`: Forces servo back to locked position (0 degrees).

**Example:**
```text
OPEN
```

---

### 2. `security/door/status`
Published by the Access Node whenever the physical lock state changes.

- **Payload:** Raw string
- **Allowed values:**
  - `"LOCKED"`
  - `"UNLOCKED"`

**Example:**
```text
LOCKED
```

---

### 3. `security/door/access_log`
Published by the Access Node whenever an authentication attempt occurs (either via RFID or Keypad PIN).

- **Payload:** JSON Object
- **Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AccessLog",
  "type": "object",
  "properties": {
    "method": {
      "type": "string",
      "enum": ["RFID", "PIN", "REMOTE"]
    },
    "status": {
      "type": "string",
      "enum": ["GRANTED", "DENIED"]
    },
    "identifier": {
      "type": "string",
      "description": "Masked PIN or Card UID (optional)"
    },
    "timestamp": {
      "type": "integer",
      "description": "Epoch millisecond timestamp or device uptime seconds"
    }
  },
  "required": ["method", "status"]
}
```

**Example:**
```json
{
  "method": "RFID",
  "status": "GRANTED",
  "identifier": "B4:A1:9F:32",
  "timestamp": 1726131000000
}
```

---

### 4. `security/camera/discovery`
Published by the Vision Node upon successful Wi-Fi and MQTT connection. Allows the Web Dashboard and AI processor to locate the MJPEG stream without hardcoded IPs.

- **Payload:** JSON Object
- **Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CameraDiscovery",
  "type": "object",
  "properties": {
    "node_id": {
      "type": "string",
      "description": "Unique identifier, e.g. cam_front_door"
    },
    "ip": {
      "type": "string",
      "description": "Assigned IPv4 address on the local network"
    },
    "port": {
      "type": "integer",
      "default": 80
    },
    "stream_path": {
      "type": "string",
      "default": "/stream"
    }
  },
  "required": ["ip"]
}
```

**Example:**
```json
{
  "node_id": "cam_front_door",
  "ip": "192.168.1.145",
  "port": 81,
  "stream_path": "/stream"
}
```

---

### 5. `security/camera/status`
Tracks the live status of the camera node. Configured as the **Last Will and Testament (LWT)** message during MQTT connection.

- **LWT Configuration:**
  - Topic: `security/camera/status`
  - Payload: `"OFFLINE"`
  - Retain: `true`
  - QoS: `1`
- **On Connect:**
  - Topic: `security/camera/status`
  - Payload: `"ONLINE"`
  - Retain: `true`
  - QoS: `1`

---

### 6. `security/alerts/person`
Published by the Python AI Processor when OpenCV detects human presence in the MJPEG stream.

- **Payload:** JSON Object
- **Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PersonAlert",
  "type": "object",
  "properties": {
    "camera": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "timestamp": { "type": "string" },
    "bbox": {
      "type": "array",
      "items": { "type": "integer" },
      "minItems": 4,
      "maxItems": 4,
      "description": "[x, y, width, height]"
    }
  },
  "required": ["camera", "timestamp"]
}
```

**Example:**
```json
{
  "camera": "cam_front_door",
  "confidence": 0.92,
  "timestamp": "2026-09-12T14:15:00Z",
  "bbox": [120, 80, 210, 360]
}
```
