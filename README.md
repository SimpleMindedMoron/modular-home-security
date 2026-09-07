# 🛡️ SecureHome: Budget ESP32 Smart Security

A modular, highly scalable home security system built entirely on budget ESP32 microcontrollers. This project provides dual-factor access control (NFC + PIN), live HTTP video streaming, and a centralized management dashboard without relying on expensive, proprietary cloud services.

---

## 📐 System Architecture & Design Decisions

To achieve a true "plug-and-play" experience where nodes can disconnect, change IPs, and reconnect seamlessly, we utilize an **MQTT-based publish/subscribe architecture**. 

*Note: While ROS2 (Micro-ROS) was considered for node management, it was ruled out due to the heavy RAM overhead it imposes on the ESP32-CAM, which causes instability when running alongside a video streaming web server. MQTT provides the necessary lightweight telemetry.*

### 1. The Central Server (Laptop / Local Network)
For the initial development phase, a local laptop acts as the central server. It hosts:
*   **Mosquitto MQTT Broker (Port 1883):** Handles all state changes, lock commands, and node discovery messages.
*   **Web Dashboard:** A local web interface to view camera feeds and send remote unlock commands.
*   *Critical Requirement:* The server laptop must be assigned a **Static IP** on the local router to ensure nodes always know where to send telemetry. OS Firewalls must be configured to allow inbound traffic on Port 1883.

### 2. Camera Node (ESP32-CAM)
Captures and streams live video to the dashboard over standard HTTP while publishing its online status and current IP to the MQTT broker.
*   **Hardware Caveat:** The ESP32-CAM is prone to severe voltage drops during Wi-Fi transmission spikes, leading to boot-looping. A 100µF or 470µF electrolytic capacitor must be soldered across the 5V and GND pins to stabilize power.

### 3. Access Control Node (ESP32 Dev Board)
Handles physical entry at the door. 
*   **Inputs:** RC522 RFID module (SPI) for NFC card/fob scanning, and a 4x4 Matrix Membrane Keypad for manual PIN entry.
*   **Outputs:** Drives an MG90S metal-gear servo motor to actuate the door lock mechanism.
*   **Logic:** Validates the PIN/UID locally or via MQTT, triggers the servo, and publishes an "Access Granted" or "Access Denied" log to the server.

---

## ✨ Core Features

*   **SoftAP "Plug-and-Play" Provisioning:** Devices do not have hardcoded Wi-Fi credentials. On first boot, nodes broadcast a captive portal (e.g., `ESP32-Security-Setup`). Users connect to this portal to select their home Wi-Fi and input the Server's MQTT Broker IP address.
*   **Persistent Memory:** Configuration data is written to the ESP32's non-volatile memory (SPIFFS/EEPROM), ensuring it survives power cycles.
*   **Auto-Discovery:** Upon connecting to the router, nodes automatically publish a greeting message to a designated MQTT topic (e.g., `home/cameras/discovery`), broadcasting their dynamically assigned IP address to the dashboard.
*   **Multi-Factor Access:** Door can be unlocked via local NFC tag, local PIN code, or remote dashboard command.

---

## 📦 Hardware Procurement List

| Component | Qty | Purpose |
| :--- | :--- | :--- |
| **ESP32-CAM bundle** | 1 | Includes OV2640 sensor and the essential `ESP32-CAM-MB` Micro-USB shield for easy flashing. |
| **ESP32 Dev Board** | 1 | Standard 30-pin ESP-WROOM-32 for access control. |
| **RC522 RFID Kit** | 1 | NFC Reader, includes 1 Card and 1 Key Fob. |
| **4x4 Matrix Keypad** | 1 | 16-key membrane pad for PIN entry. |
| **MG90S Servo** | 1 | Metal-gear servo for actuating the physical lock. |
| **5V / 2A Power Adapters** | 2 | Dedicated wall power (crucial for ESP32-CAM stability). |
| **Capacitors (100µF+)** | 2 | Electrolytic caps to smooth voltage spikes. |
| **Jumper Wires & Breadboards** | 1 set | Female-to-Female wires required for the RC522 header. |

---

## 🚀 Quick Start (Development Phase)

1.  **Configure the Server:**
    *   Install [Eclipse Mosquitto](https://mosquitto.org/) on your laptop.
    *   Set a Static IP for your laptop in your router's DHCP settings.
    *   Open Port `1883` in Windows Defender / macOS Firewall.
2.  **Flash the Nodes:**
    *   Upload the respective Arduino sketches to the Camera and Access nodes. 
    *   Ensure the `WiFiManager` library is configured to ask for a custom MQTT IP parameter.
3.  **Provision:**
    *   Power up the nodes. Connect to their SoftAP network via your smartphone.
    *   Enter your Wi-Fi credentials and the laptop's Static IP. 
    *   The nodes will reboot and connect to your local broker.

---

## 🗺️ Roadmap & Future Scope

- [ ] **Phase 1:** Implement SoftAP captive portal with custom Broker IP field.
- [ ] **Phase 2:** Establish basic MQTT publish/subscribe loops on both nodes.
- [ ] **Phase 3:** Wire RC522 (SPI) and 4x4 Keypad to the ESP32 without pin conflicts.
- [ ] **Phase 4:** Write logic to validate scanned Card UIDs or 4-digit PINs to trigger the Servo.
- [ ] **Phase 5:** Build the frontend dashboard to aggregate the HTTP video stream and MQTT logs.
- [ ] **Phase 6 (Advanced):** Implement server-side Person Detection. The laptop/server will run a Python/OpenCV script against the HTTP video stream to detect humans and push alert payloads back to the dashboard via MQTT.
