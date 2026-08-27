CREATE TABLE IF NOT EXISTS daily_report_deliveries (
  report_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);
