-- Analytics query optimization indexes
-- These indexes improve performance for common analytics queries

-- link_clicks indexes
CREATE INDEX IF NOT EXISTS idx_link_clicks_domain_created ON link_clicks(domain, created_at);
CREATE INDEX IF NOT EXISTS idx_link_clicks_slug ON link_clicks(slug);
CREATE INDEX IF NOT EXISTS idx_link_clicks_country ON link_clicks(country);
CREATE INDEX IF NOT EXISTS idx_link_clicks_created_at ON link_clicks(created_at);

-- page_views indexes
CREATE INDEX IF NOT EXISTS idx_page_views_domain_created ON page_views(domain, created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);
CREATE INDEX IF NOT EXISTS idx_page_views_country ON page_views(country);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);
