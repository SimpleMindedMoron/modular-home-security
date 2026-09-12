# 🔌 Hardware Wiring Diagrams & Pinout Specifications

This guide provides the complete wiring pinout tables for the two microcontroller nodes in the SecureHome system.

---

## 📷 Node 2: Vision Node (ESP32-CAM AI-Thinker)

### Power Stabilization Setup
> [!CAUTION]
> The ESP32-CAM requires up to 310mA during Wi-Fi transmission bursts. Inadequate current causes sudden voltage drops below 2.7V, triggering a brownout reset boot-loop.
> - Connect a **100µF to 470µF electrolytic capacitor** directly across the `5V` and `GND` pins (observing correct polarity: negative stripe to GND).
> - Use a dedicated 5V / 2A wall adapter connected via the `ESP32-CAM-MB` shield.

### Pin Allocation Table
| ESP32-CAM Pin | Connected To | Purpose | Notes |
| :--- | :--- | :--- | :--- |
| **5V** | 5V / 2A Power + Cap (+) | Power input | Needs solid 5.0V regulated power |
| **GND** | Power GND + Cap (-) | Common Ground | Tie all grounds together |
| **U0TXD (GPIO 1)** | Serial RX / FTDI | Serial Debug | Serial monitoring at 115200 baud |
| **U0RXD (GPIO 3)** | Serial TX / FTDI | Serial Upload | Used during flashing |
| **GPIO 4** | Onboard Flash LED | High-power LED | Reserved / optional illuminator |
| **GPIO 0** | GND (during flash only) | Flash Mode Boot | Disconnect after flashing |

*Note: All other GPIO pins (GPIO 16, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39) are internally mapped to the OV2640 camera ribbon connector and cannot be used for general external I/O.*

---

## 🚪 Node 3: Access Node (ESP32 30-Pin Dev Board)

The Access Node integrates three hardware peripherals:
1. **RC522 RFID Reader** via SPI
2. **4x4 Matrix Membrane Keypad** via 8 GPIO pins
3. **MG90S Metal-Gear Micro Servo** via PWM

### 1. RC522 RFID Module (SPI)
> [!WARNING]
> The RC522 module is a **3.3V logic device**. Connecting it to 5V will permanently damage the module. Always connect VCC to the **3V3** pin of the ESP32.

| RC522 Pin | ESP32 Pin | SPI Function |
| :--- | :--- | :--- |
| **VCC** | **3V3** | 3.3V Power (Do NOT connect to 5V) |
| **RST** | **GPIO 22** | Module Reset |
| **GND** | **GND** | Ground |
| **IRQ** | *NC* | Not Connected |
| **MISO** | **GPIO 19** | SPI Master In / Slave Out |
| **MOSI** | **GPIO 23** | SPI Master Out / Slave In |
| **SCK** | **GPIO 18** | SPI Clock |
| **SDA (SS)**| **GPIO 5** | SPI Chip Select (Slave Select) |

---

### 2. 4x4 Matrix Membrane Keypad
8-pin ribbon cable (4 Rows, 4 Columns). Pins are selected to deliberately avoid ESP32 strapping pins (`GPIO 0`, `GPIO 2`, `GPIO 12`, `GPIO 15`) which can cause boot failure or prevent sketch uploading.

| Keypad Ribbon Pin | ESP32 Pin | Role | Description |
| :--- | :--- | :--- | :--- |
| **Pin 1 (Row 1)** | **GPIO 13** | Input with Pull-up | Keys: 1, 2, 3, A |
| **Pin 2 (Row 2)** | **GPIO 14** | Input with Pull-up | Keys: 4, 5, 6, B |
| **Pin 3 (Row 3)** | **GPIO 27** | Input with Pull-up | Keys: 7, 8, 9, C |
| **Pin 4 (Row 4)** | **GPIO 26** | Input with Pull-up | Keys: *, 0, #, D |
| **Pin 5 (Col 1)** | **GPIO 25** | Output Driven Low | Column 1 scan |
| **Pin 6 (Col 2)** | **GPIO 33** | Output Driven Low | Column 2 scan |
| **Pin 7 (Col 3)** | **GPIO 32** | Output Driven Low | Column 3 scan |
| **Pin 8 (Col 4)** | **GPIO 4** | Output Driven Low | Column 4 scan |

---

### 3. MG90S Micro Servo Motor
> [!IMPORTANT]
> The MG90S draws significant current during motor movement (stall current up to 800mA). Power it from an external 5V rail or the ESP32 5V (VIN) pin, ensuring the external power supply has a shared common ground (`GND`) with the ESP32.

| Servo Wire Color | Connection | Notes |
| :--- | :--- | :--- |
| **Brown (GND)** | **GND** | Common Ground |
| **Red (VCC)** | **5V / VIN** | 5V Power (External 5V supply recommended) |
| **Orange / Yellow (Signal)** | **GPIO 16** | PWM Output (LEDC channel) |

---

## ⚡ Power Bus Schematic Summary

```
                      +-------------------+
                      | 5V / 2A DC Supply |
                      +----+---------+----+
                           |         |
                  +--------+         +--------+
                  |                           |
                  v (5V)                      v (5V)
            +------------+              +------------+
            |  ESP32-CAM |              | ESP32 Dev  |
            |  5V & GND  |              | VIN & GND  |
            +-----+------+              +-----+------+
                  |                           |
       [100µF+ Cap across 5V/GND]             +---> 3V3 ---> RC522 VCC
                                              +---> 5V  ---> MG90S VCC
                                              +---> GND ---> Common GND (All)
```
