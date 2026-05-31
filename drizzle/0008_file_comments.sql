-- Migration 0008: file_comments
-- Free-text note/comment per R2 file, keyed by (bucket, key).
-- Apply: wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0008_file_comments.sql
--    (and --local for local dev; target the dev DB for the develop environment)
CREATE TABLE IF NOT EXISTS `file_comments` (
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`comment` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`bucket`, `key`)
);
