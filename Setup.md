# ESP32 Network Monitor Setup

This guide takes a new installation from clone to a working ESP32, Cloudflare Worker, D1 database, Telegram bot, and optional OpenRouter report.

```text
ESP32 --HTTPS--> Cloudflare Worker --> D1
                               |----> Telegram
                               `----> OpenRouter (daily AI reports only)
```

The ESP32 performs LAN discovery locally. The cloud service cannot initiate scans inside a private network.

## 1. Prerequisites

Install:

- Git
- Node.js 20 or later
- Arduino IDE 2
- The Espressif ESP32 board package
- A Cloudflare account
- A Telegram account
- An OpenRouter account if AI daily reports are required

Clone and install Worker dependencies:

```powershell
git clone https://github.com/Fkuzzl/esp32-network-monitor.git
Set-Location esp32-network-monitor\worker
npm.cmd install
Set-Location ..
```

In Arduino IDE, install `ArduinoJson`, `ESP32Ping`, and `U8g2` through Library Manager.

## 2. Provider configuration

Create the ignored provider file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace every placeholder in `.env`. The file contains the OpenRouter model/key and Telegram bot/chat values. It must never be committed.

Create a Telegram bot with `@BotFather` using `/newbot`, send the bot one message, and obtain the target chat ID. Create an OpenRouter key only if AI reporting will be used. Provider credentials remain in the Worker and are never copied into ESP32 firmware.

## 3. Cloudflare database

Authenticate and create D1:

```powershell
Set-Location worker
npx.cmd wrangler login
npx.cmd wrangler d1 create esp32-network-monitor
Set-Location ..
```

Keep the returned database ID for the setup script.

## 4. HTTPS certificate validation

The firmware validates the Worker certificate with `setCACert()` and must not use `setInsecure()` in a public or production installation.

Obtain the PEM root CA that validates the certificate for the final Worker hostname and save it locally, for example:

```text
esp32/NetworkMonitor/worker-root-ca.pem
```

PEM, private-key, and generated configuration files are ignored. Recheck the certificate chain if the Worker hostname or certificate authority changes.

## 5. Generate installation files

Run the Windows setup entry point:

```powershell
.\setup-user.bat
```

The script asks for Cloudflare names, the D1 ID, Worker URL, Wi-Fi details, device ID, timezones, and the CA PEM path. The Wi-Fi password is entered without echo. It generates unique admin, ESP32, and Telegram webhook secrets.

Generated files:

```text
.env.local
worker/.dev.vars
worker/wrangler.jsonc
esp32/NetworkMonitor/config.h
```

All four are ignored by Git. Only Wi-Fi credentials, the ESP32 device token, Worker URL, device ID, and root CA are placed in firmware. If the deployed URL differs from the value entered during setup, correct `config.h` before uploading.

The defaults use `Asia/Shanghai` for Worker reporting and `CST-8` for the ESP32 POSIX timezone. Other installations should enter matching local values when prompted.

## 6. Apply migrations

Using the default database name:

```powershell
Set-Location worker
npx.cmd wrangler d1 migrations apply esp32-network-monitor --remote
```

If a custom database name was selected, use that name instead. Apply every migration before deploying the Worker.

## 7. Upload Worker secrets

Run each command and paste the corresponding value from `.env` or `.env.local` only when Wrangler prompts. Do not place secret values in command arguments or terminal history.

```powershell
npx.cmd wrangler secret put OPENROUTER_API_KEY
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler secret put TELEGRAM_CHAT_ID
npx.cmd wrangler secret put ESP32_DEVICE_TOKEN
npx.cmd wrangler secret put ADMIN_API_KEY
npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Confirm names only:

```powershell
npx.cmd wrangler secret list
```

## 8. Validate and deploy the Worker

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler deploy --dry-run
npx.cmd wrangler deploy
```

Check the deployed service without embedding a placeholder URL in a command:

```powershell
$workerUrl = Read-Host "Deployed Worker URL"
Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/health"
```

Expected response:

```json
{"ok":true,"service":"esp32-network-monitor"}
```

## 9. Register the Telegram webhook

The `secret_token` field must be sent to Telegram when registering the webhook. Telegram will then include it in the `X-Telegram-Bot-Api-Secret-Token` header on webhook deliveries.

From the repository root:

```powershell
$provider = Get-Content .env
$local = Get-Content .env.local
$telegramToken = ($provider | Select-String '^TELEGRAM_BOT_TOKEN=').ToString().Split('=',2)[1]
$webhookSecret = ($local | Select-String '^TELEGRAM_WEBHOOK_SECRET=').ToString().Split('=',2)[1]
$workerUrl = (Read-Host "Deployed Worker URL").TrimEnd('/')

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$telegramToken/setWebhook" `
  -Body @{ url = "$workerUrl/telegram/webhook"; secret_token = $webhookSecret }
```

The response should contain `ok: True`. Do not paste the bot token or webhook secret into issues, screenshots, or documentation.

## 10. Wire the hardware

All modules share GND and use 3.3 V logic.

### SSD1306 I2C OLED

| OLED | ESP32 |
|---|---|
| GND | GND |
| VCC | 3V3 |
| SCL | GPIO22 |
| SDA | GPIO21 |

The default I2C address is `0x3C`; test `0x3D` if the display remains blank.

### Force-scan button module

| Button | ESP32 |
|---|---|
| GND | GND |
| VCC | 3V3 |
| OUT | GPIO27 |

The default active level is `HIGH`. If the module behaves inversely, change `FORCE_SCAN_BUTTON_ACTIVE_LEVEL` in the local `config.h`.

Use a USB data cable, select the correct ESP32 board and COM port, and open Serial Monitor at `115200` baud.

## 11. Upload firmware 0.4.0

Open `esp32/NetworkMonitor/NetworkMonitor.ino`. Confirm that the generated `config.h` has the final Worker URL and certificate, then compile and upload.

Typical output uses the subnet assigned by the router, for example:

```text
ESP32 Network Monitor starting
Connected. ESP32 IP: 192.168.1.40
Gateway: 192.168.1.1
Detected subnet: 192.168.1.0/24
Scanning 192.168.1.1 through 192.168.1.254
Scan upload HTTP 202: {"accepted":true,"scanId":"..."}
Health update HTTP 200 in ... ms: {"accepted":true,"receivedAt":"..."}
```

The LAN scan remains hourly. Lightweight ESP32 health is uploaded every two minutes, and commands are polled every 30 seconds.

## 12. Verify the complete flow

Send these commands to the bot:

- `/help`
- `/status`
- `/scan`
- `/lastscan`
- `/online`

`/scan` acknowledges immediately and sends results after completion. A duplicate scan request while scanning is ignored.

Measure an on-demand health refresh:

```powershell
Set-Location worker
$workerUrl = Read-Host "Deployed Worker URL"
.\scripts\measure-health-refresh.ps1 -WorkerUrl $workerUrl -DeviceId "esp32-monitor-01"
```

The script securely prompts for `ADMIN_API_KEY`. End-to-end completion is normally within the 30-second ESP32 command-poll window. This health request does not start a LAN scan.

## 13. Reporting and retention

- 0 scans: deterministic no-activity message; no AI call.
- 1 scan: deterministic insufficient-data message; no AI call.
- 2 or more scans: exactly one automatic AI report for the local date.
- Manual and retry scans are included; there is no 24-scan limit.
- Only IPs observed online are analyzed as devices.
- Scan, command, idempotency, and report history is retained for 31 days.
- Cleanup runs after successful uploads; if the ESP32 is offline, old history remains until the next upload.

Before purging historical offline observations, export D1 using the configured database name and keep the output under the ignored `worker/backups/` directory.

## 14. Public-release security check

The following local files must be ignored and untracked:

```text
.env
.env.local
worker/.dev.vars
worker/wrangler.jsonc
esp32/NetworkMonitor/config.h
esp32/NetworkMonitor/worker-root-ca.pem
```

Verify ignore behavior:

```powershell
git check-ignore .env .env.local worker/.dev.vars worker/wrangler.jsonc esp32/NetworkMonitor/config.h
git status --short --ignored
```

Run Gitleaks against both Git history and the current tree before changing repository visibility:

```powershell
gitleaks git --redact .
gitleaks dir --redact .
```

The directory scan will inspect ignored local files too, so a finding in `.env` is expected when real provider credentials are configured. That file must remain ignored. Findings in tracked files or Git history block publication and require credential rotation plus history cleanup.

## Troubleshooting

### `Unauthorized`

Confirm the current secret and header. ESP32 routes use `X-Device-Token`; administrative routes use `X-Admin-Key`.

### ESP32 does not appear as a COM port

Use a USB data cable, reconnect the board, install the board's USB-to-serial driver, and select the newly appearing port rather than assuming `COM1` is the ESP32.

### `ESP32Ping.h: No such file or directory`

Install `ESP32Ping` through Arduino Library Manager and restart Arduino IDE.

### Scan or health upload fails

Check Wi-Fi, the Worker URL, ESP32 token, CA trust chain, Worker deployment, and Serial Monitor output.

### Telegram webhook returns 404

Deploy first, then register the exact deployed URL ending in `/telegram/webhook`.
