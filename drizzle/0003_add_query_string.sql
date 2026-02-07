-- Migration: Add query_string column to link_clicks and page_views
-- Date: 2026-01-13
-- Description: Tracks query string parameters for analytics

-- Add query_string to link_clicks
ALTER TABLE `link_clicks` ADD COLUMN `query_string` text;
--> statement-breakpoint

-- Add query_string to page_views
ALTER TABLE `page_views` ADD COLUMN `query_string` text;
