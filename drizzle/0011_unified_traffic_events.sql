-- v1.32.0 — feature-gated, privacy-bounded public-request analytics.
--
-- Apply this migration before setting UNIFIED_TRAFFIC_MODE=shadow. The stream
-- stores no IP, referrer, User-Agent, target URL, or query string, and remains
-- excluded from legacy headline totals until an operator validates cutover.

CREATE TABLE IF NOT EXISTS unified_traffic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('redirect', 'r2', 'proxy', 'service', 'not_found', 'sensitive_denied', 'system')),
  outcome TEXT NOT NULL CHECK (outcome IN ('redirect', 'success', 'client_error', 'server_error')),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  cache_status TEXT CHECK (cache_status IS NULL OR length(cache_status) BETWEEN 1 AND 32),
  country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country))),
  traffic_class TEXT NOT NULL DEFAULT 'unknown' CHECK (traffic_class IN ('browser', 'automation', 'unknown')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 120000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_unified_traffic_created_at
  ON unified_traffic_events(created_at);
CREATE INDEX IF NOT EXISTS idx_unified_traffic_domain_created_at
  ON unified_traffic_events(domain, created_at);
CREATE INDEX IF NOT EXISTS idx_unified_traffic_event_type_created_at
  ON unified_traffic_events(event_type, created_at);
