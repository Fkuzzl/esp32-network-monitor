# ESP32 Firmware

Firmware 0.4.0 discovers the DHCP-assigned IPv4 subnet, performs local ping scans, polls the Worker for commands, publishes health, drives an SSD1306 OLED, and handles a force-scan button.

Read the root [Setup.md](../Setup.md) for the complete Cloudflare, Telegram, certificate, wiring, and upload workflow.

## Scheduling

| Activity | Default |
|---|---:|
| LAN inventory scan | Every 3600 seconds |
| Lightweight health upload | Every 120 seconds |
| Worker command poll | Every 30 seconds |
| Daily report request | After 00:05 local time; retry every 15 minutes until accepted |

Health publication never starts a LAN scan. Forced state transitions may publish additional health immediately.

At startup, the firmware asks the Worker for the latest completed scan. It skips a duplicate startup scan when that scan is less than one hour old; an unavailable, missing, or older result causes one startup scan.

## Arduino IDE

1. Install Arduino IDE 2.
2. Add the Espressif Boards Manager URL:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

3. Install `esp32 by Espressif Systems`.
4. Select the exact board, or `ESP32 Dev Module` for a compatible generic board.
5. Install `ArduinoJson`, `ESP32Ping`, and `U8g2` through Library Manager.

## Wiring

All modules share GND and use 3.3 V logic.

### SSD1306 I2C OLED

| OLED | ESP32 |
|---|---|
| GND | GND |
| VCC | 3V3 |
| SCL | GPIO22 |
| SDA | GPIO21 |

The default address is `0x3C`; try `0x3D` if an I2C scan reports that address.

### Force-scan button

| Button | ESP32 |
|---|---|
| GND | GND |
| VCC | 3V3 |
| OUT | GPIO27 |

The default active level is `HIGH`. Pressing while idle starts a scan. Pressing during a scan is ignored and displays/logs `FORCE-SCAN: IGNORE (PINGING)`. If the module behaves inversely, change the active level in local configuration.

Do not power the OLED or button logic from 5 V unless the exact module documentation explicitly permits it.

## Configuration

The recommended path is running `setup-user.bat` from the repository root. It generates the ignored `esp32/NetworkMonitor/config.h` with:

- Wi-Fi SSID and password
- Device ID
- Scoped ESP32 device token
- Final HTTPS Worker URL
- Root CA certificate
- OLED/button settings
- POSIX timezone
- Scan and command intervals

For manual setup:

```powershell
Set-Location esp32\NetworkMonitor
Copy-Item config.example.h config.h
notepad config.h
```

Never commit `config.h`. It contains Wi-Fi credentials and the device token. The admin key, Telegram values, and OpenRouter key do not belong in firmware.

## TLS requirement

The firmware calls `WiFiClientSecure::setCACert()` with the generated root CA. Do not replace this with `setInsecure()` for production or a public release. Update the local CA when the Worker hostname or certificate chain changes.

## Upload

Open `NetworkMonitor.ino`, connect with a USB data cable, select the newly appearing serial port, compile, and upload. Open Serial Monitor at `115200` baud.

Typical output uses the subnet assigned by the router:

```text
ESP32 Network Monitor starting
Connected. ESP32 IP: 192.168.1.40
Gateway: 192.168.1.1
Detected subnet: 192.168.1.0/24
Scanning 192.168.1.1 through 192.168.1.254
Scan upload HTTP 202: {"accepted":true,"scanId":"..."}
Health update HTTP 200 in ... ms: {"accepted":true,"receivedAt":"..."}
```

The actual range is derived from the assigned IP and subnet mask; `192.168.1.0/24` is only a generic example.

## First test

Keep the public default at one hour. For a temporary local test only, change:

```cpp
#define HOURLY_SCAN_INTERVAL_SECONDS 3600UL
```

to `300UL`, verify one upload, restore `3600UL`, and upload again.

Verify:

- OLED reaches the idle screen and shows `NEXT PING HH:MM`.
- The Worker receives firmware version `0.4.0`.
- Automatic health appears about every two minutes.
- The force-scan button starts a scan only while idle.
- Telegram `/scan` and `/status` complete through Worker commands.

## Direct health timing

After deploying the matching Worker and uploading firmware 0.4.0:

```powershell
Set-Location ..\..\worker
$workerUrl = Read-Host "Deployed Worker URL"
.\scripts\measure-health-refresh.ps1 -WorkerUrl $workerUrl -DeviceId "esp32-monitor-01"
```

The script measures from the administrative request until D1 confirms the ESP32 upload. The result is normally within the 30-second command-poll window. Serial Monitor's `Health update HTTP ... in ... ms` measures only the HTTPS upload portion.

## Troubleshooting

- No serial port: verify the cable supports data and install the board's USB-to-serial driver.
- TLS failure: verify the Worker URL and current root CA certificate.
- `401 Unauthorized`: ensure firmware and Cloudflare use the same ESP32 token.
- Blank OLED: check common GND, 3.3 V, SDA/SCL, and address `0x3C` versus `0x3D`.
- Missing ping responses: inspect host firewalls, guest Wi-Fi, VLANs, and client isolation before assuming devices are offline.
