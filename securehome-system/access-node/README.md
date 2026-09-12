# 🚪 Node 3: Access Node (ESP32 Dev Board)

**Assigned to:** Teammate A (Hardware / Embedded)

---

## 📂 Where to Add Your Code
Place your Arduino sketch folder in this directory:
```
securehome-system/access-node/
├── AccessNode/
│   ├── AccessNode.ino        <-- Put your main Arduino sketch here
│   └── (any header files)
├── README.md
└── .gitignore
```
> [!NOTE]
> In Arduino IDE, the primary `.ino` file must reside inside a folder with the **exact same name** (e.g., `AccessNode/AccessNode.ino`).

---

## 📋 Responsibilities & Hardware
- **Hardware:** ESP32 30-Pin Dev Board, RC522 RFID Module (SPI), 4x4 Membrane Keypad, MG90S Micro Servo.
- **Wiring Reference:** See [docs/wiring-diagrams/pinouts.md](../../docs/wiring-diagrams/pinouts.md).
- **Core Tasks:**
  1. Initialize SPI bus for RC522 RFID card reading (3.3V logic).
  2. Read 4x4 matrix keypad input without using strapping pins.
  3. Control MG90S servo motor to actuate the door deadbolt (sweep to unlock, hold 5s, relock).
  4. Connect to local Wi-Fi and the central Mosquitto MQTT broker.
  5. Subscribe to `security/door/command` (`"OPEN"` / `"CLOSE"`).
  6. Publish lock status to `security/door/status` and audit logs to `security/door/access_log`.

---

## 📡 API Contract
Ensure your MQTT payloads adhere strictly to [docs/api-contract.md](../../docs/api-contract.md):
- **Subscribe:** `security/door/command` -> `"OPEN"` or `"CLOSE"`
- **Publish:** `security/door/status` -> `"LOCKED"` or `"UNLOCKED"` (retained)
- **Publish:** `security/door/access_log` -> `{"method": "RFID"|"PIN", "status": "GRANTED"|"DENIED"}`
