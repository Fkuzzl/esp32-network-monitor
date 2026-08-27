CREATE TABLE IF NOT EXISTS ip_hostnames (
  ip TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

