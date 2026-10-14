CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  x_handle TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_ip ON waitlist (ip_hash, created_at);
