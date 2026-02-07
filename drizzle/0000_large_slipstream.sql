CREATE TABLE `link_clicks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`slug` text NOT NULL,
	`target_url` text NOT NULL,
	`referrer` text,
	`user_agent` text,
	`country` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_link_clicks_domain` ON `link_clicks` (`domain`);
--> statement-breakpoint
CREATE INDEX `idx_link_clicks_slug` ON `link_clicks` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_link_clicks_created_at` ON `link_clicks` (`created_at`);
--> statement-breakpoint
CREATE TABLE `page_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`path` text NOT NULL,
	`referrer` text,
	`user_agent` text,
	`country` text,
	`city` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_page_views_domain` ON `page_views` (`domain`);
--> statement-breakpoint
CREATE INDEX `idx_page_views_path` ON `page_views` (`path`);
--> statement-breakpoint
CREATE INDEX `idx_page_views_created_at` ON `page_views` (`created_at`);
