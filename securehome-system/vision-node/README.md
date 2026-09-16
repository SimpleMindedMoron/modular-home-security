# 📷 Node 2: Vision Node (ESP32-CAM)

**Assigned to:** Teammate B (Network / Embedded)  
**Status:** ✅ **Implemented** (`VisionNode/VisionNode.ino`)

---

## 📂 Project Structure

```
securehome-system/vision-node/
├── VisionNode/
│   └── VisionNode.ino        # Main ESP32-CAM firmware (WiFiManager, MJPEG, MQTT, NVS)
├── README.md                 # Node documentation & flashing guide
└── .gitignore                # Build artifacts & temp files
```

> [!NOTE]
> In the Arduino IDE, the primary `.ino` file must reside inside a directory with the exact same name (`VisionNode/VisionNode.ino`).

---

## 📋 Responsibilities & Hardware Specs

- **Microcontroller:** AI-Thinker ESP32-CAM (with OV2640 sensor module and on-board PSRAM).
- **Flashing Shield:** `ESP32-CAM-MB` Micro-USB programmer shield.
- **Power Supply:** Dedicated 5V / 2A DC wall adapter.
- **Power Stabilization:** **100µF to 470µF electrolytic capacitor** connected directly across `5V` and `GND` (negative stripe to GND) to absorb Wi-Fi transmission current spikes and prevent brownout reboots.
- **Wiring & Pinout Reference:** See [docs/wiring-diagrams/pinouts.md](../docs/wiring-diagrams/pinouts.md).

---

## 🧰 Required Arduino IDE Libraries

Install the following libraries via **Arduino IDE Library Manager** (`Ctrl+Shift+I` / `Cmd+Shift+I`):

1. **WiFiManager** (by tzapu) — Handles SoftAP captive portal provisioning.
2. **PubSubClient** (by Nick O'Leary) — Lightweight MQTT client.
3. **esp32-camera** (by Espressif) — Included with the official ESP32 Arduino Board Package (`v2.0.x` or `v3.x`).

---

## ⚙️ Arduino IDE Board Configuration

When flashing the AI-Thinker ESP32-CAM, select:
- **Board:** `AI Thinker ESP32-CAM`
- **CPU Frequency:** `240MHz (WiFi/BT)`
- **Flash Frequency:** `80MHz`
- **Flash Mode:** `QIO`
- **Partition Scheme:** `Huge APP (3MB No OTA/1MB SPIFFS)` or `Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)`
- **PSRAM:** `Enabled` ⚠️ *(Critical for VGA 640x480 streaming buffers)*
- **Upload Speed:** `115200` (or `460800` for faster flashing)

> [!IMPORTANT]
> If using an FTDI programmer instead of the `ESP32-CAM-MB` shield, bridge `GPIO 0` to `GND` before powering on to enter flashing mode. Disconnect `GPIO 0` from `GND` and press `RST` to run the sketch after upload.

---

## 🚀 Provisioning & First-Time Setup Workflow

1. **First Boot (SoftAP Captive Portal):**
   - Power on the ESP32-CAM.
   - If no Wi-Fi credentials are saved, it broadcasts a Wi-Fi Access Point: **`ESP32-Security-Setup`** (no password).
   - Connect your phone or laptop to this network. A captive portal page opens automatically.
   - Select your **Home Wi-Fi Network (SSID)** and enter the **Password**.
   - Enter your **HiveMQ Cloud Host** (e.g. `xxxx.s1.eu.hivemq.cloud`), **MQTT Username**, and **MQTT Password**.
   - Enter your **Account Claim Token** (copied from your Web Dashboard user profile menu) and **Device UID** (e.g. `ESP32_CAM_01`).
   - Click **Save**. The ESP32 will reboot and connect to your home Wi-Fi and HiveMQ Cloud over TLS (port `8883`).

2. **Persistent Storage (NVS via `Preferences`):**
   - The HiveMQ Cloud broker host, credentials, claim token, and device UID are saved in non-volatile flash memory under the `"camera"` namespace.
   - On subsequent power cycles or reboots, the ESP32-CAM automatically reconnects to Wi-Fi and connects directly to HiveMQ Cloud without opening the portal.

---

## 📡 Networking, Streaming & MQTT Endpoints

### 1. HTTP Video Endpoints
| Endpoint | Port | Protocol | Description |
| :--- | :--- | :--- | :--- |
| `http://<ESP32-IP>:81/stream` | `81` | MJPEG | Multipart video stream consumed by OpenCV AI Processor and Next.js Web Dashboard. |
| `http://<ESP32-IP>:81/` | `81` | HTML | Built-in test preview page with embedded stream viewer. |

### 2. MQTT Telemetry Topics (Compliant with [docs/api-contract.md](../docs/api-contract.md))
| Topic | Payload Format | Retain | Description |
| :--- | :--- | :--- | :--- |
| `users/<claim_token>/cameras/<device_uid>/discovery`<br/>*(fallback: `security/camera/discovery`)* | `{"node_id":"...","ip":"192.168.1.X","port":81,"stream_path":"/stream"}` | `true` | Dynamic IP and port announcement broadcast upon Wi-Fi + MQTT connection. |
| `users/<claim_token>/cameras/<device_uid>/status`<br/>*(fallback: `security/camera/status`)* | `"ONLINE"` or `"OFFLINE"` | `true` | Availability state. Configured with MQTT Last Will and Testament (LWT) for automatic `"OFFLINE"` detection on abrupt disconnection. |
| `users/<claim_token>/cameras/<device_uid>/relay_url`<br/>*(fallback: `security/camera/relay_url`)* | `{"url":"https://...ngrok-free.app/stream"}` | `true` | Public HTTPS relay stream broadcast by the AI Processor service. |

---

## 🔄 Reconnecting & Fault Tolerance

- **Wi-Fi Disconnection:** Automatically triggers non-blocking reconnection attempts every 5 seconds without freezing system loop execution.
- **MQTT Broker Downtime:** If the central Command Center laptop/broker restarts, the Vision Node retries connecting every 5 seconds in the background while keeping the local MJPEG stream active.
