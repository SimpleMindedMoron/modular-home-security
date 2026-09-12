# 📷 Node 2: Vision Node (ESP32-CAM)

**Assigned to:** Teammate B (Network / Embedded)

---

## 📂 Where to Add Your Code
Place your ESP32-CAM sketch folder in this directory:
```
securehome-system/vision-node/
├── VisionNode/
│   ├── VisionNode.ino        <-- Put your main ESP32-CAM sketch here
│   ├── app_httpd.cpp         <-- HTTP MJPEG streaming handler (if separate)
│   └── (any header files)
├── README.md
└── .gitignore
```
> [!NOTE]
> In Arduino IDE, the primary `.ino` file must reside inside a folder with the **exact same name** (e.g., `VisionNode/VisionNode.ino`).

---

## 📋 Responsibilities & Hardware
- **Hardware:** AI-Thinker ESP32-CAM, `ESP32-CAM-MB` Micro-USB shield, 5V / 2A Power Adapter, 100µF+ Electrolytic Capacitor across 5V and GND.
- **Wiring & Power Reference:** See [docs/wiring-diagrams/pinouts.md](../../docs/wiring-diagrams/pinouts.md).
- **Core Tasks:**
  1. Initialize OV2640 camera sensor.
  2. Implement SoftAP captive portal using `WiFiManager` with a custom parameter to collect the central laptop's MQTT Broker IP.
  3. Start a local HTTP server streaming MJPEG video over port 81 (or 80) at `/stream`.
  4. Connect to the Mosquitto MQTT broker:
     - Configure **Last Will and Testament (LWT)** to publish `"OFFLINE"` to `security/camera/status`.
     - On connect, publish `"ONLINE"` to `security/camera/status`.
     - Publish dynamic IP and stream port to `security/camera/discovery` (`{"ip": "192.168.1.X", "port": 81, "stream_path": "/stream"}`).

---

## 📡 API Contract
Ensure your MQTT payloads adhere strictly to [docs/api-contract.md](../../docs/api-contract.md):
- **Publish:** `security/camera/status` -> `"ONLINE"` or `"OFFLINE"` (retained)
- **Publish:** `security/camera/discovery` -> `{"ip": "192.168.1.X", "port": 81, "stream_path": "/stream"}` (retained)
