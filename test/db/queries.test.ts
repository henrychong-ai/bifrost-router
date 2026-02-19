import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb } from '../../src/db/index';
import {
  getAnalyticsSummary,
  getClicks,
  getViews,
  getSlugStats,
  getDownloads,
  getDownloadStats,
  getProxyRequests,
  getProxyStats,
  getAuditLogs,
} from '../../src/db/queries';

/**
 * SQL helper to create all analytics tables.
 * Column definitions match the Drizzle schema in src/db/schema.ts.
 */
async function createTables(db: D1Database) {
  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS link_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_url TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      http_protocol TEXT,
      timezone TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      http_protocol TEXT,
      timezone TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS file_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      content_type TEXT,
      file_size INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      cache_status TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      target_url TEXT NOT NULL,
      response_status INTEGER,
      content_type TEXT,
      content_length INTEGER,
      query_string TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      city TEXT,
      colo TEXT,
      continent TEXT,
      timezone TEXT,
      http_protocol TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();

  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_login TEXT,
      actor_name TEXT,
      path TEXT,
      details TEXT,
      ip_address TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `)
    .run();
}

/**
 * Seed test data across two domains so domain filtering can be verified.
 * Uses a recent timestamp (now) to ensure records fall within the default 30-day window.
 */
async function seedTestData(db: D1Database) {
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;
  const oneDayAgo = now - 86400;
  const tenDaysAgo = now - 10 * 86400;
  const sixtyDaysAgo = now - 60 * 86400;

  // -- link_clicks -----------------------------------------------------------
  const clickStmt = db.prepare(
    `INSERT INTO link_clicks (domain, slug, target_url, referrer, country, city, colo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Domain A: link.example.com (5 clicks)
  await clickStmt
    .bind(
      'link.example.com',
      '/github',
      'https://github.com/your-username',
      'https://google.com',
      'SG',
      'Singapore',
      'SIN',
      now,
    )
    .run();
  await clickStmt
    .bind(
      'link.example.com',
      '/github',
      'https://github.com/your-username',
      'https://twitter.com',
      'SG',
      'Singapore',
      'SIN',
      oneHourAgo,
    )
    .run();
  await clickStmt
    .bind(
      'link.example.com',
      '/linkedin',
      'https://linkedin.com/in/example',
      null,
      'US',
      'New York',
      'EWR',
      oneDayAgo,
    )
    .run();
  await clickStmt
    .bind(
      'link.example.com',
      '/docs',
      'https://docs.example.com',
      'https://google.com',
      'MY',
      'Kuala Lumpur',
      'KUL',
      tenDaysAgo,
    )
    .run();
  await clickStmt
    .bind(
      'link.example.com',
      '/old-link',
      'https://example.com/old',
      null,
      'JP',
      'Tokyo',
      'NRT',
      sixtyDaysAgo,
    )
    .run();

  // Domain B: secondary.example.com (3 clicks)
  await clickStmt
    .bind(
      'secondary.example.com',
      '/about',
      'https://secondary.example.com/about',
      null,
      'SG',
      'Singapore',
      'SIN',
      now,
    )
    .run();
  await clickStmt
    .bind(
      'secondary.example.com',
      '/careers',
      'https://secondary.example.com/careers',
      'https://indeed.com',
      'MY',
      'Kuala Lumpur',
      'KUL',
      oneDayAgo,
    )
    .run();
  await clickStmt
    .bind(
      'secondary.example.com',
      '/old',
      'https://secondary.example.com/old',
      null,
      'US',
      'San Francisco',
      'SFO',
      sixtyDaysAgo,
    )
    .run();

  // -- page_views ------------------------------------------------------------
  const viewStmt = db.prepare(
    `INSERT INTO page_views (domain, path, referrer, country, city, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // Domain A: link.example.com (4 views)
  await viewStmt.bind('link.example.com', '/', null, 'SG', 'Singapore', now).run();
  await viewStmt
    .bind('link.example.com', '/about', 'https://google.com', 'US', 'New York', oneHourAgo)
    .run();
  await viewStmt.bind('link.example.com', '/contact', null, 'MY', 'Kuala Lumpur', tenDaysAgo).run();
  await viewStmt.bind('link.example.com', '/old-page', null, 'JP', 'Tokyo', sixtyDaysAgo).run();

  // Domain B: secondary.example.com (2 views)
  await viewStmt.bind('secondary.example.com', '/home', null, 'SG', 'Singapore', now).run();
  await viewStmt
    .bind('secondary.example.com', '/old-home', null, 'US', 'New York', sixtyDaysAgo)
    .run();

  // -- file_downloads --------------------------------------------------------
  const dlStmt = db.prepare(
    `INSERT INTO file_downloads (domain, path, r2_key, content_type, file_size, cache_status, referrer, country, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Domain A (3 downloads)
  await dlStmt
    .bind(
      'link.example.com',
      '/files/report.pdf',
      'docs/report.pdf',
      'application/pdf',
      2048000,
      'MISS',
      'https://example.com',
      'SG',
      now,
    )
    .run();
  await dlStmt
    .bind(
      'link.example.com',
      '/files/report.pdf',
      'docs/report.pdf',
      'application/pdf',
      2048000,
      'HIT',
      null,
      'US',
      oneHourAgo,
    )
    .run();
  await dlStmt
    .bind(
      'link.example.com',
      '/files/old.zip',
      'docs/old.zip',
      'application/zip',
      5000000,
      'MISS',
      null,
      'JP',
      sixtyDaysAgo,
    )
    .run();

  // Domain B (2 downloads)
  await dlStmt
    .bind(
      'secondary.example.com',
      '/files/deck.pdf',
      'secondary/deck.pdf',
      'application/pdf',
      1024000,
      'MISS',
      null,
      'MY',
      now,
    )
    .run();
  await dlStmt
    .bind(
      'secondary.example.com',
      '/files/old.pdf',
      'secondary/old.pdf',
      'application/pdf',
      512000,
      'MISS',
      null,
      'SG',
      sixtyDaysAgo,
    )
    .run();

  // -- proxy_requests --------------------------------------------------------
  const proxyStmt = db.prepare(
    `INSERT INTO proxy_requests (domain, path, target_url, response_status, content_type, content_length, referrer, country, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Domain A (3 requests)
  await proxyStmt
    .bind(
      'link.example.com',
      '/api/v1',
      'https://api.example.com/api/v1',
      200,
      'application/json',
      1024,
      null,
      'SG',
      now,
    )
    .run();
  await proxyStmt
    .bind(
      'link.example.com',
      '/api/v1',
      'https://api.example.com/api/v1',
      500,
      'application/json',
      256,
      'https://example.com',
      'US',
      oneDayAgo,
    )
    .run();
  await proxyStmt
    .bind(
      'link.example.com',
      '/api/old',
      'https://api.example.com/api/old',
      200,
      'application/json',
      512,
      null,
      'JP',
      sixtyDaysAgo,
    )
    .run();

  // Domain B (2 requests)
  await proxyStmt
    .bind(
      'secondary.example.com',
      '/api/data',
      'https://api.secondary.example.com/data',
      200,
      'application/json',
      2048,
      null,
      'MY',
      now,
    )
    .run();
  await proxyStmt
    .bind(
      'secondary.example.com',
      '/api/old',
      'https://api.secondary.example.com/old',
      404,
      'text/html',
      128,
      null,
      'SG',
      sixtyDaysAgo,
    )
    .run();

  // -- audit_logs ------------------------------------------------------------
  const auditStmt = db.prepare(
    `INSERT INTO audit_logs (domain, action, actor_login, actor_name, path, details, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Domain A (4 logs)
  await auditStmt
    .bind(
      'link.example.com',
      'create',
      'admin@example.com',
      'Admin User',
      '/github',
      '{"target":"https://github.com"}',
      '10.0.0.1',
      now,
    )
    .run();
  await auditStmt
    .bind(
      'link.example.com',
      'update',
      'admin@example.com',
      'Admin User',
      '/linkedin',
      '{"before":"old","after":"new"}',
      '10.0.0.1',
      oneHourAgo,
    )
    .run();
  await auditStmt
    .bind(
      'link.example.com',
      'delete',
      'ops@example.com',
      'Ops User',
      '/old',
      null,
      '10.0.0.2',
      tenDaysAgo,
    )
    .run();
  await auditStmt
    .bind(
      'link.example.com',
      'toggle',
      'admin@example.com',
      'Admin User',
      '/old-toggle',
      null,
      '10.0.0.1',
      sixtyDaysAgo,
    )
    .run();

  // Domain B (2 logs)
  await auditStmt
    .bind(
      'secondary.example.com',
      'create',
      'ops@secondary.example.com',
      'Ops',
      '/about',
      null,
      '10.0.1.1',
      now,
    )
    .run();
  await auditStmt
    .bind(
      'secondary.example.com',
      'seed',
      'ops@secondary.example.com',
      'Ops',
      '/seed-data',
      null,
      '10.0.1.1',
      sixtyDaysAgo,
    )
    .run();
}

describe('query functions', () => {
  beforeAll(async () => {
    await createTables(env.DB);
    await seedTestData(env.DB);
  });

  const db = createDb(env.DB);

  // ---------------------------------------------------------------------------
  // getAnalyticsSummary
  // ---------------------------------------------------------------------------
  describe('getAnalyticsSummary', () => {
    it('returns summary with no filters (all domains, default 30 days)', async () => {
      const result = await getAnalyticsSummary(db);

      expect(result.period).toBe('30d');
      expect(result.domain).toBe('all');

      // Within 30 days: 4 link.example.com clicks + 2 secondary.example.com clicks = 6
      // (excludes 1 link.example.com + 1 secondary.example.com from 60 days ago)
      expect(result.clicks.total).toBe(6);
      expect(result.clicks.uniqueSlugs).toBeGreaterThanOrEqual(1);

      // Within 30 days: 3 link.example.com views + 1 secondary.example.com view = 4
      expect(result.views.total).toBe(4);
      expect(result.views.uniquePaths).toBeGreaterThanOrEqual(1);

      expect(Array.isArray(result.topClicks)).toBe(true);
      expect(Array.isArray(result.topPages)).toBe(true);
      expect(Array.isArray(result.topCountries)).toBe(true);
      expect(Array.isArray(result.topReferrers)).toBe(true);
      expect(Array.isArray(result.clicksByDay)).toBe(true);
      expect(Array.isArray(result.viewsByDay)).toBe(true);
      expect(Array.isArray(result.recentClicks)).toBe(true);
      expect(Array.isArray(result.recentViews)).toBe(true);
    });

    it('filters by single domain', async () => {
      const result = await getAnalyticsSummary(db, { domain: 'link.example.com' });

      expect(result.domain).toBe('link.example.com');
      // 4 link.example.com clicks within 30 days
      expect(result.clicks.total).toBe(4);
      // 3 link.example.com views within 30 days
      expect(result.views.total).toBe(3);
    });

    it('filters by second domain', async () => {
      const result = await getAnalyticsSummary(db, { domain: 'secondary.example.com' });

      expect(result.domain).toBe('secondary.example.com');
      // 2 secondary.example.com clicks within 30 days
      expect(result.clicks.total).toBe(2);
      // 1 secondary.example.com view within 30 days
      expect(result.views.total).toBe(1);
    });

    it('respects days parameter', async () => {
      // 1 day should catch only the most recent items
      const result = await getAnalyticsSummary(db, { days: 1 });

      expect(result.period).toBe('1d');
      // Only now and oneHourAgo items
      expect(result.clicks.total).toBeGreaterThanOrEqual(1);
    });

    it('returns topClicks with name and count', async () => {
      const result = await getAnalyticsSummary(db, { domain: 'link.example.com' });

      expect(result.topClicks.length).toBeGreaterThanOrEqual(1);
      const top = result.topClicks[0];
      expect(top).toHaveProperty('name');
      expect(top).toHaveProperty('count');
      expect(top.count).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getClicks
  // ---------------------------------------------------------------------------
  describe('getClicks', () => {
    it('returns paginated click list with no filters', async () => {
      const result = await getClicks(db);

      // 6 clicks within 30 days (excludes 2 from 60 days ago)
      expect(result.items.length).toBe(6);
      expect(result.meta.total).toBe(6);
      expect(result.meta.limit).toBe(100);
      expect(result.meta.offset).toBe(0);
      expect(result.meta.hasMore).toBe(false);
    });

    it('filters by single domain', async () => {
      const result = await getClicks(db, { domain: 'link.example.com' });

      expect(result.items.length).toBe(4);
      expect(result.meta.total).toBe(4);
      for (const item of result.items) {
        expect(item.domain).toBe('link.example.com');
      }
    });

    it('filters by second domain', async () => {
      const result = await getClicks(db, { domain: 'secondary.example.com' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.domain).toBe('secondary.example.com');
      }
    });

    it('respects pagination (limit and offset)', async () => {
      const result = await getClicks(db, { limit: 2, offset: 0 });

      expect(result.items.length).toBe(2);
      expect(result.meta.limit).toBe(2);
      expect(result.meta.offset).toBe(0);
      expect(result.meta.hasMore).toBe(true);

      const page2 = await getClicks(db, { limit: 2, offset: 2 });
      expect(page2.items.length).toBe(2);
      expect(page2.meta.offset).toBe(2);
    });

    it('filters by slug', async () => {
      const result = await getClicks(db, { slug: '/github' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.slug).toBe('/github');
      }
    });

    it('filters by country', async () => {
      const result = await getClicks(db, { country: 'SG' });

      for (const item of result.items) {
        expect(item.country).toBe('SG');
      }
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by days parameter', async () => {
      // 90 days should include 60-day-old records
      const result = await getClicks(db, { days: 90 });

      expect(result.meta.total).toBe(8); // all 8 clicks
    });

    it('returns items ordered by created_at descending', async () => {
      const result = await getClicks(db);

      for (let i = 0; i < result.items.length - 1; i++) {
        expect(result.items[i].createdAt).toBeGreaterThanOrEqual(result.items[i + 1].createdAt);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getViews
  // ---------------------------------------------------------------------------
  describe('getViews', () => {
    it('returns paginated view list with no filters', async () => {
      const result = await getViews(db);

      // 4 views within 30 days
      expect(result.items.length).toBe(4);
      expect(result.meta.total).toBe(4);
      expect(result.meta.hasMore).toBe(false);
    });

    it('filters by single domain', async () => {
      const result = await getViews(db, { domain: 'link.example.com' });

      expect(result.items.length).toBe(3);
      for (const item of result.items) {
        expect(item.domain).toBe('link.example.com');
      }
    });

    it('filters by second domain', async () => {
      const result = await getViews(db, { domain: 'secondary.example.com' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].domain).toBe('secondary.example.com');
    });

    it('respects pagination', async () => {
      const result = await getViews(db, { limit: 2, offset: 0 });

      expect(result.items.length).toBe(2);
      expect(result.meta.hasMore).toBe(true);
    });

    it('filters by path', async () => {
      const result = await getViews(db, { path: '/' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].path).toBe('/');
    });

    it('filters by country', async () => {
      const result = await getViews(db, { country: 'SG' });

      for (const item of result.items) {
        expect(item.country).toBe('SG');
      }
    });

    it('returns items ordered by created_at descending', async () => {
      const result = await getViews(db);

      for (let i = 0; i < result.items.length - 1; i++) {
        expect(result.items[i].createdAt).toBeGreaterThanOrEqual(result.items[i + 1].createdAt);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getSlugStats
  // ---------------------------------------------------------------------------
  describe('getSlugStats', () => {
    it('returns stats for an existing slug', async () => {
      const result = await getSlugStats(db, '/github');

      expect(result.slug).toBe('/github');
      expect(result.totalClicks).toBe(2);
      expect(result.target).toBe('https://github.com/your-username');
      expect(Array.isArray(result.clicksByDay)).toBe(true);
      expect(Array.isArray(result.topCountries)).toBe(true);
      expect(Array.isArray(result.topReferrers)).toBe(true);
    });

    it('returns zero stats for non-existent slug', async () => {
      const result = await getSlugStats(db, '/nonexistent');

      expect(result.slug).toBe('/nonexistent');
      expect(result.totalClicks).toBe(0);
      expect(result.target).toBeNull();
    });

    it('filters by single domain', async () => {
      const result = await getSlugStats(db, '/about', { domain: 'secondary.example.com' });

      expect(result.totalClicks).toBe(1);
    });

    it('respects days parameter', async () => {
      // /old-link is 60 days old, outside default 30-day window
      const within30 = await getSlugStats(db, '/old-link');
      expect(within30.totalClicks).toBe(0);

      const within90 = await getSlugStats(db, '/old-link', { days: 90 });
      expect(within90.totalClicks).toBe(1);
    });

    it('returns topCountries with correct structure', async () => {
      const result = await getSlugStats(db, '/github');

      expect(result.topCountries.length).toBeGreaterThanOrEqual(1);
      expect(result.topCountries[0]).toHaveProperty('name');
      expect(result.topCountries[0]).toHaveProperty('count');
    });

    it('returns topReferrers with correct structure', async () => {
      const result = await getSlugStats(db, '/github');

      // /github has referrers: google.com and twitter.com
      expect(result.topReferrers.length).toBe(2);
      expect(result.topReferrers[0]).toHaveProperty('name');
      expect(result.topReferrers[0]).toHaveProperty('count');
    });
  });

  // ---------------------------------------------------------------------------
  // getDownloads
  // ---------------------------------------------------------------------------
  describe('getDownloads', () => {
    it('returns paginated download list with no filters', async () => {
      const result = await getDownloads(db);

      // 3 downloads within 30 days (2 link.example.com + 1 secondary.example.com, excludes 2 old)
      expect(result.items.length).toBe(3);
      expect(result.meta.total).toBe(3);
      expect(result.meta.hasMore).toBe(false);
    });

    it('filters by single domain', async () => {
      const result = await getDownloads(db, { domain: 'link.example.com' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.domain).toBe('link.example.com');
      }
    });

    it('filters by second domain', async () => {
      const result = await getDownloads(db, { domain: 'secondary.example.com' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].domain).toBe('secondary.example.com');
    });

    it('respects pagination', async () => {
      const result = await getDownloads(db, { limit: 1, offset: 0 });

      expect(result.items.length).toBe(1);
      expect(result.meta.hasMore).toBe(true);
    });

    it('filters by path', async () => {
      const result = await getDownloads(db, { path: '/files/report.pdf' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.path).toBe('/files/report.pdf');
      }
    });

    it('filters by r2Key', async () => {
      const result = await getDownloads(db, { r2Key: 'secondary/deck.pdf' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].r2Key).toBe('secondary/deck.pdf');
    });

    it('filters by country', async () => {
      const result = await getDownloads(db, { country: 'SG' });

      for (const item of result.items) {
        expect(item.country).toBe('SG');
      }
    });

    it('includes all downloads with large days parameter', async () => {
      const result = await getDownloads(db, { days: 90 });

      expect(result.meta.total).toBe(5); // all 5 downloads
    });
  });

  // ---------------------------------------------------------------------------
  // getDownloadStats
  // ---------------------------------------------------------------------------
  describe('getDownloadStats', () => {
    it('returns stats for an existing download path', async () => {
      const result = await getDownloadStats(db, '/files/report.pdf');

      expect(result.path).toBe('/files/report.pdf');
      expect(result.totalDownloads).toBe(2);
      expect(result.r2Key).toBe('docs/report.pdf');
      expect(result.totalBytes).toBe(2048000 * 2); // 2 downloads of same size
      expect(Array.isArray(result.downloadsByDay)).toBe(true);
      expect(Array.isArray(result.topCountries)).toBe(true);
      expect(Array.isArray(result.topReferrers)).toBe(true);
    });

    it('returns zero stats for non-existent path', async () => {
      const result = await getDownloadStats(db, '/nonexistent');

      expect(result.path).toBe('/nonexistent');
      expect(result.totalDownloads).toBe(0);
      expect(result.r2Key).toBeNull();
      expect(result.totalBytes).toBe(0);
    });

    it('filters by single domain', async () => {
      const result = await getDownloadStats(db, '/files/deck.pdf', {
        domain: 'secondary.example.com',
      });

      expect(result.totalDownloads).toBe(1);
    });

    it('respects days parameter', async () => {
      const within30 = await getDownloadStats(db, '/files/old.zip');
      expect(within30.totalDownloads).toBe(0);

      const within90 = await getDownloadStats(db, '/files/old.zip', { days: 90 });
      expect(within90.totalDownloads).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getProxyRequests
  // ---------------------------------------------------------------------------
  describe('getProxyRequests', () => {
    it('returns paginated proxy request list with no filters', async () => {
      const result = await getProxyRequests(db);

      // 3 within 30 days (2 link.example.com + 1 secondary.example.com, excludes 2 old)
      expect(result.items.length).toBe(3);
      expect(result.meta.total).toBe(3);
      expect(result.meta.hasMore).toBe(false);
    });

    it('filters by single domain', async () => {
      const result = await getProxyRequests(db, { domain: 'link.example.com' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.domain).toBe('link.example.com');
      }
    });

    it('filters by second domain', async () => {
      const result = await getProxyRequests(db, { domain: 'secondary.example.com' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].domain).toBe('secondary.example.com');
    });

    it('respects pagination', async () => {
      const result = await getProxyRequests(db, { limit: 1, offset: 0 });

      expect(result.items.length).toBe(1);
      expect(result.meta.hasMore).toBe(true);
    });

    it('filters by path', async () => {
      const result = await getProxyRequests(db, { path: '/api/v1' });

      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.path).toBe('/api/v1');
      }
    });

    it('filters by targetUrl', async () => {
      const result = await getProxyRequests(db, {
        targetUrl: 'https://api.secondary.example.com/data',
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0].targetUrl).toBe('https://api.secondary.example.com/data');
    });

    it('filters by country', async () => {
      const result = await getProxyRequests(db, { country: 'SG' });

      for (const item of result.items) {
        expect(item.country).toBe('SG');
      }
    });

    it('includes all requests with large days parameter', async () => {
      const result = await getProxyRequests(db, { days: 90 });

      expect(result.meta.total).toBe(5); // all 5 proxy requests
    });
  });

  // ---------------------------------------------------------------------------
  // getProxyStats
  // ---------------------------------------------------------------------------
  describe('getProxyStats', () => {
    it('returns stats for an existing proxy path', async () => {
      const result = await getProxyStats(db, '/api/v1');

      expect(result.path).toBe('/api/v1');
      expect(result.totalRequests).toBe(2);
      expect(result.targetUrl).toBe('https://api.example.com/api/v1');
      expect(Array.isArray(result.requestsByDay)).toBe(true);
      expect(Array.isArray(result.topCountries)).toBe(true);
      expect(Array.isArray(result.topReferrers)).toBe(true);
      expect(Array.isArray(result.statusCodes)).toBe(true);
    });

    it('returns zero stats for non-existent path', async () => {
      const result = await getProxyStats(db, '/nonexistent');

      expect(result.path).toBe('/nonexistent');
      expect(result.totalRequests).toBe(0);
      expect(result.targetUrl).toBeNull();
    });

    it('filters by single domain', async () => {
      const result = await getProxyStats(db, '/api/data', {
        domain: 'secondary.example.com',
      });

      expect(result.totalRequests).toBe(1);
    });

    it('returns statusCodes with correct structure', async () => {
      const result = await getProxyStats(db, '/api/v1');

      // /api/v1 has status 200 and 500
      expect(result.statusCodes.length).toBe(2);
      expect(result.statusCodes[0]).toHaveProperty('name');
      expect(result.statusCodes[0]).toHaveProperty('count');
    });

    it('respects days parameter', async () => {
      const within30 = await getProxyStats(db, '/api/old');
      expect(within30.totalRequests).toBe(0);

      const within90 = await getProxyStats(db, '/api/old', { days: 90 });
      expect(within90.totalRequests).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getAuditLogs
  // ---------------------------------------------------------------------------
  describe('getAuditLogs', () => {
    it('returns paginated audit log list with no filters', async () => {
      const result = await getAuditLogs(db);

      // 4 logs within 30 days (3 link.example.com + 1 secondary.example.com, excludes 60-day-old entries)
      expect(result.items.length).toBe(4);
      expect(result.meta.total).toBe(4);
      expect(result.meta.hasMore).toBe(false);
    });

    it('filters by single domain', async () => {
      const result = await getAuditLogs(db, { domain: 'link.example.com' });

      expect(result.items.length).toBe(3);
      for (const item of result.items) {
        expect(item.domain).toBe('link.example.com');
      }
    });

    it('filters by second domain', async () => {
      const result = await getAuditLogs(db, { domain: 'secondary.example.com' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].domain).toBe('secondary.example.com');
    });

    it('respects pagination', async () => {
      const result = await getAuditLogs(db, { limit: 2, offset: 0 });

      expect(result.items.length).toBe(2);
      expect(result.meta.hasMore).toBe(true);
    });

    it('filters by action', async () => {
      const result = await getAuditLogs(db, { action: 'create' });

      for (const item of result.items) {
        expect(item.action).toBe('create');
      }
      expect(result.items.length).toBe(2); // 1 link.example.com + 1 secondary.example.com
    });

    it('filters by actor', async () => {
      const result = await getAuditLogs(db, { actor: 'admin@example.com' });

      for (const item of result.items) {
        expect(item.actorLogin).toBe('admin@example.com');
      }
      expect(result.items.length).toBe(2); // create + update within 30 days
    });

    it('filters by path (LIKE search)', async () => {
      const result = await getAuditLogs(db, { path: 'github' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].path).toBe('/github');
    });

    it('includes all logs with large days parameter', async () => {
      const result = await getAuditLogs(db, { days: 90 });

      expect(result.meta.total).toBe(6); // all 6 audit logs
    });

    it('returns items ordered by created_at descending', async () => {
      const result = await getAuditLogs(db);

      for (let i = 0; i < result.items.length - 1; i++) {
        expect(result.items[i].createdAt).toBeGreaterThanOrEqual(result.items[i + 1].createdAt);
      }
    });
  });
});
