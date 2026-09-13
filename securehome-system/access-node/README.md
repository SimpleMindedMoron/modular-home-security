# 🚪 Node 3: Access Node / Door Lock (ESP32 Dev Board)

**Assigned to:** Athira (Hardware / Embedded)  
**Status:** ✅ **Implemented** (`AccessNode/AccessNode.ino`)

---

## 📂 Project Structure

```
securehome-system/access-node/
├── AccessNode/
│   └── AccessNode.ino        # Main ESP32 sketch (RFID, Keypad, Servo, WiFiManager, MQTT)
├── README.md                 # Setup, pinout notes & flashing guide
└── .gitignore                # Build artifacts
```

> [!NOTE]
> In Arduino IDE, the primary `.ino` file must reside inside a directory with the exact same name (`AccessNode/AccessNode.ino`).

---

## 📋 Responsibilities & Hardware Specs

- **Microcontroller:** ESP32 30-Pin Dev Board (`ESP-WROOM-32`).
- **Peripherals:**
  1. **RC522 RFID Module (SPI):** 3.3V logic (never connect VCC to 5V).
  2. **Matrix Membrane Keypad:** 4x3 configuration (Rows: GPIO 13, 14, 27, 26 | Columns: GPIO 25, 33, 32).
  3. **MG90S Micro Servo:** Driven via 50Hz PWM on GPIO 16 (powered via external 5V rail / VIN with shared ground).
- **Wiring & Power Reference:** See [docs/wiring-diagrams/pinouts.md](../../docs/wiring-diagrams/pinouts.md).

---

## 🧰 Required Arduino IDE Libraries

Install the following libraries via the **Arduino IDE Library Manager** (`Ctrl+Shift+I` / `Cmd+Shift+I`):

1. **WiFiManager** (by tzapu)
2. **PubSubClient** (by Nick O'Leary)
3. **MFRC522** (by GithubCommunity)
4. **Keypad** (by Mark Stanley, Alexander Brevig)
5. **ESP32Servo** (by Kevin Harrington, John K. Bennett)
6. **ArduinoJson** (by Benoît Blanchon) — v6 or v7 cross-compatible

---

## 📌 Pinout Map (Strapping-Safe)

| Peripheral | Pin | ESP32 GPIO | Purpose | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **RC522 RFID** | VCC | **3V3** | 3.3V Power | ⚠️ Do NOT connect to 5V |
| | RST | **GPIO 22** | Reset | |
| | GND | **GND** | Ground | Common system ground |
| | MISO | **GPIO 19** | SPI MISO | VSPI hardware SPI |
| | MOSI | **GPIO 23** | SPI MOSI | VSPI hardware SPI |
| | SCK | **GPIO 18** | SPI Clock | VSPI hardware SPI |
| | SDA (SS) | **GPIO 21** | Chip Select | Chosen to avoid GPIO 5 strapping pin boot issues |
| **Keypad (4x3)** | Row 1 | **GPIO 13** | Matrix Row 1 | Keys: 1, 2, 3 |
| | Row 2 | **GPIO 14** | Matrix Row 2 | Keys: 4, 5, 6 |
| | Row 3 | **GPIO 27** | Matrix Row 3 | Keys: 7, 8, 9 |
| | Row 4 | **GPIO 26** | Matrix Row 4 | Keys: *, 0, # |
| | Col 1 | **GPIO 25** | Matrix Col 1 | |
| | Col 2 | **GPIO 33** | Matrix Col 2 | |
| | Col 3 | **GPIO 32** | Matrix Col 3 | |
| **MG90S Servo** | Signal | **GPIO 16** | PWM Signal | 50Hz PWM (500µs - 2400µs) |
| | VCC | **5V / VIN** | 5V Power | Shared ground with ESP32 |

---

## 🚀 First-Time Provisioning Workflow

1. Power on the ESP32 Access Node.
2. If Wi-Fi is unconfigured, it broadcasts an open network: **`ESP32-DoorLock-Setup`**.
3. Connect your phone or laptop to the AP and open the captive portal.
4. Select your **Home Wi-Fi SSID**, enter the **Password**, and specify your **MQTT Broker IP** (and optional username/password if authentication is enabled).
5. Click **Save**. The ESP32 will store credentials in NVS (surviving power cycles) and auto-connect.

---

## 🛡️ Autonomous Safety Architecture

- **Zero-Lockout Guarantee:** The sketch runs authentication (`checkRFID()`, `checkKeypad()`, and servo auto-relock) completely **non-blocking**. If the Wi-Fi router, central server, or MQTT broker goes offline, the physical door lock continues to operate normally with authorized cards and PINs.
- **Auto-Relock:** Unlocking via RFID, PIN, or remote dashboard command triggers an automatic 5-second pulse, returning the deadbolt to the locked position (`0°`).

---

## 📡 MQTT API Contract Adherence

| Topic | Direction | Payload | Retain | Description |
| :--- | :--- | :--- | :--- | :--- |
| `security/door/command` | Subscribe | `"OPEN"` or `"CLOSE"` | No | Remote commands from Command Center dashboard. |
| `security/door/status` | Publish | `"LOCKED"` or `"UNLOCKED"` | **Yes** | Current deadbolt state (retained so dashboard immediately reflects state on load). |
| `security/door/access_log` | Publish | `{"method":"RFID"\|"PIN"\|"REMOTE", "status":"GRANTED"\|"DENIED", "identifier":"..."}` | No | Real-time audit log streamed to Web Dashboard. |
