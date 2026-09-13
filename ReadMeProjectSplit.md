# 🛡️ SecureHome System: Team Workload & Testing Specification

**Project:** Budget ESP32 Smart Security
**Team:** SuperUser Programmers | Amrita Vishwa Vidyapeetham (AVV)
**Target:** Advanced College Project / IoT Implementation

This document outlines the division of labor across the three primary system nodes. Each node is designed to be developed, compiled, and tested completely independently using the agreed-upon MQTT API Contract.

---

## 🏗️ PART 1: The Workload Split

### Node 1: Command Center (Dashboard & AI)
*Assigned to: Arjun (Lead / Full-Stack)*
* **Hardware:** Laptop / PC running local server.
* **Responsibilities:**
  1. **Broker:** Host the Mosquitto MQTT Broker (ensure WebSockets are enabled on Port 9001).
  2. **Auth & Database:** Configure Supabase for Google (Gmail) OAuth and set up the `devices` SQL table.
  3. **Frontend Dashboard:** Build a Next.js application that authenticates users, connects to the local Mosquitto broker via MQTT.js, and dynamically renders the camera feed and door controls.
  4. **AI Processor:** Write a Python OpenCV script to fetch the camera's HTTP MJPEG stream, run a lightweight person-detection model, and publish alerts to MQTT.

### Node 2: Vision Node (Camera & Network)
*Assigned to: Teammate B (Network/Embedded)*
* **Hardware:** ESP32-CAM, MB Shield, 5V/2A Power, Capacitor (100µF+).
* **Responsibilities:**
  1. **Power Stability:** Solder the capacitor across 5V/GND to prevent Wi-Fi transmit crashes.
  2. **Provisioning:** Implement `WiFiManager` to broadcast a SoftAP captive portal. Add a custom input field to capture and save the Command Center's MQTT Broker IP address.
  3. **Video Server:** Initialize the camera sensor and start a local HTTP server broadcasting an MJPEG stream.
  4. **Telemetry:** Publish the node's assigned IP address to the MQTT broker on boot, and configure a "Last Will and Testament" (LWT) so the broker knows if the camera goes offline.

### Node 3: Access Node (Door Lock)
*Assigned to: Athira (Hardware/Embedded)*
* **Hardware:** ESP32 Dev Board, RC522 RFID (SPI), 4x3 Matrix Keypad, MG90S Servo.
* **Responsibilities:**
  1. **Hardware Assembly:** Wire the SPI interface, keypad matrix, and PWM servo without triggering ESP32 strapping pin boot loops.
  2. **Local Auth:** Write C++ logic to validate scanned NFC cards or 4-digit keypad PINs locally.
  3. **Actuation:** Write the PWM logic to sweep the servo motor to "Unlock" (wait 5 seconds) and return to "Lock".
  4. **MQTT Bridge:** Subscribe to remote unlock commands from the dashboard and publish access logs (Granted/Denied) back to the server.

---

## 📡 PART 2: The MQTT API Contract

To work independently, all nodes must strictly adhere to these topic strings. 

| Node | Action | MQTT Topic | Expected Payload Structure |
| :--- | :--- | :--- | :--- |
| **Door** | Subscribes | `security/door/command` | `"OPEN"` or `"CLOSE"` |
| **Door** | Publishes | `security/door/status` | `"LOCKED"` or `"UNLOCKED"` |
| **Door** | Publishes | `security/door/access_log` | `{"method": "RFID", "status": "GRANTED"}` |
| **Camera** | Publishes | `security/camera/discovery` | `{"ip": "192.168.1.X", "port": 80}` |
| **Camera** | Publishes | `security/camera/status` | `"ONLINE"` or `"OFFLINE"` (LWT) |
| **AI Node**| Publishes | `security/alerts/person` | `{"timestamp": "12:00", "camera": "cam_1"}` |

---

## 🧪 PART 3: Independent Testing Protocols

*Prerequisite: Everyone must download **MQTT Explorer** (free desktop app) to monitor and inject messages into the Mosquitto broker.*

### Testing Node 1 (Command Center) without hardware:
1. Start your Next.js dashboard.
2. Open MQTT Explorer, connect to your local broker, and manually publish `{"ip": "http://some-test-video-url.com"}` to `security/camera/discovery`. Verify the dashboard renders the camera.
3. Manually publish `"LOCKED"` to `security/door/status`. Verify the UI updates.
4. Click "Unlock" on your UI. Check MQTT Explorer to ensure the dashboard successfully published `"OPEN"` to `security/door/command`.

### Testing Node 2 (Vision Node) without the dashboard:
1. Flash the ESP32-CAM and complete the SoftAP Wi-Fi setup on your phone.
2. Open MQTT Explorer on the same network. 
3. Reset the ESP32-CAM. You should immediately see a message appear on `security/camera/discovery` containing the ESP32's IP address.
4. Copy that IP address and paste it into a web browser (e.g., `http://192.168.1.X`). You should see the live video stream.

### Testing Node 3 (Access Node) without the dashboard:
1. Flash the ESP32 and scan a valid NFC tag or enter a valid PIN. The servo should move, and you should see `"UNLOCKED"` appear in MQTT Explorer under `security/door/status`.
2. To test remote access: Use MQTT Explorer to manually publish `"OPEN"` to the topic `security/door/command`. The physical ESP32 should receive this fake dashboard command and trigger the servo.
