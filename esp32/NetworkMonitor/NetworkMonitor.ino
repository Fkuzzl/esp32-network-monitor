#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <ESP32Ping.h>
#include <Preferences.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <time.h>

#include "config.h"

static const uint16_t MAX_SCAN_HOSTS = 1024;
static const uint8_t PING_ATTEMPTS = 2;

IPAddress scanNetworkAddress;
IPAddress scanBroadcastAddress;
String detectedSubnet = "";

uint32_t ipToUint32(const IPAddress& address) {
  return (static_cast<uint32_t>(address[0]) << 24) |
    (static_cast<uint32_t>(address[1]) << 16) |
    (static_cast<uint32_t>(address[2]) << 8) |
    static_cast<uint32_t>(address[3]);
}

IPAddress uint32ToIp(uint32_t value) {
  return IPAddress(
    static_cast<uint8_t>((value >> 24) & 0xFF),
    static_cast<uint8_t>((value >> 16) & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF),
    static_cast<uint8_t>(value & 0xFF)
  );
}

uint8_t subnetPrefixLength(const IPAddress& mask) {
  uint8_t prefix = 0;
  bool zeroSeen = false;
  for (uint8_t octet = 0; octet < 4; octet++) {
    for (int8_t bit = 7; bit >= 0; bit--) {
      const bool set = (mask[octet] & (1 << bit)) != 0;
      if (set && zeroSeen) return 0;
      if (set) prefix++;
      else zeroSeen = true;
    }
  }
  return prefix;
}

bool refreshNetworkInfo() {
  if (WiFi.status() != WL_CONNECTED) return false;

  const IPAddress localIp = WiFi.localIP();
  const IPAddress mask = WiFi.subnetMask();
  const uint8_t prefix = subnetPrefixLength(mask);
  if (prefix < 16 || prefix > 30) {
    Serial.printf("Unsupported subnet mask: %s (prefix /%u)\n", mask.toString().c_str(), prefix);
    detectedSubnet = "";
    return false;
  }

  const uint32_t network = ipToUint32(localIp) & ipToUint32(mask);
  const uint32_t broadcast = network | (~ipToUint32(mask));
  scanNetworkAddress = uint32ToIp(network);
  scanBroadcastAddress = uint32ToIp(broadcast);
  detectedSubnet = scanNetworkAddress.toString() + "/" + String(prefix);

  const uint32_t hostCount = broadcast > network + 1 ? broadcast - network - 1 : 0;
  Serial.printf("Subnet mask: %s (/%u)\n", mask.toString().c_str(), prefix);
  Serial.printf("Detected subnet: %s\n", detectedSubnet.c_str());
  Serial.printf("Scan range: %s through %s (%lu hosts)\n", uint32ToIp(network + 1).toString().c_str(), uint32ToIp(broadcast - 1).toString().c_str(), static_cast<unsigned long>(hostCount));
  if (hostCount > MAX_SCAN_HOSTS) {
    Serial.printf("Subnet is too large; maximum supported scan size is %u hosts\n", MAX_SCAN_HOSTS);
    return false;
  }
  return true;
}

Preferences preferences;
unsigned long lastHourlyScanMillis = 0;
unsigned long lastCommandPollMillis = 0;
unsigned long lastDailyReportAttemptMillis = 0;
static const unsigned long DAILY_REPORT_RETRY_INTERVAL_MILLIS = 15UL * 60UL * 1000UL;

// Common 0.96-inch 128x64 I2C OLED using an SSD1306 controller.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
bool oledReady = false;
uint16_t oledOnlineCount = 0;
String oledTarget = "";
String monitorState = "idle";
String monitorTarget = "";
unsigned long lastStatusPublishMillis = 0;
// Publish lightweight ESP32 health every two minutes. Hourly LAN scans keep
// their independent schedule, while forced state transitions still publish
// immediately.
static const unsigned long STATUS_PUBLISH_INTERVAL_MILLIS = 2UL * 60UL * 1000UL;
static const char* FIRMWARE_VERSION = "0.4.0";

enum OledState {
  OLED_BOOT,
  OLED_WIFI,
  OLED_TIME,
  OLED_SCANNING,
  OLED_UPLOADING,
  OLED_IDLE,
  OLED_ERROR,
};

OledState oledState = OLED_BOOT;
volatile bool forceButtonEvent = false;
volatile bool scanInProgress = false;
unsigned long lastForceButtonEventMillis = 0;

void processForceScanButton();

void IRAM_ATTR onForceButtonInterrupt() {
  forceButtonEvent = true;
}

const char* oledStateLabel() {
  switch (oledState) {
    case OLED_WIFI: return "WIFI CONNECTING";
    case OLED_TIME: return "TIME SYNC";
    case OLED_SCANNING: return "SCANNING";
    case OLED_UPLOADING: return "UPLOADING";
    case OLED_IDLE: return "IDLE / HEALTHY";
    case OLED_ERROR: return "ERROR / RETRY";
    default: return "STARTING";
  }
}

void updateOled() {
  if (!oledReady) return;

  char onlineLine[24];
  snprintf(onlineLine, sizeof(onlineLine), "ONLINE: %u", oledOnlineCount);

  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tf);
  oled.drawStr(0, 10, "ESP32 NETWORK MONITOR");
  oled.drawStr(0, 27, oledStateLabel());
  oled.drawStr(0, 43, oledTarget.c_str());
  oled.drawStr(0, 60, onlineLine);
  oled.sendBuffer();
}

void setOledState(OledState state, const String& target = "") {
  oledState = state;
  oledTarget = target;
  updateOled();
}

String nextPingAtTimestamp() {
  if (time(nullptr) <= 1700000000) return "";
  const unsigned long intervalSeconds = HOURLY_SCAN_INTERVAL_SECONDS;
  const unsigned long elapsedSeconds = (millis() - lastHourlyScanMillis) / 1000UL;
  const unsigned long remainingSeconds = elapsedSeconds >= intervalSeconds ? 0UL : intervalSeconds - elapsedSeconds;
  time_t nextPing = time(nullptr) + static_cast<time_t>(remainingSeconds);
  struct tm localTime;
  localtime_r(&nextPing, &localTime);
  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%S%z", &localTime);
  String value(buffer);
  if (value.length() == 24) value = value.substring(0, 22) + ":" + value.substring(22);
  return value;
}

bool publishStatus(bool force = false, const String& commandId = "");

String nextPingLabel() {
  const unsigned long intervalSeconds = HOURLY_SCAN_INTERVAL_SECONDS;
  const unsigned long elapsedSeconds = (millis() - lastHourlyScanMillis) / 1000UL;
  const unsigned long remainingSeconds = elapsedSeconds >= intervalSeconds ? 0UL : intervalSeconds - elapsedSeconds;

  if (time(nullptr) <= 1700000000 || remainingSeconds == 0) {
    return "NEXT PING SOON";
  }

  time_t nextPing = time(nullptr) + static_cast<time_t>(remainingSeconds);
  struct tm localTime;
  localtime_r(&nextPing, &localTime);
  char buffer[20];
  strftime(buffer, sizeof(buffer), "NEXT PING %H:%M", &localTime);
  return String(buffer);
}

void initializeOled() {
  Wire.begin(21, 22); // SDA, SCL on the common ESP32 DevKit V1
  oled.setI2CAddress(static_cast<uint8_t>(OLED_I2C_ADDRESS << 1));
  oled.begin();
  oledReady = true;
  setOledState(OLED_BOOT, "Ready");
}

String apiUrl(const String& path) {
  return String(WORKER_BASE_URL) + path;
}

String stableScanId(const String& commandId, const String& startedAt) {
  String source = commandId.length() > 0 ? "cmd_" + commandId : startedAt;
  String value = "scan_";
  for (size_t index = 0; index < source.length() && value.length() < 160; index++) {
    const char character = source[index];
    if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '_') {
      value += character;
    } else {
      value += '_';
    }
  }
  return value;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  setOledState(OLED_WIFI, "Connecting...");
  Serial.printf("Connecting to Wi-Fi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000UL) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. ESP32 IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("Gateway: ");
    Serial.println(WiFi.gatewayIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
    setOledState(OLED_IDLE, WiFi.localIP().toString());
    monitorState = "idle";
    publishStatus(true);
  } else {
    Serial.println("Wi-Fi connection failed");
    setOledState(OLED_ERROR, "Wi-Fi failed");
    monitorState = "error";
  }
}

bool syncClock() {
  if (time(nullptr) > 1700000000) return true;

  setOledState(OLED_TIME, "NTP...");
  configTzTime(TZ_INFO, "pool.ntp.org", "time.nist.gov");
  Serial.print("Synchronizing time");
  const unsigned long started = millis();
  time_t now = time(nullptr);
  while (now <= 1700000000 && millis() - started < 30000UL) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println();
  return now > 1700000000;
}

String localIsoTimestamp() {
  time_t now = time(nullptr);
  struct tm localTime;
  localtime_r(&now, &localTime);

  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%S%z", &localTime);
  String value(buffer);
  if (value.length() == 24) {
    value = value.substring(0, 22) + ":" + value.substring(22);
  }
  return value;
}

String localDate() {
  time_t now = time(nullptr);
  struct tm localTime;
  localtime_r(&now, &localTime);

  char buffer[11];
  strftime(buffer, sizeof(buffer), "%Y-%m-%d", &localTime);
  return String(buffer);
}

int localMinute() {
  time_t now = time(nullptr);
  struct tm localTime;
  localtime_r(&now, &localTime);
  return localTime.tm_min;
}

int localHour() {
  time_t now = time(nullptr);
  struct tm localTime;
  localtime_r(&now, &localTime);
  return localTime.tm_hour;
}

bool isOwnIp(const IPAddress& address) {
  return address == WiFi.localIP();
}

bool scanNetwork(JsonArray devices, uint32_t& addressesChecked) {
  if (!refreshNetworkInfo()) return false;
  const uint32_t network = ipToUint32(scanNetworkAddress);
  const uint32_t broadcast = ipToUint32(scanBroadcastAddress);
  Serial.printf("Scanning %s through %s\n", uint32ToIp(network + 1).toString().c_str(), uint32ToIp(broadcast - 1).toString().c_str());
  scanInProgress = true;
  monitorState = "scanning";
  monitorTarget = uint32ToIp(network + 1).toString();
  publishStatus(true);
  oledOnlineCount = 0;
  setOledState(OLED_SCANNING, "PING " + monitorTarget);

  for (uint32_t numericAddress = network + 1; numericAddress < broadcast; numericAddress++) {
    IPAddress address = uint32ToIp(numericAddress);
    if (isOwnIp(address)) continue;
    addressesChecked++;

    // Two attempts reduce false negatives caused by a dropped ICMP packet.
    // This still cannot detect devices that are asleep or block ICMP.
    const bool online = Ping.ping(address, PING_ATTEMPTS);
    oledTarget = "PING " + address.toString();
    monitorTarget = address.toString();
    if (online) {
      JsonObject device = devices.add<JsonObject>();
      device["ip"] = address.toString();
      device["online"] = true;
      const int latencyMs = static_cast<int>(Ping.averageTime());
      device["latencyMs"] = latencyMs;
      oledOnlineCount++;
      Serial.printf("ONLINE  %s  latency=%d ms\n", address.toString().c_str(), latencyMs);
    }

    if (online || numericAddress % 5 == 0) updateOled();

    delay(20);
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Wi-Fi disconnected during scan");
      scanInProgress = false;
      return false;
    }

    processForceScanButton();
    publishStatus(false);
  }

  scanInProgress = false;
  monitorState = "idle";
  monitorTarget = "Scan complete";
  publishStatus(true);
  setOledState(OLED_IDLE, "Scan complete");
  return true;
}

bool httpRequest(
  const String& method,
  const String& path,
  const String& payload,
  String& response,
  int& statusCode
) {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setCACert(WORKER_ROOT_CA_PEM);

  HTTPClient http;
  if (!http.begin(client, apiUrl(path))) return false;

  // A full /v1/scans request contains up to 254 observations and the Worker
  // writes them to D1 in one batch. The ESP32 HTTPClient default timeout is
  // too short for that operation over HTTPS.
  http.setTimeout(30000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", ESP32_DEVICE_TOKEN);

  if (method == "GET") {
    statusCode = http.GET();
  } else {
    statusCode = http.POST(payload);
  }

  response = http.getString();
  if (statusCode < 0) {
    Serial.printf("HTTP client error: %s\n", http.errorToString(statusCode).c_str());
  }
  http.end();
  return statusCode >= 200 && statusCode < 300;
}

bool fetchLastRemoteScan(uint32_t& ageSeconds, String& lastScanAt, bool& hasScan) {
  String response;
  int statusCode = 0;
  if (!httpRequest("GET", "/v1/devices/" + String(DEVICE_ID) + "/last-scan", "", response, statusCode)) {
    Serial.printf("Last-scan check failed: HTTP %d\n", statusCode);
    return false;
  }

  DynamicJsonDocument document(1024);
  const DeserializationError error = deserializeJson(document, response);
  if (error) {
    Serial.printf("Last-scan response JSON error: %s\n", error.c_str());
    return false;
  }

  if (document["deviceId"].as<const char*>() == nullptr || document["hasScan"].isNull()) {
    Serial.println("Last-scan response is missing required fields");
    return false;
  }

  hasScan = document["hasScan"].as<bool>();
  if (!hasScan) {
    ageSeconds = 0;
    lastScanAt = "";
    return true;
  }

  const long parsedAge = document["ageSeconds"] | -1L;
  lastScanAt = document["lastScanAt"] | "";
  if (parsedAge < 0 || lastScanAt.length() == 0) {
    Serial.println("Last-scan response has invalid scan age or timestamp");
    return false;
  }
  ageSeconds = static_cast<uint32_t>(parsedAge);
  return true;
}

bool publishStatus(bool force, const String& commandId) {
  if (!force && millis() - lastStatusPublishMillis < STATUS_PUBLISH_INTERVAL_MILLIS) return true;
  if (WiFi.status() != WL_CONNECTED) return false;

  DynamicJsonDocument document(768);
  document["deviceId"] = DEVICE_ID;
  document["ip"] = WiFi.localIP().toString();
  document["state"] = monitorState;
  document["currentTarget"] = monitorTarget;
  document["nextPingAt"] = nextPingAtTimestamp();
  document["rssi"] = WiFi.RSSI();
  document["firmwareVersion"] = FIRMWARE_VERSION;
  JsonArray capabilities = document["capabilities"].to<JsonArray>();
  capabilities.add("health_check");
  if (commandId.length() > 0) document["commandId"] = commandId;

  String payload;
  serializeJson(document, payload);
  String response;
  int statusCode = 0;
  const unsigned long startedAtMillis = millis();
  const bool ok = httpRequest("POST", "/v1/status", payload, response, statusCode);
  const unsigned long elapsedMillis = millis() - startedAtMillis;
  Serial.printf("Health update HTTP %d in %lu ms: %s\n", statusCode, elapsedMillis, response.c_str());
  if (ok) lastStatusPublishMillis = millis();
  return ok;
}

bool uploadScan(const String& commandId, const String& reason) {
  if (!syncClock()) {
    Serial.println("Cannot upload scan without synchronized time");
    return false;
  }

  const String startedAt = localIsoTimestamp();
  DynamicJsonDocument document(64 * 1024);
  document["scanId"] = stableScanId(commandId, startedAt);
  document["deviceId"] = DEVICE_ID;
  if (commandId.length() > 0) {
    document["commandId"] = commandId;
  } else {
    document["commandId"] = nullptr;
  }
  if (!refreshNetworkInfo()) {
    Serial.println("Cannot scan: unsupported or oversized local subnet");
    return false;
  }
  document["subnet"] = detectedSubnet;
  document["scanStartedAt"] = startedAt;
  document["scanCompletedAt"] = localIsoTimestamp();
  document["reason"] = reason;
  document["status"] = "incomplete";
  document["firmwareVersion"] = FIRMWARE_VERSION;

  JsonArray devices = document["devices"].to<JsonArray>();
  uint32_t addressesChecked = 0;
  const bool scanComplete = scanNetwork(devices, addressesChecked);
  document["addressesChecked"] = addressesChecked;
  document["status"] = scanComplete ? "completed" : "incomplete";
  document["scanCompletedAt"] = localIsoTimestamp();

  String payload;
  serializeJson(document, payload);
  Serial.printf("Uploading scan: %u bytes\n", payload.length());
  monitorState = "uploading";
  monitorTarget = "Cloudflare Worker";
  publishStatus(true);
  setOledState(OLED_UPLOADING, "Cloudflare Worker");

  String response;
  int statusCode = 0;
  const bool ok = httpRequest("POST", "/v1/scans", payload, response, statusCode);
  Serial.printf("Scan upload HTTP %d: %s\n", statusCode, response.c_str());
  if (ok) lastHourlyScanMillis = millis();
  monitorState = ok ? "idle" : "error";
  monitorTarget = ok ? "Upload complete" : "Upload failed";
  publishStatus(true);
  setOledState(ok ? OLED_IDLE : OLED_ERROR, ok ? nextPingLabel() : "Upload failed");
  return ok;
}

void failCommand(const String& commandId, const String& message) {
  if (commandId.length() == 0) return;

  DynamicJsonDocument document(512);
  document["deviceId"] = DEVICE_ID;
  document["result"]["error"] = message;
  String payload;
  serializeJson(document, payload);

  String response;
  int statusCode = 0;
  httpRequest("POST", "/v1/commands/" + commandId + "/fail", payload, response, statusCode);
}

void pollCommands() {
  String response;
  int statusCode = 0;
  if (!httpRequest("GET", "/v1/devices/" + String(DEVICE_ID) + "/commands", "", response, statusCode)) {
    Serial.printf("Command poll failed: HTTP %d\n", statusCode);
    return;
  }

  DynamicJsonDocument document(4096);
  DeserializationError error = deserializeJson(document, response);
  if (error) {
    Serial.printf("Command response JSON error: %s\n", error.c_str());
    return;
  }

  JsonObject command = document["command"].as<JsonObject>();
  if (command.isNull()) return;

  const String commandId = command["id"] | "";
  const String type = command["type"] | "";
  const String reason = command["reason"] | "manual";

  Serial.printf("Received command %s: %s\n", commandId.c_str(), type.c_str());

  if (type == "health_check") {
    monitorState = scanInProgress ? "scanning" : "idle";
    monitorTarget = scanInProgress ? monitorTarget : "Status requested";
    if (!publishStatus(true, commandId)) {
      failCommand(commandId, "Health update failed");
    }
    return;
  }

  if (type != "scan") {
    failCommand(commandId, "Unsupported command type");
    return;
  }

  if (!uploadScan(commandId, reason)) {
    failCommand(commandId, "Scan upload failed");
  }
}

void triggerDailyReport() {
  if (!syncClock()) return;

  // The report covers the previous local date. Wait until 00:05 so that the
  // previous day is complete, but retry later if the ESP32 was offline or
  // occupied during the first attempt.
  if (localHour() == 0 && localMinute() < 5) return;

  const String today = localDate();
  const String lastTriggered = preferences.getString("daily_date", "");
  if (lastTriggered == today) return;

  if (lastDailyReportAttemptMillis != 0 && millis() - lastDailyReportAttemptMillis < DAILY_REPORT_RETRY_INTERVAL_MILLIS) return;
  lastDailyReportAttemptMillis = millis();

  DynamicJsonDocument document(256);
  document["date"] = today;
  document["deviceId"] = DEVICE_ID;
  String payload;
  serializeJson(document, payload);

  String response;
  int statusCode = 0;
  const bool ok = httpRequest("POST", "/v1/daily-report-trigger", payload, response, statusCode);
  Serial.printf("Daily report trigger HTTP %d: %s\n", statusCode, response.c_str());

  if (ok) preferences.putString("daily_date", today);
}

void performStartupScan() {
  if (!syncClock()) return;
  if (!uploadScan("", "startup")) {
    Serial.println("Startup scan upload failed; the next hourly scan will retry");
  }
}

void performHourlyScan() {
  if (!syncClock()) return;
  if (!uploadScan("", "hourly")) {
    Serial.println("Hourly scan upload failed; it will retry on the next interval");
  }
}

void processForceScanButton() {
  if (!forceButtonEvent) return;

  noInterrupts();
  forceButtonEvent = false;
  interrupts();

  if (millis() - lastForceButtonEventMillis < 250UL) return;
  lastForceButtonEventMillis = millis();

  if (scanInProgress) {
    Serial.println("FORCE-SCAN: IGNORE (PINGING)");
    oledTarget = "IGNORE (PINGING)";
    updateOled();
    return;
  }

  Serial.println("FORCE-SCAN: START");
  setOledState(OLED_SCANNING, "FORCE-SCAN");
  if (!uploadScan("", "manual")) {
    Serial.println("FORCE-SCAN: FAILED");
  } else {
    Serial.println("FORCE-SCAN: COMPLETE");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32 Network Monitor starting");

  initializeOled();
  preferences.begin("network", false);
  pinMode(FORCE_SCAN_BUTTON_PIN, INPUT);
  attachInterrupt(
    digitalPinToInterrupt(FORCE_SCAN_BUTTON_PIN),
    onForceButtonInterrupt,
    FORCE_SCAN_BUTTON_ACTIVE_LEVEL == HIGH ? RISING : FALLING
  );
  connectWiFi();
  syncClock();

  Serial.println("Checking last remote scan...");
  bool startupScanRequired = true;
  uint32_t lastScanAgeSeconds = 0;
  String lastScanAt;
  bool hasRemoteScan = false;
  if (fetchLastRemoteScan(lastScanAgeSeconds, lastScanAt, hasRemoteScan)) {
    if (hasRemoteScan) {
      Serial.printf("Last scan age: %lu seconds\n", static_cast<unsigned long>(lastScanAgeSeconds));
      if (lastScanAgeSeconds < HOURLY_SCAN_INTERVAL_SECONDS) {
        lastHourlyScanMillis = millis() - lastScanAgeSeconds * 1000UL;
        startupScanRequired = false;
        Serial.printf("Last scan time: %s\n", lastScanAt.c_str());
        Serial.printf("Startup scan skipped; next scan due in %lu seconds\n", static_cast<unsigned long>(HOURLY_SCAN_INTERVAL_SECONDS - lastScanAgeSeconds));
      }
    }
  } else {
    Serial.println("Last-scan check failed; performing one startup scan");
  }

  if (startupScanRequired) {
    Serial.println("Last scan is due or unavailable");
    Serial.println("Performing startup scan");
    performStartupScan();
    lastHourlyScanMillis = millis();
  } else {
    monitorState = "idle";
    monitorTarget = "Waiting for scheduled scan";
    setOledState(OLED_IDLE, nextPingLabel());
  }
  lastCommandPollMillis = millis();
  monitorState = "idle";
  monitorTarget = "Ready";
  publishStatus(true);
}

void loop() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    delay(5000);
    return;
  }

  processForceScanButton();

  const unsigned long now = millis();
  if (now - lastCommandPollMillis >= COMMAND_POLL_INTERVAL_SECONDS * 1000UL) {
    pollCommands();
    lastCommandPollMillis = now;
  }

  // This is a lightweight health update only. It never starts a LAN scan.
  publishStatus(false);

  if (now - lastHourlyScanMillis >= HOURLY_SCAN_INTERVAL_SECONDS * 1000UL) {
    performHourlyScan();
    lastHourlyScanMillis = millis();
  }

  // Keep the idle screen's next scheduled ping time current.
  static unsigned long lastOledRefreshMillis = 0;
  if (oledState == OLED_IDLE && now - lastOledRefreshMillis >= 5000UL) {
    oledTarget = nextPingLabel();
    updateOled();
    lastOledRefreshMillis = now;
  }

  triggerDailyReport();

  delay(1000);
}
