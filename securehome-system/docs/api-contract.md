# 📡 SecureHome MQTT API Contract & Communication Specification

This document defines the strict API contract for communication between all system nodes:
- **Broker:** Eclipse Mosquitto (Ports `1883` standard TCP, `9001` WebSockets)
- **Node 1:** Command Center (Web Dashboard & Python OpenCV AI Service)
- **Node 2:** Vision Node (ESP32-CAM)
- **Node 3:** Access Node (ESP32 Dev Board)

---

## 🌐 Broker Network Settings

- **Primary Broker:** HiveMQ Cloud (TLS/TCP port `8883` for nodes & AI, WSS port `8884` for web dashboard)
- **Local Fallback:** Eclipse Mosquitto (Ports `1883` TCP, `9001` WebSockets)
- **Multi-Tenant Base Topic:** `users/<claim_token>/`
- **Legacy Fallback Base Topic:** `security/`

---

## 📋 Multi-Tenant Topic Catalog

| Scoped Topic | Legacy Fallback | Origin / Publisher | Consumer / Subscriber | Payload Format | Retain | QoS | Description |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| `users/<token>/doors/<uid>/command` | `security/door/command` | Web Dashboard | Access Node | String (`"OPEN"` / `"CLOSE"`) | No | 1 | Remote lock/unlock command. |
| `users/<token>/doors/<uid>/status` | `security/door/status` | Access Node | Web Dashboard | String (`"LOCKED"` / `"UNLOCKED"`) | **Yes** | 1 | Physical lock state. |
| `users/<token>/doors/<uid>/access_log` | `security/door/access_log` | Access Node | Web Dashboard | JSON Object | No | 1 | RFID/PIN authentication audit log. |
| `users/<token>/doors/<uid>/enroll/request` | `security/door/enroll/request` | Web Dashboard | Access Node | JSON Object | No | 1 | Request scan mode or registered card list. |
| `users/<token>/doors/<uid>/enroll/scan` | `security/door/enroll/scan` | Access Node | Web Dashboard | JSON Object | No | 1 | Broadcast scanned card UID during enroll mode. |
| `users/<token>/doors/<uid>/enroll/confirm` | `security/door/enroll/confirm` | Web Dashboard | Access Node | JSON Object | No | 1 | Confirm card label and persist to NVS flash. |
| `users/<token>/doors/<uid>/enroll/delete` | `security/door/enroll/delete` | Web Dashboard | Access Node | JSON Object | No | 1 | Delete card from NVS flash by UID. |
| `users/<token>/doors/<uid>/enroll/ack` | `security/door/enroll/ack` | Access Node | Web Dashboard | JSON Object | No | 1 | Storage/deletion status acknowledgment. |
| `users/<token>/doors/<uid>/enroll/list` | `security/door/enroll/list` | Access Node | Web Dashboard | JSON Array | No | 1 | Array of all registered cards and labels. |
| `users/<token>/cameras/<uid>/discovery` | `security/camera/discovery` | Vision Node | Web Dashboard, AI | JSON Object | **Yes** | 1 | Local stream IP/port discovery broadcast. |
| `users/<token>/cameras/<uid>/status` | `security/camera/status` | Vision Node | Web Dashboard, AI | String (`"ONLINE"` / `"OFFLINE"`) | **Yes** | 1 | Availability status (LWT). |
| `users/<token>/cameras/<uid>/relay_url` | `security/camera/relay_url` | AI Processor | Web Dashboard | JSON Object | **Yes** | 1 | Public HTTPS relay URL via Cloudflare Tunnel. |
| `users/<token>/alerts/person` | `security/alerts/person` | AI Processor | Web Dashboard | JSON Object | No | 0 | Real-time computer vision detection alert. |

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

---

### 7. Dynamic RFID Card Enrollment Topics

Used to manage NVS-backed RFID whitelists remotely between the Web Dashboard and Access Node.

#### A. `security/door/enroll/request`
Sent by dashboard to start card scanning mode (active for 30s) or request current card list.
- **Payload:** `{"action": "start"}` or `{"action": "list"}`

#### B. `security/door/enroll/scan`
Published by the Access Node when an RFID card is presented during active enrollment mode.
- **Payload:** `{"uid": "AA:BB:CC:DD"}`

#### C. `security/door/enroll/confirm`
Sent by dashboard to assign a label and persist the scanned card into the ESP32 NVS flash (`door-cards` namespace).
- **Payload:** `{"uid": "AA:BB:CC:DD", "label": "Athira Card"}`

#### D. `security/door/enroll/delete`
Sent by dashboard to remove a card from the whitelist.
- **Payload:** `{"uid": "AA:BB:CC:DD"}`

#### E. `security/door/enroll/ack`
Published by Access Node to confirm registry mutations.
- **Payload:** `{"status": "saved"|"deleted"|"error", "uid": "...", "label": "...", "message": "..."}`

#### F. `security/door/enroll/list`
Published by Access Node on initial connection and after any registry change.
- **Payload:** JSON Array of registered cards:
```json
[
  {"uid": "B4:A1:9F:32", "label": "Athira Tag"},
  {"uid": "E2:4C:19:8A", "label": "Backup Fob"}
]
```
