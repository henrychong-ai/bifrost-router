-- Add cache_status column to file_downloads table
-- Tracks whether R2 responses were served from Cloudflare Cache (HIT/MISS)

ALTER TABLE file_downloads ADD COLUMN cache_status TEXT;

-- Index for filtering by cache status
CREATE INDEX idx_file_downloads_cache_status ON file_downloads(cache_status);
