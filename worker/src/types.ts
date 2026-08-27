export interface Env {
  DB: D1Database;
  REPORT_TIMEZONE: string;
  OPENROUTER_MODEL: string;
  MAX_COMMAND_AGE_SECONDS: string;
  DATA_RETENTION_DAYS: string;
  DEVICE_ID: string;
  OPENROUTER_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ESP32_DEVICE_TOKEN: string;
  ADMIN_API_KEY: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type DeviceRuntimeStatus = {
  deviceId: string;
  commandId?: string;
  ip?: string;
  state: "idle" | "scanning" | "uploading" | "error";
  currentTarget?: string;
  nextPingAt?: string;
  rssi?: number;
  firmwareVersion?: string;
  capabilities?: string[];
};

export type ScanDevice = {
  ip: string;
  online: boolean;
  latencyMs?: number | null;
  hostname?: string | null;
};

export type ScanUpload = {
  scanId?: string;
  deviceId: string;
  commandId?: string | null;
  subnet: string;
  scanStartedAt: string;
  scanCompletedAt: string;
  reason: "manual" | "hourly" | "startup" | "retry";
  status: "completed" | "incomplete" | "failed";
  firmwareVersion?: string;
  addressesChecked?: number;
  devices: ScanDevice[];
};

export type DailySummary = {
  date: string;
  subnet: string;
  totalScans: number;
  scheduledScans: number;
  manualScans: number;
  startupScans: number;
  failedScans: number;
  completedScans: number;
  incomplete: boolean;
  firstScanAt?: string;
  lastScanAt?: string;
  devicesObserved: number;
  newDevices: string[];
  missingDevices: string[];
  unstableDevices: string[];
  devices: DeviceSummary[];
  monitor?: MonitorSummary;
};

export type MonitorSummary = {
  lastSeenAt?: string;
  state?: string;
  ip?: string;
  scheduledGapCount: number;
  longestScheduledGapMinutes?: number;
  latestScheduledScanAt?: string;
};

export type DeviceSummary = {
  ip: string;
  hostname?: string;
  onlineCount: number;
  sampleCount: number;
  uptimePercent?: number;
  firstSeen: string;
  lastSeen: string;
  averageLatencyMs?: number;
  maxLatencyMs?: number;
  transitions: number;
  trusted: boolean;
  label?: string;
};

export type AiReport = {
  health: "stable" | "degraded" | "critical" | "unknown";
  analysis: string;
  recommendations: string[];
};
