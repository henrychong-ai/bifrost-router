-- Migration: Add file_downloads table for R2 route analytics
-- Created: 2026-01-14

CREATE TABLE IF NOT EXISTS file_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  file_size INTEGER,
  query_string TEXT,
  referrer TEXT,
  user_agent TEXT,
  country TEXT,
  city TEXT,
  colo TEXT,
  continent TEXT,
  timezone TEXT,
  http_protocol TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_file_downloads_domain ON file_downloads(domain);
CREATE INDEX IF NOT EXISTS idx_file_downloads_path ON file_downloads(path);
CREATE INDEX IF NOT EXISTS idx_file_downloads_r2_key ON file_downloads(r2_key);
CREATE INDEX IF NOT EXISTS idx_file_downloads_created_at ON file_downloads(created_at);
