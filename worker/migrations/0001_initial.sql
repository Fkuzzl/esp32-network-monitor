CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  label TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('scan', 'health_check')),
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'hourly', 'startup', 'retry')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'completed', 'failed', 'expired')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS commands_device_status_idx ON commands(device_id, status, created_at);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  command_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'hourly', 'startup', 'retry')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'incomplete', 'failed')),
  subnet TEXT NOT NULL,
  firmware_version TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  total_devices INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS scans_date_idx ON scans(local_date, completed_at);

CREATE TABLE IF NOT EXISTS scan_devices (
  scan_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  online INTEGER NOT NULL,
  latency_ms REAL,
  hostname TEXT,
  PRIMARY KEY (scan_id, ip),
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS scan_devices_ip_idx ON scan_devices(ip, scan_id);

CREATE TABLE IF NOT EXISTS daily_reports (
  report_date TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  message TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_report_runs (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  message TEXT NOT NULL,
  model TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  name TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
