-- Migration 0009: feedback + counters
-- The AI-actionable feedback work-queue (bug / feature / question / other). v1.26.0.
-- Apply: wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0009_feedback.sql
--    (and --local for local dev; target the dev DB for the develop environment).
-- CI does NOT auto-migrate — apply per environment via the Cloudflare API / dashboard.
CREATE TABLE IF NOT EXISTS `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`steps` text,
	`expected` text,
	`actual` text,
	`context_json` text NOT NULL,
	`screenshot_keys` text,
	`capture_key` text,
	`labels` text,
	`area` text,
	`assignee` text,
	`triage_notes` text,
	`linked_pr` text,
	`external_ref` text,
	`submitter_email` text,
	`submitter_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_feedback_short_id` ON `feedback` (`short_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_status` ON `feedback` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_type` ON `feedback` (`type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_priority` ON `feedback` (`priority`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `counters` (`name`, `value`) VALUES ('feedback', 0);
