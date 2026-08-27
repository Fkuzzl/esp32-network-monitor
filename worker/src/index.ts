import { OpenRouterError } from "./ai";
import { authorized, bodyJson, json, validDate } from "./security";
import { isoNow, currentLocalDate, localDate, previousDate } from "./time";
import { generateReport } from "./report";
import { cleanupOldData } from "./retention";
import { formatTelegramTime, sendTelegram, setTelegramCommands, TELEGRAM_HELP } from "./telegram";
import type { DeviceRuntimeStatus, Env, ScanDevice, ScanUpload } from "./types";

const MAX_DEVICES = 1024;
const HEALTH_STALE_AFTER_MILLIS = 3 * 60 * 1000;

const NO_SCAN_DATA_MESSAGE = [
  "No scan data yet.",
  "The Worker is deployed, but the ESP32 has not uploaded its first scan.",
  "Next: power on the ESP32, wait for Wi-Fi, then use /scan.",
].join("\n");

function privateIpv4Parts(ip: unknown): number[] | null {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isPrivateIp(ip: unknown): ip is string {
  const parts = privateIpv4Parts(ip);
  if (!parts) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function validPrivateSubnet(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const subnetParts = value.split("/");
  if (subnetParts.length !== 2) return false;
  const [network, prefixText] = subnetParts;
  const prefix = Number(prefixText);
  return isPrivateIp(network) && Number.isInteger(prefix) && prefix >= 16 && prefix <= 30;
}

function configuredDeviceId(env: Env): string {
  return env.DEVICE_ID || "esp32-monitor-01";
}

function validDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validIp(ip: unknown): ip is string {
  const parts = privateIpv4Parts(ip);
  if (!isPrivateIp(ip) || !parts) return false;
  return parts[3] >= 1 && parts[3] <= 254;
}

function validScan(value: Record<string, unknown>): value is ScanUpload {
  if (typeof value.deviceId !== "string" || !validPrivateSubnet(value.subnet) || typeof value.scanStartedAt !== "string" || typeof value.scanCompletedAt !== "string") return false;
  if (value.scanId != null && (typeof value.scanId !== "string" || !/^scan_[A-Za-z0-9_-]{1,160}$/.test(value.scanId))) return false;
  if (!["manual", "hourly", "startup", "retry"].includes(String(value.reason))) return false;
  if (!["completed", "incomplete", "failed"].includes(String(value.status))) return false;
  if (value.addressesChecked != null && (!Number.isInteger(value.addressesChecked) || Number(value.addressesChecked) < 0 || Number(value.addressesChecked) > MAX_DEVICES)) return false;
  if (!Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) return false;
  if (value.addressesChecked != null && value.devices.length > Number(value.addressesChecked)) return false;
  return value.devices.every((device) => {
    if (!device || typeof device !== "object") return false;
    const row = device as Record<string, unknown>;
    return validIp(row.ip) && typeof row.online === "boolean" && (row.latencyMs == null || typeof row.latencyMs === "number") && (row.hostname == null || typeof row.hostname === "string");
  });
}

async function enqueueScan(env: Env, deviceId: string, reason: "manual" | "hourly" | "startup" | "retry", payload: Record<string, unknown> = {}) {
  const commandId = id("cmd");
  const created = isoNow();
  const expires = new Date(Date.now() + Number(env.MAX_COMMAND_AGE_SECONDS || 900) * 1000).toISOString();
  await env.DB.prepare("INSERT INTO commands(id, device_id, type, reason, status, payload_json, created_at, expires_at) VALUES (?, ?, 'scan', ?, 'queued', ?, ?, ?)").bind(commandId, deviceId, reason, JSON.stringify(payload), created, expires).run();
  await env.DB.prepare("INSERT INTO devices(id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at").bind(deviceId, created, created).run();
  return commandId;
}

async function enqueueHealthCheck(env: Env, deviceId: string, source: "telegram_status" | "direct_api" = "telegram_status"): Promise<string> {
  const commandId = id("cmd");
  const created = isoNow();
  const expires = new Date(Date.now() + Number(env.MAX_COMMAND_AGE_SECONDS || 900) * 1000).toISOString();
  await env.DB.prepare("INSERT INTO commands(id, device_id, type, reason, status, payload_json, created_at, expires_at) VALUES (?, ?, 'health_check', 'manual', 'queued', ?, ?, ?)").bind(commandId, deviceId, JSON.stringify({ source }), created, expires).run();
  return commandId;
}

async function claimCommand(env: Env, deviceId: string): Promise<unknown | null> {
  const now = isoNow();
  const command = await env.DB.prepare("SELECT id, type, reason, payload_json, created_at, expires_at FROM commands WHERE device_id=? AND status='queued' AND expires_at >= ? ORDER BY created_at LIMIT 1").bind(deviceId, now).first<{ id: string; type: string; reason: string; payload_json: string; created_at: string; expires_at: string }>();
  if (!command) return null;
  const update = await env.DB.prepare("UPDATE commands SET status='claimed', claimed_at=? WHERE id=? AND status='queued' AND expires_at >= ?").bind(now, command.id, now).run();
  if ((update.meta.changes ?? 0) !== 1) return null;
  return { id: command.id, type: command.type, reason: command.reason, payload: JSON.parse(command.payload_json), createdAt: command.created_at, expiresAt: command.expires_at };
}

async function saveScan(env: Env, upload: ScanUpload): Promise<{ scanId: string; created: boolean }> {
  const scanId = upload.scanId ?? id("scan");
  const local = localDate(upload.scanCompletedAt, env.REPORT_TIMEZONE);
  const exists = await env.DB.prepare("SELECT id FROM scans WHERE id=?").bind(scanId).first<{ id: string }>();
  if (exists) return { scanId, created: false };
  const statements = [env.DB.prepare(`INSERT INTO scans(id, device_id, command_id, reason, status, subnet, firmware_version, started_at, completed_at, local_date, total_devices, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(scanId, upload.deviceId, upload.commandId ?? null, upload.reason, upload.status, upload.subnet, upload.firmwareVersion ?? null, upload.scanStartedAt, upload.scanCompletedAt, local, upload.addressesChecked ?? upload.devices.length, isoNow())];
  // Offline probe targets are empty address space, not devices. Persisting
  // only responses makes new sparse firmware and old full payloads compatible.
  for (const device of upload.devices.filter((item) => item.online)) {
    statements.push(env.DB.prepare("INSERT INTO scan_devices(scan_id, ip, online, latency_ms, hostname) VALUES (?, ?, 1, ?, ?)").bind(scanId, device.ip, device.latencyMs ?? null, device.hostname ?? null));
  }
  await env.DB.batch(statements);
  return { scanId, created: true };
}

async function rateLimitManual(env: Env): Promise<boolean> {
  const name = "manual-report";
  const now = Date.now();
  const row = await env.DB.prepare("SELECT window_started_at, request_count FROM rate_limits WHERE name=?").bind(name).first<{ window_started_at: number; request_count: number }>();
  const active = row && now - row.window_started_at < 60 * 60 * 1000;
  if (active && row.request_count >= 5) return false;
  const count = active ? row.request_count + 1 : 1;
  await env.DB.prepare("INSERT INTO rate_limits(name, window_started_at, request_count) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET window_started_at=excluded.window_started_at, request_count=excluded.request_count").bind(name, active ? row.window_started_at : now, count).run();
  return true;
}

async function manualReport(env: Env, request: Request): Promise<Response> {
  if (!authorized(request, env.ADMIN_API_KEY, "x-admin-key")) return json({ error: "Unauthorized" }, 401);
  const body = await bodyJson(request);
  const date = body.date ?? currentLocalDate(env.REPORT_TIMEZONE);
  if (!validDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
  const key = request.headers.get("idempotency-key");
  if (key) {
    const existing = await env.DB.prepare("SELECT result_json FROM idempotency_keys WHERE key=?").bind(key).first<{ result_json: string }>();
    if (existing) return json(JSON.parse(existing.result_json));
  }
  if (!(await rateLimitManual(env))) return json({ error: "Manual report rate limit exceeded" }, 429);
  const result = await generateReport(env.DB, env, date, false);
  if (key) await env.DB.prepare("INSERT OR REPLACE INTO idempotency_keys(key, result_json, created_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(result), isoNow()).run();
  return json(result);
}

async function sendTelegramSafely(message: string, env: Env): Promise<void> {
  try {
    await sendTelegram(message, env);
  } catch (error) {
    console.error("Telegram command notification failed", error);
  }
}

async function latestScanMessage(env: Env): Promise<string> {
  const scan = await env.DB.prepare("SELECT id, completed_at, total_devices, status, reason FROM scans ORDER BY created_at DESC LIMIT 1").first<{ id: string; completed_at: string; total_devices: number; status: string; reason: string }>();
  if (!scan) return `ESP32 Network Monitor status\n\n${NO_SCAN_DATA_MESSAGE}`;
  const online = await env.DB.prepare("SELECT COUNT(*) AS count FROM scan_devices WHERE scan_id=? AND online=1").bind(scan.id).first<{ count: number }>();
  return [
    "ESP32 Network Monitor status",
    `Last scan: ${formatTelegramTime(scan.completed_at)}`,
    `Status: ${scan.status}`,
    `Reason: ${scan.reason}`,
    `Addresses checked: ${scan.total_devices}`,
    `Online devices: ${online?.count ?? 0}`,
  ].join("\n");
}

async function deviceStatusMessage(env: Env): Promise<string> {
  const device = await env.DB.prepare("SELECT id, last_seen_at, ip, state, current_target, next_ping_at, rssi FROM devices WHERE id=?").bind(configuredDeviceId(env)).first<{ id: string; last_seen_at: string | null; ip: string | null; state: string | null; current_target: string | null; next_ping_at: string | null; rssi: number | null }>();
  if (!device?.last_seen_at) return [
    "ESP32 status",
    `Device: ${configuredDeviceId(env)}`,
    "Online: unknown",
    "State: not connected",
    "No heartbeat has been received yet.",
    "Next: power on the ESP32 and check Serial Monitor for Wi-Fi and Worker connection.",
  ].join("\n");
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(device.last_seen_at)) / 1000);
  const online = ageSeconds * 1000 <= HEALTH_STALE_AFTER_MILLIS;
  return [
    "ESP32 status",
    `Online: ${online ? "yes" : "no"}`,
    `State: ${device.state ?? "unknown"}`,
    `ESP32 IP: ${device.ip ?? "unknown"}`,
    `Current target: ${device.current_target ?? "none"}`,
    `Next ping: ${device.next_ping_at ? formatTelegramTime(device.next_ping_at) : "unknown"}`,
    `RSSI: ${device.rssi == null ? "unknown" : `${device.rssi} dBm`}`,
    `Last heartbeat: ${formatTelegramTime(device.last_seen_at)} (${Math.round(ageSeconds)}s ago)`,
  ].join("\n");
}

async function lastScanDetailsMessage(env: Env): Promise<string> {
  const scan = await env.DB.prepare("SELECT id, completed_at, status, reason, subnet, total_devices FROM scans ORDER BY created_at DESC LIMIT 1").first<{ id: string; completed_at: string; status: string; reason: string; subnet: string; total_devices: number }>();
  if (!scan) return [
    "Last scan",
    "Status: no data",
    "",
    NO_SCAN_DATA_MESSAGE,
  ].join("\n");
  const rows = await env.DB.prepare("SELECT sd.ip, sd.latency_ms, labels.hostname FROM scan_devices sd LEFT JOIN ip_hostnames labels ON labels.ip=sd.ip WHERE sd.scan_id=? AND sd.online=1 ORDER BY sd.ip").bind(scan.id).all<{ ip: string; latency_ms: number | null; hostname: string | null }>();
  const devices = rows.results ?? [];
  return [
    `Last scan: ${formatTelegramTime(scan.completed_at)}`,
    `Status: ${scan.status}`,
    `Mode: ${scan.reason}`,
    `Addresses checked: ${scan.total_devices} (${scan.subnet})`,
    "",
    `Online devices: ${devices.length}`,
    "",
    ...(devices.length > 0 ? devices.map((device) => `${device.ip}${device.hostname ? ` (${device.hostname})` : ""} — ${device.latency_ms ?? "?"} ms`) : ["None detected"]),
  ].join("\n");
}

async function deviceSupportsHealthCheck(env: Env): Promise<boolean> {
  const device = await env.DB.prepare("SELECT capabilities_json FROM devices WHERE id=?").bind(configuredDeviceId(env)).first<{ capabilities_json: string | null }>();
  if (!device?.capabilities_json) return false;
  try {
    const capabilities = JSON.parse(device.capabilities_json);
    return Array.isArray(capabilities) && capabilities.includes("health_check");
  } catch {
    return false;
  }
}

async function activeHealthCheckId(env: Env, deviceId: string): Promise<string | null> {
  const command = await env.DB.prepare("SELECT id FROM commands WHERE device_id=? AND type='health_check' AND ((status='queued' AND expires_at >= ?) OR status='claimed') LIMIT 1").bind(deviceId, isoNow()).first<{ id: string }>();
  return command?.id ?? null;
}

async function deviceIsScanning(env: Env): Promise<boolean> {
  const device = await env.DB.prepare("SELECT last_seen_at, state FROM devices WHERE id=?").bind(configuredDeviceId(env)).first<{ last_seen_at: string | null; state: string | null }>();
  return Boolean(device?.last_seen_at && device.state === "scanning" && Date.now() - Date.parse(device.last_seen_at) <= HEALTH_STALE_AFTER_MILLIS);
}

async function deviceIsBusy(env: Env): Promise<boolean> {
  const activeCommand = await env.DB.prepare("SELECT id FROM commands WHERE device_id=? AND type='scan' AND ((status='queued' AND expires_at >= ?) OR status IN ('claimed','running')) LIMIT 1").bind(configuredDeviceId(env), isoNow()).first<{ id: string }>();
  if (activeCommand) return true;
  const device = await env.DB.prepare("SELECT last_seen_at, state FROM devices WHERE id=?").bind(configuredDeviceId(env)).first<{ last_seen_at: string | null; state: string | null }>();
  if (!device || device.state !== "scanning" || !device.last_seen_at) return false;
  return Date.now() - Date.parse(device.last_seen_at) <= HEALTH_STALE_AFTER_MILLIS;
}

async function onlineDevicesMessage(env: Env): Promise<string> {
  const scan = await env.DB.prepare("SELECT id, completed_at FROM scans ORDER BY created_at DESC LIMIT 1").first<{ id: string; completed_at: string }>();
  if (!scan) return [
    "Online devices",
    "Count: 0",
    "",
    "No scan data yet; no occupied IPs have been observed.",
    "Use /scan after the ESP32 connects.",
  ].join("\n");
  const rows = await env.DB.prepare("SELECT sd.ip, sd.latency_ms, labels.hostname FROM scan_devices sd LEFT JOIN ip_hostnames labels ON labels.ip=sd.ip WHERE sd.scan_id=? AND sd.online=1 ORDER BY sd.ip LIMIT 80").bind(scan.id).all<{ ip: string; latency_ms: number | null; hostname: string | null }>();
  const devices = rows.results ?? [];
  const lines = devices.map((device) => `${device.ip}${device.hostname ? ` (${device.hostname})` : ""} — ${device.latency_ms ?? "?"} ms`);
  return [
    `Online devices — ${formatTelegramTime(scan.completed_at)}`,
    `Count: ${devices.length}`,
    "",
    ...(lines.length > 0 ? lines : ["None detected"]),
    ...(devices.length >= 80 ? ["", "Showing the first 80 devices."] : []),
  ].join("\n");
}

function validHostname(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && !/[\r\n\t]/.test(value) && !value.includes("/");
}

async function nameOnlineIp(env: Env, ip: string, hostname: string): Promise<string> {
  const scan = await env.DB.prepare("SELECT id FROM scans ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
  if (!scan) return "Cannot set hostname: no scan data exists yet. Run /scan after the ESP32 connects.";
  const online = await env.DB.prepare("SELECT ip FROM scan_devices WHERE scan_id=? AND ip=? AND online=1").bind(scan.id, ip).first<{ ip: string }>();
  if (!online) return `Cannot set hostname: ${ip} is not online in the latest scan.`;

  const now = isoNow();
  await env.DB.prepare("INSERT INTO ip_hostnames(ip, hostname, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET hostname=excluded.hostname, updated_at=excluded.updated_at").bind(ip, hostname, now, now).run();
  return `Hostname saved: ${ip} = ${hostname}`;
}

async function telegramCommand(env: Env, command: string, args: string[]): Promise<void> {
  if (command === "/help" || command === "/start") {
    await sendTelegramSafely(TELEGRAM_HELP, env);
    return;
  }
  if (command === "/status") {
    const cached = await deviceStatusMessage(env);
    if (!(await deviceSupportsHealthCheck(env)) || await deviceIsScanning(env)) {
      await sendTelegramSafely(cached, env);
      return;
    }
    if (await activeHealthCheckId(env, configuredDeviceId(env))) {
      await sendTelegramSafely(cached + "\n\nFresh status check is already queued. It will reply after the ESP32 polls.", env);
      return;
    }
    await enqueueHealthCheck(env, configuredDeviceId(env));
    await sendTelegramSafely(cached + "\n\nFresh status check requested. The ESP32 will reply after its next command poll (up to 30 seconds).", env);
    return;
  }
  if (command === "/lastscan") {
    await sendTelegramSafely(await lastScanDetailsMessage(env), env);
    return;
  }
  if (command === "/status-old") {
    await sendTelegramSafely(await latestScanMessage(env), env);
    return;
  }
  if (command === "/online") {
    await sendTelegramSafely(await onlineDevicesMessage(env), env);
    return;
  }
  if (command === "/name") {
    if (args.length < 2) {
      await sendTelegramSafely("Usage: /name <IP> <hostname>\nExample: /name 192.168.1.28 Living Room PC", env);
      return;
    }
    const ip = args[0];
    const hostname = args.slice(1).join(" ").trim();
    if (!validIp(ip)) {
      await sendTelegramSafely("Invalid IP. Use a private IPv4 address from the latest scan.", env);
      return;
    }
    if (!validHostname(hostname)) {
      await sendTelegramSafely("Invalid hostname. Use 1-64 characters without line breaks, tabs, or '/'.", env);
      return;
    }
    await sendTelegramSafely(await nameOnlineIp(env, ip, hostname), env);
    return;
  }
  if (command === "/scan") {
    if (await deviceIsBusy(env)) {
      await sendTelegramSafely("Scan request ignored: the ESP32 is already pinging the network. Please wait for the current scan to finish.", env);
      return;
    }
    const commandId = await enqueueScan(env, configuredDeviceId(env), "manual", { source: "telegram", chatId: env.TELEGRAM_CHAT_ID });
    await sendTelegramSafely([
      "Force scan started.",
      "The ESP32 is now pinging the detected local private subnet.",
      "Please wait a few minutes. I will send the result when the scan finishes.",
      `Command: ${commandId}`,
    ].join("\n"), env);
    return;
  }
  if (command === "/report") {
    if (!(await rateLimitManual(env))) {
      await sendTelegramSafely("Manual report rate limit exceeded. Please try again later.", env);
      return;
    }
    const result = await generateReport(env.DB, env, currentLocalDate(env.REPORT_TIMEZONE), false);
    // generateReport sends the report itself; this command does not send a duplicate.
    console.log("Telegram manual report completed", result.reportId);
    return;
  }
  await sendTelegramSafely("Unknown command. Send /help to see available commands.", env);
}

async function telegramWebhook(env: Env, request: Request): Promise<Response> {
  if (env.TELEGRAM_WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await bodyJson(request);
  const message = body.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return json({ ok: true });
  const messageObject = message as Record<string, unknown>;
  const chat = messageObject.chat;
  const text = messageObject.text;
  if (!chat || typeof chat !== "object" || Array.isArray(chat) || typeof text !== "string") return json({ ok: true });
  const chatId = (chat as Record<string, unknown>).id;
  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return json({ error: "Forbidden" }, 403);

  // Keep the Telegram command menu self-healing after deployment or bot reset.
  try {
    await setTelegramCommands(env);
  } catch (error) {
    console.error("Telegram menu registration failed", error);
  }

  const buttonCommand = text.trim() === "📡 Status" ? "/status" : text.trim() === "🔎 Force Scan" ? "/scan" : text.trim();
  const parts = buttonCommand.split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  await telegramCommand(env, command, parts.slice(1));
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "");
      if (request.method === "GET" && path === "/health") return json({ ok: true, service: "esp32-network-monitor" });

      if (request.method === "POST" && path === "/telegram/webhook") return telegramWebhook(env, request);

      if (request.method === "POST" && path === "/telegram/register-menu") {
        if (!authorized(request, env.ADMIN_API_KEY, "x-admin-key")) return json({ error: "Unauthorized" }, 401);
        await setTelegramCommands(env);
        return json({ ok: true, registered: true });
      }

      if (request.method === "POST" && path === "/v1/status") {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const body = await bodyJson(request);
        if (typeof body.deviceId !== "string" || !["idle", "scanning", "uploading", "error"].includes(String(body.state))) return json({ error: "Invalid device status" }, 400);
        const status = body as unknown as DeviceRuntimeStatus;
        const now = isoNow();
        await env.DB.prepare(`
          INSERT INTO devices(id, created_at, updated_at, last_seen_at, ip, state, current_target, next_ping_at, rssi, firmware_version, capabilities_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            updated_at=excluded.updated_at,
            last_seen_at=excluded.last_seen_at,
            ip=excluded.ip,
            state=excluded.state,
            current_target=excluded.current_target,
            next_ping_at=excluded.next_ping_at,
            rssi=excluded.rssi,
            firmware_version=COALESCE(excluded.firmware_version, devices.firmware_version),
            capabilities_json=COALESCE(excluded.capabilities_json, devices.capabilities_json)
        `).bind(
          status.deviceId,
          now,
          now,
          now,
          status.ip ?? null,
          status.state,
          status.currentTarget ?? null,
          status.nextPingAt ?? null,
          status.rssi ?? null,
          status.firmwareVersion ?? null,
          status.capabilities ? JSON.stringify(status.capabilities) : null,
        ).run();
        if (status.commandId) {
          const command = await env.DB.prepare("SELECT type, payload_json FROM commands WHERE id=? AND device_id=? AND status='claimed'").bind(status.commandId, status.deviceId).first<{ type: string; payload_json: string }>();
          if (command?.type === "health_check") {
            await env.DB.prepare("UPDATE commands SET status='completed', completed_at=?, result_json=? WHERE id=? AND device_id=?").bind(now, JSON.stringify({ state: status.state, ip: status.ip, receivedAt: now }), status.commandId, status.deviceId).run();
            try {
              const payload = JSON.parse(command.payload_json) as { source?: string };
              if (payload.source === "telegram_status") await sendTelegramSafely("Fresh ESP32 status\n\n" + await deviceStatusMessage(env), env);
            } catch (error) {
              console.error("Health-check Telegram notification failed", error);
            }
          }
        }
        return json({ accepted: true, receivedAt: now });
      }

      if (request.method === "POST" && path === "/v1/status-requests") {
        if (!authorized(request, env.ADMIN_API_KEY, "x-admin-key")) return json({ error: "Unauthorized" }, 401);
        const body = await bodyJson(request);
        const deviceId = typeof body.deviceId === "string" ? body.deviceId : configuredDeviceId(env);
        if (!validDeviceId(deviceId)) return json({ error: "Invalid device ID" }, 400);
        const existingCommandId = await activeHealthCheckId(env, deviceId);
        if (existingCommandId) {
          return json({ commandId: existingCommandId, status: "already_queued", duplicate: true }, 202);
        }
        const requestedAt = isoNow();
        const commandId = await enqueueHealthCheck(env, deviceId, "direct_api");
        return json({ commandId, status: "queued", duplicate: false, requestedAt }, 202);
      }

      if (request.method === "POST" && path === "/v1/scan-requests") {
        if (!authorized(request, env.ADMIN_API_KEY, "x-admin-key")) return json({ error: "Unauthorized" }, 401);
        const body = await bodyJson(request);
        const deviceId = typeof body.deviceId === "string" ? body.deviceId : configuredDeviceId(env);
        const commandId = await enqueueScan(env, deviceId, "manual");
        return json({ commandId, status: "queued" }, 202);
      }

      if (request.method === "GET" && path.match(/^\/v1\/devices\/[^/]+\/commands$/)) {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const deviceId = decodeURIComponent(path.split("/")[3]);
        return json({ command: await claimCommand(env, deviceId) });
      }

      if (request.method === "GET" && path.match(/^\/v1\/devices\/[^/]+\/last-scan$/)) {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const deviceId = decodeURIComponent(path.split("/")[3]);
        if (!validDeviceId(deviceId)) return json({ error: "Invalid device ID" }, 400);
        const scan = await env.DB.prepare(`
          SELECT completed_at, status, reason
          FROM scans
          WHERE device_id=? AND status IN ('completed', 'incomplete')
          ORDER BY completed_at DESC
          LIMIT 1
        `).bind(deviceId).first<{ completed_at: string; status: string; reason: string }>();
        if (!scan) return json({ deviceId, hasScan: false });
        const parsedTime = Date.parse(scan.completed_at);
        if (Number.isNaN(parsedTime)) return json({ error: "Stored scan timestamp is invalid" }, 500);
        return json({
          deviceId,
          hasScan: true,
          lastScanAt: scan.completed_at,
          ageSeconds: Math.max(0, Math.floor((Date.now() - parsedTime) / 1000)),
          status: scan.status,
          reason: scan.reason,
        });
      }

      if (request.method === "POST" && path === "/v1/scans") {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const body = await bodyJson(request);
        if (!validScan(body)) return json({ error: "Invalid scan payload" }, 400);
        const telegramCommand = body.commandId
          ? await env.DB.prepare("SELECT payload_json FROM commands WHERE id=? AND device_id=?").bind(body.commandId, body.deviceId).first<{ payload_json: string }>()
          : null;
        const saved = await saveScan(env, body);
        if (body.commandId) await env.DB.prepare("UPDATE commands SET status='completed', completed_at=?, result_json=? WHERE id=? AND device_id=?").bind(isoNow(), JSON.stringify({ scanId: saved.scanId }), body.commandId, body.deviceId).run();
        if (telegramCommand && saved.created) {
          try {
            const payload = JSON.parse(telegramCommand.payload_json) as { source?: string };
            if (payload.source === "telegram") {
              const online = body.devices.filter((device) => device.online);
              const lines = online.slice(0, 50).map((device) => `${device.ip} — ${device.latencyMs ?? "?"} ms`);
              await sendTelegram([
                "Force scan complete.",
                `Online devices: ${online.length}`,
                "",
                ...(lines.length > 0 ? lines : ["No ping-responsive devices detected."]),
                ...(online.length > 50 ? ["", "Showing the first 50 online devices."] : []),
              ].join("\n"), env);
            }
          } catch (error) {
            console.error("Telegram scan completion notification failed", error);
          }
        }
        return json({ accepted: true, scanId: saved.scanId, duplicate: !saved.created }, 202);
      }

      if (request.method === "POST" && path.match(/^\/v1\/commands\/[^/]+\/(complete|fail)$/)) {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const parts = path.split("/");
        const commandId = parts[3];
        const body = await bodyJson(request);
        if (typeof body.deviceId !== "string") return json({ error: "deviceId is required" }, 400);
        const status = parts[4] === "complete" ? "completed" : "failed";
        await env.DB.prepare("UPDATE commands SET status=?, completed_at=?, result_json=? WHERE id=? AND device_id=?").bind(status, isoNow(), JSON.stringify(body.result ?? {}), commandId, body.deviceId).run();
        return json({ commandId, status });
      }

      if (request.method === "GET" && path.match(/^\/v1\/commands\/[^/]+$/)) {
        if (!authorized(request, env.ADMIN_API_KEY, "x-admin-key")) return json({ error: "Unauthorized" }, 401);
        const commandId = path.split("/")[3];
        const command = await env.DB.prepare("SELECT * FROM commands WHERE id=?").bind(commandId).first();
        return command ? json(command) : json({ error: "Not found" }, 404);
      }

      if (request.method === "POST" && path === "/v1/daily-report-trigger") {
        if (!authorized(request, env.ESP32_DEVICE_TOKEN, "x-device-token")) return json({ error: "Unauthorized" }, 401);
        const body = await bodyJson(request);
        const date = body.date;
        if (!validDate(date)) return json({ error: "date is required as YYYY-MM-DD" }, 400);
        try {
          await cleanupOldData(env.DB, Number(env.DATA_RETENTION_DAYS || 7));
        } catch (error) {
          console.error("Daily data retention cleanup failed", error);
        }
        if (typeof body.deviceId === "string") {
          const now = isoNow();
          await env.DB.prepare("UPDATE devices SET updated_at=?, last_seen_at=? WHERE id=?").bind(now, now, body.deviceId).run();
        }
        const result = await generateReport(env.DB, env, previousDate(date), true);
        return json({ ...result, triggeredBy: "esp32" });
      }

      if (request.method === "POST" && path === "/v1/reports") return manualReport(env, request);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      if (error instanceof OpenRouterError) return json({ error: "AI analysis unavailable", providerStatus: error.providerStatus }, 502);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
