-- Audit logs for tracking admin actions
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_login TEXT,
  actor_name TEXT,
  path TEXT,
  details TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for common query patterns
CREATE INDEX idx_audit_logs_domain ON audit_logs(domain);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_actor_login ON audit_logs(actor_login);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
