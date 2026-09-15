# 🛡️ SecureHome: Modular ESP32 Smart Security System

[![ESP32](https://img.shields.io/badge/Hardware-ESP32%20%7C%20ESP32--CAM-red.svg)](https://www.espressif.com/)
[![Next.js](https://img.shields.io/badge/Dashboard-Next.js%2014-black.svg)](https://nextjs.org/)
[![Python](https://img.shields.io/badge/AI-Python%203.10%2B%20%7C%20OpenCV-blue.svg)](https://opencv.org/)
[![MQTT](https://img.shields.io/badge/Broker-Mosquitto%20MQTT-orange.svg)](https://mosquitto.org/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript%20%7C%20C%2B%2B-blueviolet.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A modular, privacy-first smart home security platform built with budget-friendly ESP32 microcontrollers, event-driven MQTT telemetry, computer vision AI person detection, and a real-time Next.js Command Center dashboard. Designed from the ground up to operate reliably on a local network without reliance on proprietary cloud subscriptions.

---

## 📑 Table of Contents

- [🏛️ System Architecture](#️-system-architecture)
- [✨ Core Capabilities](#-core-capabilities)
- [📂 Repository Organization](#-repository-organization)
- [📦 Hardware Procurement List (BOM)](#-hardware-procurement-list-bom)
- [🔌 Hardware Wiring & Pinout Maps](#-hardware-wiring--pinout-maps)
- [🚀 Quick Start & Running Guide](#-quick-start--running-guide)
  - [1. Mosquitto MQTT Broker Setup](#1-mosquitto-mqtt-broker-setup)
  - [2. Next.js Command Center Dashboard](#2-nextjs-command-center-dashboard)
  - [3. Python OpenCV AI Detection Service](#3-python-opencv-ai-detection-service)
  - [4. Vision Node Firmware (ESP32-CAM)](#4-vision-node-firmware-esp32-cam)
  - [5. Access Node Firmware (ESP32 Door Lock)](#5-access-node-firmware-esp32-door-lock)
- [📡 MQTT API Contract](#-mqtt-api-contract)
- [🧪 Independent Node Testing Protocols](#-independent-node-testing-protocols)
- [👥 Project Team & Attribution](#-project-team--attribution)

---

## 🏛️ System Architecture

SecureHome employs an event-driven publish/subscribe topology orchestrated by an **Eclipse Mosquitto MQTT** broker supporting both standard TCP (port `1883`) for embedded nodes and WebSockets (port `9001`) for the browser-based dashboard.

```
                                  +---------------------------------------+
                                  |         Central Server / PC           |
                                  |                                       |
                                  |   Mosquitto MQTT Broker               |
                                  |   - Port 1883: TCP (Nodes & AI)       |
                                  |   - Port 9001: WebSockets (Dashboard) |
                                  +-------------------+-------------------+
                                                      |
                  +-----------------------------------+-----------------------------------+
                  |                                   |                                   |
                  v                                   v                                   v
        +-------------------+               +-------------------+               +-------------------+
        |  Command Center   |               |    Vision Node    |               |    Access Node    |
        |                   |               |                   |               |                   |
        | - Next.js 14 App  |               | - AI-Thinker      |               | - ESP32 30-Pin    |
        |   (Web Dashboard) |               |   ESP32-CAM       |               |   Dev Board       |
        | - Python OpenCV   | <=== MJPEG == | - MJPEG Stream    |               | - RC522 RFID(SPI) |
        |   AI Service      |     Stream    |   (Port 81)       |               | - 4x3 Keypad      |
        |   (Person Alert)  |   (HTTP :81)  | - WiFiManager     |               | - MG90S Servo     |
        |                   |               | - NVS Flash       |               | - Zero-Lockout    |
        +-------------------+               +-------------------+               +-------------------+
                  |                                   |                                   |
     Subscribes: Telemetry/Logs/Alerts       Publishes: IP Discovery            Subscribes: Lock Commands
     Publishes: Door Commands                Publishes: LWT Status              Publishes: State & Audit Logs
```

---

## ✨ Core Capabilities

- **Dual-Factor Physical Access Control:** Door entry supports both 13.56MHz RFID cards/fobs (MFRC522 via SPI) and manual PIN entry (4x3 matrix membrane keypad).
- **Autonomous Zero-Lockout Architecture:** The Access Node runs authentication and deadbolt actuation in a non-blocking loop. If Wi-Fi, the router, or the central broker goes offline, valid RFID tags and PINs continue to unlock the door locally.
- **Auto-Relock Mechanism:** Access grant sweeps the metal-gear MG90S servo to 90°, holds for 5 seconds, and automatically sweeps back to 0° (locked).
- **Live HTTP Video Streaming:** The AI-Thinker ESP32-CAM broadcasts an MJPEG video stream over HTTP port `81` (`/stream`) with an embedded web previewer.
- **Intelligent Edge AI Person Detection:** Background Python OpenCV service consumes the camera's MJPEG stream, runs person detection algorithms, and fires instant MQTT alerts (`security/alerts/person`) with bounding box coordinates and confidence scores.
- **SoftAP Captive Portal Provisioning:** Nodes broadcast captive portals (`ESP32-Security-Setup` and `ESP32-DoorLock-Setup`) on first boot. Users select their home Wi-Fi SSID and set the Command Center's MQTT Broker IP without modifying code.
- **Persistent Non-Volatile Storage (NVS):** Configuration settings are committed to flash memory via the ESP32 `Preferences` library, persisting across power losses and reboots.
- **Dynamic Discovery & LWT Health Monitoring:** The camera broadcasts its dynamic IP upon connection (`security/camera/discovery`). Both nodes leverage MQTT Last Will and Testament (LWT) for instantaneous offline status alerts.

---

## 📂 Repository Organization

```
modular-home-security/
├── README.md                                 # Master repository documentation (You are here)
├── package.json                              # Workspace config & dashboard scripts
├── package-lock.json
│
└── securehome-system/
    ├── docs/                                 # Centralized technical documentation
    │   ├── api-contract.md                   # MQTT topic specifications & JSON schemas
    │   └── wiring-diagrams/
    │       └── pinouts.md                    # Pinout allocations & power bus schematics
    │
    ├── command-center/                       # Command Center node
    │   ├── mosquitto.conf                    # Dual-listener Mosquitto MQTT broker config
    │   ├── web-dashboard/                    # Next.js 14 Web Application
    │   │   ├── src/
    │   │   │   ├── app/                      # Next.js App Router (globals.css, layout, page)
    │   │   │   ├── components/               # CameraFeed, DoorLock, AccessLog, AlertBanner
    │   │   │   └── lib/                      # Supabase & MQTT.js client connectors
    │   │   ├── package.json
    │   │   └── .env.local                    # Dashboard environment variables
    │   │
    │   └── ai-processor/                     # Python OpenCV AI Person Detection Service
    │       ├── main.py                       # MJPEG stream consumer & MQTT publisher
    │       ├── requirements.txt              # Python dependencies (opencv-python, paho-mqtt)
    │       └── .env                          # Broker IP & camera stream URL configuration
    │
    ├── vision-node/                          # Vision Node (ESP32-CAM)
    │   ├── README.md                         # Camera flashing & configuration manual
    │   ├── .gitignore
    │   └── VisionNode/
    │       └── VisionNode.ino                # ESP32-CAM sketch (WiFiManager, MJPEG, MQTT, NVS)
    │
    └── access-node/                          # Access Node (ESP32 Door Lock)
        ├── README.md                         # Access node setup & pinout manual
        ├── .gitignore
        └── AccessNode/
            └── AccessNode.ino                # Access sketch (RFID, Keypad, Servo, WiFiManager)
```

---

## 📦 Hardware Procurement List (BOM)

| Component | Qty | Role | Technical Specification |
| :--- | :---: | :--- | :--- |
| **AI-Thinker ESP32-CAM** | 1 | Video Streaming Node | Includes OV2640 camera sensor & on-board PSRAM |
| **ESP32-CAM-MB Shield** | 1 | Programming & Power | Micro-USB flashing interface with CH340 / CP2102 |
| **ESP32 Dev Board** | 1 | Access Control Node | Standard 30-pin ESP-WROOM-32 |
| **RC522 RFID Module** | 1 | Contactless Authentication | 13.56MHz SPI reader + 1 Mifare Card + 1 Key Fob (**3.3V Logic**) |
| **4x3 / 4x4 Matrix Keypad** | 1 | Manual PIN Entry | 12 or 16 tactile membrane keys |
| **MG90S Micro Servo** | 1 | Physical Deadbolt Actuator | Metal-gear servo motor (5V, 50Hz PWM) |
| **5V / 2A Power Adapters** | 2 | Node Power Supplies | Dedicated wall adapters (prevents Wi-Fi brownouts) |
| **Electrolytic Capacitors** | 2 | Voltage Spike Decoupling | **100µF to 470µF (16V+)** soldered across 5V and GND |
| **Jumper Wires & Breadboards** | 1 set | Prototyping Interconnects | Female-to-Female, Male-to-Female, and Male-to-Male jumpers |

---

## 🔌 Hardware Wiring & Pinout Maps

For complete pin assignments, electrical cautions, and bus schematics, refer to [docs/wiring-diagrams/pinouts.md](securehome-system/docs/wiring-diagrams/pinouts.md).

### 1. Vision Node (ESP32-CAM)

> [!CAUTION]
> During Wi-Fi transmission bursts, the ESP32-CAM draws up to 310mA. Solder a **100µF to 470µF electrolytic capacitor** directly across `5V` and `GND` (negative stripe to GND) to prevent brownout reset loops.

- **Power:** `5V` and `GND` from a dedicated 5V/2A adapter.
- **Camera Sensor:** OV2640 ribbon mapped internally (reserves GPIOs 0, 2, 4, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32–36, 39).
- **Flashing:** Handled directly via the `ESP32-CAM-MB` shield.

### 2. Access Node (ESP32 30-Pin)

Pin assignments have been deliberately mapped to avoid ESP32 strapping pins (`GPIO 0, 2, 12, 15`) and input-only pins (`GPIO 34-39`):

| Peripheral | Peripheral Pin | ESP32 GPIO | Purpose / Function |
| :--- | :--- | :--- | :--- |
| **RC522 RFID** | VCC | **3V3** | ⚠️ **3.3V Only!** Connecting to 5V will destroy the IC |
| | RST | **GPIO 22** | Module Reset line |
| | GND | **GND** | System common ground |
| | MISO / MOSI / SCK | **GPIO 19 / 23 / 18** | VSPI Hardware SPI bus |
| | SDA (SS) | **GPIO 21** | Chip Select (avoiding strapping pin GPIO 5) |
| **Keypad (4x3)** | Rows 1, 2, 3, 4 | **GPIO 13, 14, 27, 26** | Matrix rows (input with pull-ups) |
| | Cols 1, 2, 3 | **GPIO 25, 33, 32** | Matrix columns (driven LOW) |
| **MG90S Servo** | PWM Signal | **GPIO 16** | 50Hz PWM output (500µs - 2400µs) |
| | VCC / GND | **VIN (5V) / GND** | External 5V power with shared ground |

---

## 🚀 Quick Start & Running Guide

### Prerequisites

- **Host Machine:** Linux / macOS / Windows with a static local IP on your home router.
- **Node.js:** v18.0.0 or higher.
- **Python:** v3.10 or higher.
- **Mosquitto MQTT:** Eclipse Mosquitto broker installed.
- **Arduino IDE:** v2.0+ with `esp32` board definitions (by Espressif) installed.

---

### 1. Mosquitto MQTT Broker Setup

The system includes a pre-configured configuration enabling both TCP (Port 1883) and WebSockets (Port 9001):

```bash
# Launch Mosquitto using the project configuration
mosquitto -c securehome-system/command-center/mosquitto.conf -v
```

Ensure your host firewall allows inbound connections on ports `1883` and `9001`.

---

### 2. Next.js Command Center Dashboard

The web dashboard provides real-time video streaming, live door status, remote unlock triggers, and event logging:

```bash
# From the repository root
npm install
npm run dev

# The dashboard is now accessible at:
# http://localhost:3000
```

Configure local environment variables if necessary in `securehome-system/command-center/web-dashboard/.env.local`:
```env
NEXT_PUBLIC_MQTT_URL=ws://localhost:9001
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
```

---

### 3. Python OpenCV AI Detection Service

The AI processor fetches the live stream from the Vision Node and publishes alerts when humans are detected:

```bash
# Navigate to the ai-processor directory
cd securehome-system/command-center/ai-processor

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate    # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the detection service
python main.py
```

Configure stream and broker settings in `securehome-system/command-center/ai-processor/.env`:
```env
MQTT_BROKER=localhost
MQTT_PORT=1883
CAMERA_STREAM_URL=http://192.168.1.145:81/stream
CONFIDENCE_THRESHOLD=0.70
```

---

### 4. Vision Node Firmware (ESP32-CAM)

1. Open [`securehome-system/vision-node/VisionNode/VisionNode.ino`](securehome-system/vision-node/VisionNode/VisionNode.ino) in Arduino IDE.
2. Under **Tools > Board**, choose `AI Thinker ESP32-CAM`.
3. Under **Tools > PSRAM**, select **Enabled** *(critical for frame buffering)*.
4. Mount the board onto the `ESP32-CAM-MB` shield and click **Upload**.
5. **Provisioning:**
   - On first boot, connect your smartphone to the open AP: **`ESP32-Security-Setup`**.
   - Select your home Wi-Fi and input your Command Center's static MQTT Broker IP.
   - The device reboots, stores the settings in NVS, connects to Wi-Fi, starts the MJPEG server on port `81`, and publishes its IP to `security/camera/discovery`.

For more details, see [securehome-system/vision-node/README.md](securehome-system/vision-node/README.md).

---

### 5. Access Node Firmware (ESP32 Door Lock)

1. In Arduino IDE, install required libraries via **Library Manager** (`Ctrl+Shift+I`):
   - `WiFiManager` (by tzapu)
   - `PubSubClient` (by Nick O'Leary)
   - `MFRC522` (by GithubCommunity)
   - `Keypad` (by Mark Stanley, Alexander Brevig)
   - `ESP32Servo` (by Kevin Harrington, John K. Bennett)
   - `ArduinoJson` (by Benoît Blanchon)
2. Open [`securehome-system/access-node/AccessNode/AccessNode.ino`](securehome-system/access-node/AccessNode/AccessNode.ino).
3. Select board **ESP32 Dev Module** and upload.
4. **Provisioning:**
   - Connect to the AP: **`ESP32-DoorLock-Setup`**.
   - Input your Wi-Fi credentials and the MQTT Broker IP.
   - Click Save; the ESP32 stores credentials in NVS, engages the servo, and subscribes to door commands.

For more details, see [securehome-system/access-node/README.md](securehome-system/access-node/README.md).

---

## 📡 MQTT API Contract

All modules strictly adhere to the unified MQTT API contract. For full JSON schemas, refer to [docs/api-contract.md](securehome-system/docs/api-contract.md).

| Topic | Publisher | Subscriber | QoS | Retain | Payload Format | Description |
| :--- | :--- | :--- | :---: | :---: | :--- | :--- |
| `security/door/command` | Dashboard | Access Node | 1 | No | `"OPEN"` \| `"CLOSE"` | Remote lock actuation trigger |
| `security/door/status` | Access Node | Dashboard | 1 | **Yes** | `"LOCKED"` \| `"UNLOCKED"` | Current physical state of deadbolt |
| `security/door/access_log` | Access Node | Dashboard | 1 | No | `{"method":"RFID"\|"PIN"\|"REMOTE", "status":"GRANTED"\|"DENIED", "identifier":"..."}` | Real-time entry audit event |
| `security/camera/discovery` | Vision Node | Dashboard, AI | 1 | **Yes** | `{"node_id":"cam_front_door", "ip":"192.168.1.X", "port":81, "stream_path":"/stream"}` | Dynamic IP announcement on boot |
| `security/camera/status` | Vision Node | Dashboard, AI | 1 | **Yes** | `"ONLINE"` \| `"OFFLINE"` | Availability status (LWT) |
| `security/alerts/person` | AI Processor | Dashboard | 0 | No | `{"camera":"cam_front_door", "confidence":0.92, "timestamp":"...", "bbox":[x, y, w, h]}` | Real-time person detection alert |

---

## 🧪 Independent Node Testing Protocols

Each node can be validated independently using **[MQTT Explorer](https://mqtt-explorer.com/)** without needing all physical hardware operational simultaneously:

### Test Command Center Dashboard
1. Launch the Next.js app (`npm run dev`).
2. In MQTT Explorer, publish `{"ip":"192.168.1.100","port":81,"stream_path":"/stream"}` to `security/camera/discovery`. Verify the dashboard attaches to the feed.
3. Publish `"LOCKED"` to `security/door/status`. Verify the UI reflects the locked state.
4. Click **Unlock** on the web dashboard. Verify that `"OPEN"` is published to `security/door/command`.

### Test Vision Node
1. Flash `VisionNode.ino` and complete SoftAP configuration.
2. Monitor `security/camera/discovery` in MQTT Explorer; verify the node publishes its assigned IP.
3. Open `http://<ESP32-CAM-IP>:81/` in your browser to confirm the live MJPEG stream is transmitting.

### Test Access Node
1. Flash `AccessNode.ino` and provision Wi-Fi.
2. Scan an authorized RFID tag or type a valid PIN (`1234#`).
3. Verify the servo sweeps to 90°, holds for 5 seconds, and returns to 0°.
4. Check MQTT Explorer for `"UNLOCKED"` on `security/door/status` and the audit event payload on `security/door/access_log`.
5. Test remote control: In MQTT Explorer, publish `"OPEN"` to `security/door/command`. The physical servo must actuate.

---

## 👥 Project Team & Attribution

**Team SuperUser Programmers**  
*Amrita Vishwa Vidyapeetham (AVV)*

- **Arjun Sanesh** — Project Lead & Full-Stack Engineer (Command Center Web Dashboard, AI Processor, Mosquitto Architecture)
- **Athira** — Embedded Hardware Engineer (Access Node Firmware, RFID/Keypad SPI & Matrix Integration, Servo PWM)
- **Teammate B** — Network & Systems Engineer (Vision Node ESP32-CAM Firmware, MJPEG Streaming, SoftAP Provisioning)

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
