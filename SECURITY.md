# Security Policy

## Supported version

Security fixes target the latest code on the default branch and the latest published release.

## Reporting a vulnerability

Do not open a public issue containing credentials, private IP inventories, Telegram chat data, Worker URLs tied to a private installation, or exploit details.

Use GitHub's private vulnerability reporting for this repository when available. If it is unavailable, contact the repository owner privately through their GitHub profile and include only the minimum information needed to reproduce the issue.

## Credential exposure

Treat exposed credentials as compromised even after the text is deleted:

- Rotate Telegram bot tokens through `@BotFather`.
- Replace OpenRouter API keys in OpenRouter and Cloudflare.
- Replace `ADMIN_API_KEY` and `TELEGRAM_WEBHOOK_SECRET` in Cloudflare.
- Replace `ESP32_DEVICE_TOKEN` in Cloudflare and reflash every affected ESP32.
- Remove the value from Git history before publishing or pushing another release.

Never send real secrets through issues, pull requests, build logs, screenshots, Telegram messages, or firmware source committed to Git.

## Deployment boundary

This repository contains templates and application code. Each operator is responsible for securing their Cloudflare, Telegram, OpenRouter, Wi-Fi, and physical ESP32 installation. A public repository does not make a deployed Worker, its D1 database, or a private LAN public unless the operator exposes credentials or unauthenticated routes.
