import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleScheduled } from '../../src/backup/scheduled';
import { SUPPORTED_DOMAINS, type Bindings } from '../../src/types';
import type { BackupManifest } from '../../src/backup/types';

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

/**
 * Clear all keys from the ROUTES KV namespace
 */
async function clearKV(): Promise<void> {
  let cursor: string | undefined;
  do {
    const result = await env.ROUTES.list({ cursor });
    for (const key of result.keys) {
      await env.ROUTES.delete(key.name);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

describe('handleScheduled', () => {
  // Create D1 tables required for backup
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
    vi.useRealTimers();
    await clearKV();
    await clearBackupBucket();
    for (const table of D1_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  // backupKV iterates SUPPORTED_DOMAINS, so KV keys must use actual domain values
  const testDomain = SUPPORTED_DOMAINS[1];

  it('completes a full backup cycle successfully', async () => {
    // Seed KV routes (must use a SUPPORTED_DOMAIN for backupKV to find it)
    await env.ROUTES.put(
      `${testDomain}:/github`,
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );

    // Seed D1 data
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO link_clicks (domain, slug, target_url, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(testDomain, '/github', 'https://github.com', now)
      .run();

    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // Verify manifest content
    const manifest = result.manifest!;
    expect(manifest.kv.totalRoutes).toBe(1);
    expect(manifest.kv.domains).toContain(testDomain);
    expect(manifest.d1.totalRows).toBe(1);
    expect(manifest.d1.tables).toHaveLength(5);
  });

  it('writes a manifest file to R2 after backup', async () => {
    const result = await handleScheduled(env as unknown as Bindings);
    expect(result.success).toBe(true);

    // Get today's date to find the manifest
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const date = `${year}${month}${day}`;

    const manifestObj = await env.BACKUP_BUCKET.get(`daily/${date}/manifest.json`);
    expect(manifestObj).not.toBeNull();

    const manifest = await manifestObj!.json<BackupManifest>();
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.date).toBe(date);
  });

  it('writes KV and D1 backup files to R2', async () => {
    await env.ROUTES.put(
      `${testDomain}:/test`,
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const result = await handleScheduled(env as unknown as Bindings);
    expect(result.success).toBe(true);

    const manifest = result.manifest!;

    // Verify KV backup file exists
    const kvObj = await env.BACKUP_BUCKET.head(manifest.kv.file);
    expect(kvObj).not.toBeNull();

    // Verify D1 backup files exist
    for (const table of D1_TABLES) {
      const d1Obj = await env.BACKUP_BUCKET.head(manifest.d1.files[table]);
      expect(d1Obj).not.toBeNull();
    }
  });

  it('succeeds with empty KV and D1', async () => {
    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.kv.totalRoutes).toBe(0);
    expect(result.manifest!.d1.totalRows).toBe(0);
  });

  it('returns error when BACKUP_BUCKET is not configured', async () => {
    // Create an env without BACKUP_BUCKET
    const envWithout = {
      ...env,
      BACKUP_BUCKET: undefined,
    } as unknown as Bindings;

    const result = await handleScheduled(envWithout);

    expect(result.success).toBe(false);
    expect(result.error).toBe('BACKUP_BUCKET not configured');
  });

  it('returns error with duration when a sub-step throws', async () => {
    // Create an env with a broken DB to trigger an error
    const brokenEnv = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('DB connection failed');
        },
      },
    } as unknown as Bindings;

    const result = await handleScheduled(brokenEnv);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection failed');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('reports correct duration', async () => {
    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.duration).toBeTypeOf('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
