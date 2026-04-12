import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { backupKV } from '../../src/backup/kv';

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

describe('backupKV', () => {
  beforeEach(async () => {
    await clearKV();
    await clearBackupBucket();
  });

  it('backs up KV routes to R2 as a compressed file', async () => {
    // Seed KV with routes
    const route1 = { path: '/github', type: 'redirect', target: 'https://github.com' };
    const route2 = { path: '/docs', type: 'redirect', target: 'https://docs.example.com' };
    await env.ROUTES.put('links.example.com:/github', JSON.stringify(route1));
    await env.ROUTES.put('links.example.com:/docs', JSON.stringify(route2));

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    // Verify result metadata
    expect(result.totalRoutes).toBe(2);
    expect(result.domains).toContain('links.example.com');
    expect(result.file).toBe('daily/20260219/kv-routes.ndjson.gz');

    // Verify R2 object was written
    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBeGreaterThan(0);
  });

  it('captures routes across multiple domains', async () => {
    await env.ROUTES.put(
      'links.example.com:/github',
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );
    await env.ROUTES.put(
      'example.com:/about',
      JSON.stringify({ path: '/about', type: 'redirect', target: 'https://example.com/about' }),
    );
    await env.ROUTES.put(
      'secondary.example.net:/home',
      JSON.stringify({ path: '/home', type: 'redirect', target: 'https://secondary.example.net' }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRoutes).toBe(3);
    expect(result.domains).toContain('links.example.com');
    expect(result.domains).toContain('example.com');
    expect(result.domains).toContain('secondary.example.net');
  });

  it('handles empty KV namespace (no routes)', async () => {
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRoutes).toBe(0);
    expect(result.file).toBe('daily/20260219/kv-routes.ndjson.gz');

    // File should still exist (empty compressed content)
    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
  });

  it('writes R2 object with correct key path format', async () => {
    await env.ROUTES.put(
      'links.example.com:/test',
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const date = '20260115';
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);

    expect(result.file).toBe(`daily/${date}/kv-routes.ndjson.gz`);
    expect(result.file).toMatch(/^daily\/\d{8}\/kv-routes\.ndjson\.gz$/);
  });

  it('stores custom metadata on the R2 object', async () => {
    await env.ROUTES.put(
      'links.example.com:/test',
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toEqual(
      expect.objectContaining({
        date: '20260219',
        type: 'kv-routes',
        routeCount: '1',
      }),
    );
  });
});
