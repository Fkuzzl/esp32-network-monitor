# Secret Storage and Rotation

This project separates publishable templates from one installation's credentials. Never put real keys, Wi-Fi details, chat IDs, private deployment identifiers, or generated firmware configuration in GitHub.

## Files and ownership

| File or service | Purpose | Commit? |
|---|---|---:|
| `.env.example` | Provider-variable names and placeholders | Yes |
| `worker/wrangler.example.jsonc` | Safe Worker/D1 configuration template | Yes |
| `esp32/NetworkMonitor/config.example.h` | Safe firmware template | Yes |
| `.env` | Operator-supplied OpenRouter and Telegram values | No |
| `.env.local` | Generated local administration and provider values | No |
| `worker/.dev.vars` | Local Worker secrets | No |
| `worker/wrangler.jsonc` | Installation-specific Worker and D1 configuration | No |
| `esp32/NetworkMonitor/config.h` | Wi-Fi, ESP32 token, Worker URL, and root CA | No |
| Cloudflare Worker secrets | Production credentials | Never exported to Git |

The firmware receives only the credentials required for its job. It must not contain the admin key, Telegram bot token, Telegram chat ID, webhook secret, or OpenRouter key.

## Production Worker secrets

```text
ADMIN_API_KEY
ESP32_DEVICE_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
OPENROUTER_API_KEY
```

List names without revealing values:

```powershell
Set-Location worker
npx.cmd wrangler secret list
```

Update values through Wrangler's interactive prompt so the value is not placed in the command line:

```powershell
npx.cmd wrangler secret put ADMIN_API_KEY
npx.cmd wrangler secret put ESP32_DEVICE_TOKEN
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler secret put TELEGRAM_CHAT_ID
npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx.cmd wrangler secret put OPENROUTER_API_KEY
```

## Local setup

```powershell
Copy-Item .env.example .env
notepad .env
.\setup-user.bat
```

The setup script generates cryptographically random per-installation values for the admin key, ESP32 token, and webhook secret. It refuses to overwrite existing generated files and does not deploy or print secret values.

Store a backup in a password manager. Do not use the same generated values for multiple installations.

## Before every public release

Confirm sensitive paths are ignored:

```powershell
git check-ignore .env .env.local worker/.dev.vars worker/wrangler.jsonc esp32/NetworkMonitor/config.h
```

Confirm none are tracked:

```powershell
git ls-files .env .env.local worker/.dev.vars worker/wrangler.jsonc esp32/NetworkMonitor/config.h
```

The second command must produce no output. Then scan both history and the complete directory:

```powershell
gitleaks git --redact .
gitleaks dir --redact .
```

The directory scan includes ignored local files. A finding located only in an ignored `.env` or generated `config.h` confirms that the scanner can see the local credential; it does not make that file releasable. Any finding in tracked content or Git history blocks the release.

## Rotation after exposure

- Telegram bot token: rotate with `@BotFather`, update Cloudflare, and register the webhook again.
- OpenRouter key: revoke it in OpenRouter and upload a replacement to Cloudflare.
- Admin key: generate a new random value and replace the Worker secret.
- Webhook secret: replace the Worker secret and register the webhook again with the new `secret_token`.
- ESP32 token: replace the Worker secret, update local `config.h`, and reflash the device.

Deleting a leaked value from the newest file is insufficient when it exists in Git history. Remove it from history, force-update the affected branch only after coordinating with collaborators, and rotate the credential regardless.
