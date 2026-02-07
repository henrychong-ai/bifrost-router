-- Migration: Add proxy_requests table for proxy route analytics
-- Created: 2026-01-14

CREATE TABLE IF NOT EXISTS proxy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  target_url TEXT NOT NULL,
  response_status INTEGER,
  content_type TEXT,
  content_length INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_proxy_requests_domain ON proxy_requests(domain);
CREATE INDEX IF NOT EXISTS idx_proxy_requests_path ON proxy_requests(path);
CREATE INDEX IF NOT EXISTS idx_proxy_requests_target_url ON proxy_requests(target_url);
CREATE INDEX IF NOT EXISTS idx_proxy_requests_created_at ON proxy_requests(created_at);
