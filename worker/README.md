# Cloudflare Worker and D1

This directory is the active backend. It receives ESP32 health and scan uploads, stores D1 history, coordinates commands, formats Telegram output, and calls OpenRouter only for eligible daily reports.

For the complete installation workflow, read [Setup.md](../Setup.md).

## Local setup

From the repository root, run `setup-user.bat` to create the ignored `worker/wrangler.jsonc` and `worker/.dev.vars`. The tracked `wrangler.example.jsonc` contains placeholders and is not a deployable installation.

```powershell
Set-Location worker
npm.cmd install
npx.cmd wrangler d1 migrations apply esp32-network-monitor --local
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler deploy --dry-run
```

Production credentials are configured interactively with `npx.cmd wrangler secret put NAME`. Never put their values in `wrangler.jsonc`, source code, commands, or documentation.

## Environment and bindings

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | Device, scan, command, report, and idempotency data |
| `REPORT_TIMEZONE` | Variable | Local reporting date/timezone |
| `OPENROUTER_MODEL` | Variable | Operator-selected report model |
| `MAX_COMMAND_AGE_SECONDS` | Variable | Command expiry window |
| `DATA_RETENTION_DAYS` | Variable | Historical retention; public default is 31 |
| `DEVICE_ID` | Variable | Default ESP32 device ID |
| `OPENROUTER_API_KEY` | Secret | OpenRouter authentication |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram Bot API authentication |
| `TELEGRAM_CHAT_ID` | Secret | Authorized destination chat |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Telegram webhook verification |
| `ESP32_DEVICE_TOKEN` | Secret | ESP32 route authentication |
| `ADMIN_API_KEY` | Secret | Administrative route authentication |

## HTTP API

| Method and path | Authentication | Purpose |
|---|---|---|
| `GET /health` | None | Service liveness only |
| `POST /telegram/webhook` | Telegram secret header | Telegram updates |
| `POST /telegram/register-menu` | Admin key | Register bot commands/menu |
| `POST /v1/status` | Device token | Upload ESP32 health/state |
| `POST /v1/status-requests` | Admin key | Queue a fresh health update |
| `POST /v1/scan-requests` | Admin key | Queue a manual scan |
| `GET /v1/devices/{id}/commands` | Device token | Claim the next command |
| `GET /v1/devices/{id}/last-scan` | Device token | Read latest scan age for startup scheduling |
| `POST /v1/scans` | Device token | Upload scan observations |
| `POST /v1/commands/{id}/complete` | Device token | Complete a claimed command |
| `POST /v1/commands/{id}/fail` | Device token | Fail a claimed command |
| `GET /v1/commands/{id}` | Admin key | Inspect command status |
| `POST /v1/daily-report-trigger` | Device token | Request the previous local day's automatic report |
| `POST /v1/reports` | Admin key | Request a manual report |

Device routes use `X-Device-Token`. Administrative routes use `X-Admin-Key`. The health route intentionally returns no private device or database data.

## Health behavior

Firmware 0.4.0 posts lightweight health every two minutes. This is independent of the hourly LAN scan. A normal health upload performs one D1 device upsert.

Telegram `/status` and direct requests queue `health_check`. The ESP32 polls every 30 seconds, publishes fresh state with the command ID, and the Worker marks that command complete only after D1 receives the update.

Measure the complete request-to-D1 path:

```powershell
$workerUrl = Read-Host "Deployed Worker URL"
.\scripts\measure-health-refresh.ps1 -WorkerUrl $workerUrl -DeviceId "esp32-monitor-01"
```

The script prompts securely for `ADMIN_API_KEY`. A clean measurement rejects an already-queued health command instead of reporting misleading timing.

## Telegram commands

- `/status` queues a fresh health check and replies again after the ESP32 upload.
- `/scan` acknowledges immediately and sends results after completion.
- `/online` lists online-observed IPs and latency.
- `/name IP hostname` assigns a persistent label.
- `/lastscan` shows the latest scan summary.
- `/report` requests one additional AI report.
- `/help` shows the command list.

## Daily reports

At or after 00:05 local time, the ESP32 requests the previous local date. Failed or missed attempts retry every 15 minutes until accepted.

- 0 scans: deterministic no-activity message; no AI call.
- 1 scan: deterministic insufficient-data message; no AI call.
- 2 or more scans: one automatic AI report using all scans for that date.

The Worker sends aggregate defensive telemetry and online-observed device measurements to OpenRouter. Deterministic formatting and Telegram delivery remain Worker-owned.

## Data retention

The public default is 31 days for scans, scan devices, commands, daily reports, manual report runs, and idempotency keys. Current inventory and latest device status are preserved. Cleanup is upload-triggered, so an offline monitor delays deletion until a later successful upload.

## Deployment

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler deploy --dry-run
npx.cmd wrangler d1 migrations apply esp32-network-monitor --remote
npx.cmd wrangler deploy
```

Use the configured database name if it differs from the default. Deployment does not upload ESP32 firmware.
