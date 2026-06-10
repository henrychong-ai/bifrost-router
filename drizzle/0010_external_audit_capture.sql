-- Migration 0010: external R2 operations audit capture (v1.28.0)
-- Combined external-audit-capture migration (source column + event/poller tables,
-- pre-deploy there, so the schema lands here as one migration).
-- 1. audit_logs.source — which pipeline recorded the entry:
--    'bifrost'  — Bifrost dashboard/MCP/API (existing write sites, default)
--    'r2_event' — R2 event notification consumer (external object mutations)
--    'cf_audit' — Cloudflare account audit-log poller (control-plane changes)
-- 2. r2_event_correlations — consumption marker: each Bifrost-sourced audit row
--    can absorb at most ONE object-create and ONE object-delete event, so an
--    external write seconds after a Bifrost write to the same key is not
--    swallowed by the dedup. Audit rows themselves stay immutable.
-- 3. poll_cursors — named watermark cursors (cf-audit-poll) kept in D1 to avoid
--    polluting the ROUTES KV namespace.
-- 4. r2_event_seen — event-level idempotency for the at-least-once queue:
--    a redelivered R2 event (same fingerprint) is acked without re-processing,
--    so a correlated event can never re-surface as a false "external" row and
--    an external event can never insert a duplicate. Pruned opportunistically
--    by the consumer (rows older than 7 days are dead — correlation window is
--    ±120s).
-- 5. Composite (source, created_at) index — serves both new query shapes
--    (poller idempotency guard + audit source filter) without scanning all
--    rows of a source as history accumulates.
-- Apply: wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0010_external_audit_capture.sql
--    (and --local for local dev)

ALTER TABLE audit_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'bifrost';

CREATE INDEX IF NOT EXISTS idx_audit_logs_source ON audit_logs(source);

CREATE TABLE IF NOT EXISTS r2_event_correlations (
  audit_id INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('create', 'delete')),
  event_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (audit_id, event_kind)
);

CREATE TABLE IF NOT EXISTS poll_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS r2_event_seen (
  fingerprint TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_source_created ON audit_logs(source, created_at);
