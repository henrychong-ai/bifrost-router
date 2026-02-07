-- Migration: Add enhanced analytics fields to link_clicks and page_views
-- Date: 2026-01-13
-- Description: Adds city, colo, continent, httpProtocol, timezone, and ipAddress columns

-- Add new columns to link_clicks
ALTER TABLE `link_clicks` ADD COLUMN `city` text;
--> statement-breakpoint
ALTER TABLE `link_clicks` ADD COLUMN `colo` text;
--> statement-breakpoint
ALTER TABLE `link_clicks` ADD COLUMN `continent` text;
--> statement-breakpoint
ALTER TABLE `link_clicks` ADD COLUMN `http_protocol` text;
--> statement-breakpoint
ALTER TABLE `link_clicks` ADD COLUMN `timezone` text;
--> statement-breakpoint
ALTER TABLE `link_clicks` ADD COLUMN `ip_address` text;
--> statement-breakpoint

-- Add new columns to page_views (city already exists)
ALTER TABLE `page_views` ADD COLUMN `colo` text;
--> statement-breakpoint
ALTER TABLE `page_views` ADD COLUMN `continent` text;
--> statement-breakpoint
ALTER TABLE `page_views` ADD COLUMN `http_protocol` text;
--> statement-breakpoint
ALTER TABLE `page_views` ADD COLUMN `timezone` text;
--> statement-breakpoint
ALTER TABLE `page_views` ADD COLUMN `ip_address` text;
