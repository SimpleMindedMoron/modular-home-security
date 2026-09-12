# 🛡️ SecureHome System

A modular, highly scalable home security system built with budget ESP32 microcontrollers, a local MQTT event broker, computer vision AI person-detection, and a centralized **Next.js** web dashboard.

---

## ⚡ Framework Notice: Web Dashboard is Built with Next.js
The Command Center web application (`command-center/web-dashboard`) is built using **Next.js 14** (App Router, React, and TypeScript) along with Vanilla CSS, Lucide icons, and the MQTT.js WebSocket client.

---

## 🏛️ System Architecture

SecureHome implements a decoupled, event-driven publish/subscribe architecture via **Eclipse Mosquitto MQTT**:

```
                           +------------------------+
                           |  Central Server / PC   |
                           |  - Mosquitto Broker    |
                           |    (Ports: 1883, 9001) |
                           +-----------+------------+
                                       |
          +----------------------------+----------------------------+
          |                            |                            |
          v                            v                            v
+-------------------+        +-------------------+        +-------------------+
|  Command Center   |        |    Vision Node    |        |    Access Node    |
| - Next.js Web App |        | - ESP32-CAM Node  |        | - ESP32 Dev Board |
| - AI CV Processor |        | - MJPEG Stream    |        | - RC522 RFID (SPI)|
| (Arjun)           |        | (Teammate B)      |        | (Teammate A)      |
+-------------------+        +-------------------+        +-------------------+
```

---

## 👥 Team Workload & Code Placement Guide

> [!IMPORTANT]
> Each team member must add their respective code inside their assigned folder as described below:

### 1. Arjun (Lead / Full-Stack)
- **Folder:** `command-center/`
  - `command-center/web-dashboard/` -> **Next.js Web Dashboard** (UI, Supabase auth, MQTT.js WebSocket client).
  - `command-center/ai-processor/` -> **Python OpenCV Service** (`main.py`, requirements, person-detection model).
- **Run commands:**
  ```bash
  npm run dev        # Run Next.js dashboard
  npm run ai:start   # Run Python OpenCV AI service
  ```

### 2. Teammate B (Network / Embedded)
- **Folder:** `vision-node/`
  - Place your ESP32-CAM sketch folder here:
    ```
    vision-node/
    ├── VisionNode/
    │   ├── VisionNode.ino       <-- Main ESP32-CAM sketch (WiFiManager, MJPEG, MQTT)
    │   └── app_httpd.cpp        <-- (Optional) Web server streaming helper
    ├── README.md                <-- Node setup instructions
    └── .gitignore
    ```
- **Requirements:**
  - Board: **AI Thinker ESP32-CAM** (Solder 100µF+ capacitor across 5V and GND).
  - SoftAP captive portal using `WiFiManager` with custom MQTT IP field.
  - MJPEG streaming server on Port 81 (`/stream`).
  - Publish dynamic IP to `security/camera/discovery` and LWT status to `security/camera/status`.

### 3. Teammate A (Hardware / Embedded)
- **Folder:** `access-node/`
  - Place your ESP32 Dev Board sketch folder here:
    ```
    access-node/
    ├── AccessNode/
    │   └── AccessNode.ino       <-- Main Arduino sketch (RFID, Keypad, Servo, MQTT)
    ├── README.md                <-- Node setup instructions
    └── .gitignore
    ```
- **Requirements:**
  - Board: **ESP32 30-Pin Dev Board**.
  - Wiring: Follow pinout in [docs/wiring-diagrams/pinouts.md](docs/wiring-diagrams/pinouts.md) (RC522 3.3V SPI, 4x4 Keypad, MG90S PWM Servo).
  - Dual-factor authentication (RFID card scan + Keypad PIN).
  - Actuate servo (sweep to unlock, wait 5s, auto-relock).
  - Subscribe to `security/door/command` (`"OPEN"` / `"CLOSE"`).
  - Publish state to `security/door/status` and logs to `security/door/access_log`.

---

## 📂 Repository Organization

```
securehome-system/
├── README.md                     # System specifications & team guide
├── docs/                         # Shared project documentation
│   ├── api-contract.md           # MQTT topics, payload schemas, QoS
│   └── wiring-diagrams/
│       └── pinouts.md            # Hardware wiring tables
│
├── command-center/               # NODE 1: Assigned to Arjun
│   ├── web-dashboard/            # Next.js Application (React + TypeScript)
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── app/              # Next.js App Router pages
│   │   │   ├── components/       # CameraFeed, DoorLock, AccessLog cards
│   │   │   └── lib/              # Supabase & MQTT.js client connectors
│   │   ├── package.json
│   │   └── .env.local            # Environment configuration
│   │
│   └── ai-processor/             # Python OpenCV Detection Service
│       ├── main.py               # MJPEG stream consumer & MQTT publisher
│       ├── requirements.txt      # Python dependencies
│       └── .env                  # AI processor environment settings
│
├── vision-node/                  # NODE 2: Assigned to Teammate B
│   ├── README.md                 # Instructions for Teammate B
│   ├── .gitignore                # Ignores compiled binaries
│   └── (VisionNode/ sketch folder to be placed here)
│
└── access-node/                  # NODE 3: Assigned to Teammate A
    ├── README.md                 # Instructions for Teammate A
    ├── .gitignore                # Ignores compiled binaries
    └── (AccessNode/ sketch folder to be placed here)
```

---

## 📡 MQTT API Contract Summary

All nodes must strictly adhere to the MQTT topic strings and formats:

| MQTT Topic | Publisher | Subscriber | Payload | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `security/door/command` | Dashboard | Access Node | `"OPEN"` or `"CLOSE"` | Remote unlock trigger |
| `security/door/status` | Access Node | Dashboard | `"LOCKED"` or `"UNLOCKED"` | Current physical lock state |
| `security/door/access_log` | Access Node | Dashboard | `{"method":"RFID"\|"PIN", "status":"GRANTED"\|"DENIED"}` | Entry event logging |
| `security/camera/discovery` | Vision Node | Dashboard, AI | `{"ip":"192.168.1.X", "port":80}` | Dynamic IP announcement |
| `security/camera/status` | Vision Node | Dashboard, AI | `"ONLINE"` or `"OFFLINE"` | Camera availability (LWT) |
| `security/alerts/person` | AI Processor | Dashboard | `{"timestamp":"...", "confidence":0.85}` | Security alert trigger |

For full specification and schemas, refer to [docs/api-contract.md](docs/api-contract.md).
