#pragma once

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

#define DEVICE_ID "esp32-monitor-01"
#define ESP32_DEVICE_TOKEN "YOUR_ESP32_DEVICE_TOKEN"

#define WORKER_BASE_URL "https://replace-with-worker-url.workers.dev"

// PEM root CA used to validate the HTTPS certificate for WORKER_BASE_URL.
// The setup script replaces this placeholder with the contents of your CA file.
#define WORKER_ROOT_CA_PEM "YOUR_WORKER_ROOT_CA_PEM"

// Common SSD1306 I2C address. Use 0x3D if an I2C scan identifies that address.
#define OLED_I2C_ADDRESS 0x3C

// Force-scan button module: OUT is HIGH while pressed.
#define FORCE_SCAN_BUTTON_PIN 27
#define FORCE_SCAN_BUTTON_ACTIVE_LEVEL HIGH

// Asia/Shanghai is UTC+8 and has no daylight-saving transition.
#define TZ_INFO "CST-8"

// First test with 5 minutes, then change to 3600 seconds.
#define HOURLY_SCAN_INTERVAL_SECONDS 3600UL
#define COMMAND_POLL_INTERVAL_SECONDS 30UL
