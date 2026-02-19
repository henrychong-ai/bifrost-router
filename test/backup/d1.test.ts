import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { backupD1 } from '../../src/backup/d1';

const D1_TABLES = [
  'link_clicks',
  'page_views',
  'file_downloads',
  'proxy_requests',
  'audit_logs',
] as const;

/**
 * Clear all objects from the BACKUP_BUCKET
 */
async function clearBackupBucket(): Promise<void> {
  const objects = await env.BACKUP_BUCKET.list();
  for (const obj of objects.objects) {
    await env.BACKUP_BUCKET.delete(obj.key);
  }
}

describe('backupD1', () => {
  // Create all required D1 tables before tests
  // Column definitions match the Drizzle schema in src/db/schema.ts
  beforeAll(async () => {
    await env.DB.prepare(`
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
    `).run();

    await env.DB.prepare(`
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
    `).run();

    await env.DB.prepare(`
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
    `).run();

    await env.DB.prepare(`
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
    `).run();

    await env.DB.prepare(`
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
    `).run();
  });

  beforeEach(async () => {
    await clearBackupBucket();
    // Clear data from all tables
    for (const table of D1_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it('backs up D1 tables to R2 as compressed files', async () => {
    // Seed some data
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('link.example.com', '/github', 'https://github.com', now)
      .run();
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('link.example.com', '/docs', 'https://docs.example.com', now)
      .run();
    await env.DB.prepare(
      'INSERT INTO audit_logs (action, domain, path, actor_login, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('create', 'link.example.com', '/test', 'admin@example.com', 'Admin', now)
      .run();

    const result = await backupD1(env.DB, env.BACKUP_BUCKET, '20260219');

    // Verify result metadata
    expect(result.tables).toEqual(expect.arrayContaining(D1_TABLES as unknown as string[]));
    expect(result.totalRows).toBe(3); // 2 link_clicks + 1 audit_log
    expect(Object.keys(result.files)).toHaveLength(5); // One file per table

    // Verify R2 objects were written for each table
    for (const table of D1_TABLES) {
      const key = `daily/20260219/d1-${table}.ndjson.gz`;
      expect(result.files[table]).toBe(key);
      const obj = await env.BACKUP_BUCKET.head(key);
      expect(obj).not.toBeNull();
      expect(obj!.size).toBeGreaterThan(0);
    }
  });

  it('handles empty tables', async () => {
    const result = await backupD1(env.DB, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRows).toBe(0);
    expect(result.tables).toHaveLength(5);

    // Files should still be created for empty tables
    for (const table of D1_TABLES) {
      const key = `daily/20260219/d1-${table}.ndjson.gz`;
      const obj = await env.BACKUP_BUCKET.head(key);
      expect(obj).not.toBeNull();
    }
  });

  it('only includes recent data within the daysToBackup window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const recentTimestamp = now - 5 * 24 * 60 * 60; // 5 days ago
    const oldTimestamp = now - 60 * 24 * 60 * 60; // 60 days ago

    // Insert a recent row and an old row
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('link.example.com', '/recent', 'https://example.com', recentTimestamp)
      .run();
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('link.example.com', '/old', 'https://example.com', oldTimestamp)
      .run();

    // Backup with 30-day window (default)
    const result = await backupD1(env.DB, env.BACKUP_BUCKET, '20260219');

    // Only the recent row should be included
    expect(result.totalRows).toBe(1);
  });

  it('writes correct R2 key path format for each table', async () => {
    const date = '20260115';
    const result = await backupD1(env.DB, env.BACKUP_BUCKET, date);

    for (const table of D1_TABLES) {
      expect(result.files[table]).toBe(`daily/${date}/d1-${table}.ndjson.gz`);
    }
  });

  it('stores custom metadata on R2 objects', async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('link.example.com', '/test', 'https://example.com', now)
      .run();

    const result = await backupD1(env.DB, env.BACKUP_BUCKET, '20260219');

    const obj = await env.BACKUP_BUCKET.head(result.files.link_clicks);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toEqual(
      expect.objectContaining({
        date: '20260219',
        type: 'd1-link_clicks',
        rowCount: '1',
      }),
    );
  });
});
