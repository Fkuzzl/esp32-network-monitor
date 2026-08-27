import type { AiReport, DailySummary, Env } from "./types";

const HKT_TIME_ZONE = "Asia/Shanghai";

export function formatTelegramTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: HKT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}:${values.second} HKT`;
}

export function formatTelegramDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll("-", "/") : value;
}

export function formatTelegramText(value: string): string {
  const withTimes = value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, (match) => formatTelegramTime(match));
  return withTimes.replace(/(?<![\d/])\d{4}-\d{2}-\d{2}(?![T\d])/g, (match) => formatTelegramDate(match));
}

export const TELEGRAM_COMMANDS = [
  { command: "help", description: "show help and available actions" },
  { command: "status", description: "show ESP32 status" },
  { command: "scan", description: "start a force scan" },
  { command: "lastscan", description: "show the latest scan" },
  { command: "online", description: "list online devices" },
  { command: "name", description: "name an online IP" },
  { command: "report", description: "request an AI report" },
];

function shorten(value: string): string {
  return value.length <= 3900 ? value : `${value.slice(0, 3890)}\n…`;
}

export function formatTelegramReport(summary: DailySummary, report: AiReport): string {
  const recommendations = report.recommendations.length === 0 ? "None" : report.recommendations.slice(0, 2).map((item, index) => `${index + 1}. ${item}`).join("\n");
  const addresses = (label: string, values: string[]) => values.length === 0 ? `${label}: none` : `${label}: ${values.slice(0, 12).join(", ")}${values.length > 12 ? ` … (+${values.length - 12})` : ""}`;
  const dataStatus = summary.incomplete ? "incomplete" : `${summary.completedScans}/${summary.totalScans} completed`;
  return shorten([
    `Daily Network Report — ${formatTelegramDate(summary.date)}`,
    "",
    `Health: ${report.health[0].toUpperCase()}${report.health.slice(1)}`,
    `Data: ${dataStatus}`,
    `Scans: ${summary.totalScans} (hourly ${summary.scheduledScans}, manual ${summary.manualScans}, startup ${summary.startupScans})`,
    ...(summary.monitor ? [`Monitor: ${summary.monitor.state ?? "unknown"}; last contact ${summary.monitor.lastSeenAt ? formatTelegramTime(summary.monitor.lastSeenAt) : "unknown"}; scan gaps ${summary.monitor.scheduledGapCount}`] : []),
    `Responsive IPs: ${summary.devicesObserved}`,
    `New: ${summary.newDevices.length}  |  Missing: ${summary.missingDevices.length}  |  Unstable: ${summary.unstableDevices.length}`,
    addresses("New", summary.newDevices),
    addresses("Unstable", summary.unstableDevices),
    "",
    "AI analysis:",
    formatTelegramText(report.analysis),
    "",
    "Recommendations:",
    formatTelegramText(recommendations),
  ].join("\n"));
}

export function formatNoAiReport(summary: DailySummary): string {
  if (summary.totalScans === 0) {
    return [
      `Daily Network Report — ${formatTelegramDate(summary.date)}`,
      "",
      "No AI report today.",
      "Reason: no scans were uploaded.",
      "Next: power on the ESP32 and wait for the first scan upload.",
    ].join("\n");
  }

  return [
    `Daily Network Report — ${formatTelegramDate(summary.date)}`,
    "",
    "No AI report today.",
    `Reason: only ${summary.totalScans} scan was uploaded; at least 2 scans are required.`,
    "The next scan can be started with /scan.",
  ].join("\n");
}

export const TELEGRAM_HELP = [
  "ESP32 Network Monitor",
  "",
  "/scan — start a force scan and receive the result",
  "/status — show the latest scan status",
  "/online — list online IPs and latency",
  "/name <IP> <hostname> — name an online IP permanently",
  "/lastscan — show the latest scan summary",
  "/report — request one additional AI report",
  "/help — show this help",
].join("\n");

export async function sendTelegram(message: string, env: Env): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      reply_markup: {
        keyboard: [["📡 Status", "🔎 Force Scan"]],
        resize_keyboard: true,
        is_persistent: true,
      },
    }),
  });
  if (!response.ok) throw new Error(`Telegram failed: ${response.status} ${await response.text()}`);
}

export async function setTelegramCommands(env: Env): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
  });
  if (!response.ok) throw new Error(`Telegram menu registration failed: ${response.status} ${await response.text()}`);

  const menuResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatMenuButton`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      menu_button: { type: "commands" },
    }),
  });
  if (!menuResponse.ok) throw new Error(`Telegram chat menu registration failed: ${menuResponse.status} ${await menuResponse.text()}`);
}
