-- Migration 0013: recently created QR codes (v1.41.0)
--
-- KV listing lags a write by about 60 s, so a QR code created moments ago can
-- be missing from MCP `list_qrs`, the REST API and other dashboard tabs.
-- v1.40.0 recorded each create in ONE shared KV key per domain
-- (`qr-recent:{domain}`), a read-modify-write: two creates on one domain at
-- the same moment could each write a list without the other's id, and KV's
-- one-write-per-key-per-second limit could refuse the second write. Here
-- every create is its own row, so concurrent creates never overwrite each
-- other (`src/db/qr-recent.ts`).
--
-- One row per INCARNATION of a code: `(domain, id, created_at)`, where
-- `created_at` is the record's own createdAt (Unix MILLISECONDS, set once by
-- the creating Worker). It is the incarnation's identity, never compared as
-- an ordering, so the clocks of different isolates never decide anything. A
-- create inserts its incarnation's row and never touches an existing one (a
-- late create write cannot revive a deleted incarnation); a delete sets
-- `deleted` on its incarnation's row, inserting it when the create's write has
-- not landed yet. `noted_at` is the writing Worker's clock when the row was
-- first written, used only for the listing window and the prune. The listing
-- merges a live row's id only when the KV record it reads is that very
-- incarnation (or cannot be read, listed as its minimal row). Rows noted
-- longer ago than the window and its margin are pruned, a bounded batch per
-- create and per delete; listing never writes.
--
-- Apply it to each environment BEFORE deploying the v1.41.0 Worker
-- (`pnpm run db:migrate:v13:prod`, or `wrangler d1 execute <database>
-- --remote --file=./drizzle/0013_qr_recent.sql`). The Worker reads and writes
-- the table best effort, so a missing table only means a new code shows once
-- KV listing catches up (a warning per create and delete, once per isolate on
-- QR listings), and a Worker rolled back to v1.40.x ignores the table.
-- Additive only and idempotent (IF NOT EXISTS), so a second apply changes
-- nothing; no backfill: the old KV key expires on its own and is no longer
-- written.

CREATE TABLE IF NOT EXISTS qr_recent (
  domain TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  noted_at INTEGER NOT NULL,
  PRIMARY KEY (domain, id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_qr_recent_domain_noted ON qr_recent(domain, noted_at);
