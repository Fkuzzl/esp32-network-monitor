# Changelog

## 0.4.0 - 2026-08-28

- Added automatic lightweight ESP32 health publication every two minutes.
- Kept hourly LAN discovery independent from health reporting.
- Added authenticated on-demand health requests and an end-to-end timing script.
- Reduced a normal health update from two D1 device writes to one.
- Added Worker receipt timestamps and ESP32 HTTPS timing logs.
- Improved failed-health retry behavior and three-minute stale-health handling.
- Added public installation, secret-handling, TLS, retention, and release documentation.

## 0.3.0

- Added remote last-scan lookup so restarts avoid unnecessary duplicate scans.
- Added resilient daily-report retries and duplicate command protection.

## 0.2.0

- Added OLED state, force-scan button handling, and ESP32 status publishing.
