import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { backupKV } from '../../src/backup/kv';
import { SUPPORTED_DOMAINS } from '../../src/types';

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
  // backupKV iterates SUPPORTED_DOMAINS, so KV keys must use actual domain values
  const domain1 = SUPPORTED_DOMAINS[1];
  const domain2 = SUPPORTED_DOMAINS[0];
  const domain3 = SUPPORTED_DOMAINS[3];

  beforeEach(async () => {
    await clearKV();
    await clearBackupBucket();
  });

  it('backs up KV routes to R2 as a compressed file', async () => {
    // Seed KV with routes using a SUPPORTED_DOMAIN
    const route1 = { path: '/github', type: 'redirect', target: 'https://github.com' };
    const route2 = { path: '/docs', type: 'redirect', target: 'https://docs.example.com' };
    await env.ROUTES.put(`${domain1}:/github`, JSON.stringify(route1));
    await env.ROUTES.put(`${domain1}:/docs`, JSON.stringify(route2));

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    // Verify result metadata
    expect(result.totalRoutes).toBe(2);
    expect(result.domains).toContain(domain1);
    expect(result.file).toBe('daily/20260219/kv-routes.ndjson.gz');

    // Verify R2 object was written
    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBeGreaterThan(0);
  });

  it('captures routes across multiple domains', async () => {
    await env.ROUTES.put(
      `${domain1}:/github`,
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );
    await env.ROUTES.put(
      `${domain2}:/about`,
      JSON.stringify({ path: '/about', type: 'redirect', target: 'https://example.com/about' }),
    );
    await env.ROUTES.put(
      `${domain3}:/home`,
      JSON.stringify({ path: '/home', type: 'redirect', target: 'https://example.net' }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRoutes).toBe(3);
    // backupKV returns all SUPPORTED_DOMAINS in the domains array
    expect(result.domains).toContain(domain1);
    expect(result.domains).toContain(domain2);
    expect(result.domains).toContain(domain3);
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
      `${domain1}:/test`,
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const date = '20260115';
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);

    expect(result.file).toBe(`daily/${date}/kv-routes.ndjson.gz`);
    expect(result.file).toMatch(/^daily\/\d{8}\/kv-routes\.ndjson\.gz$/);
  });

  it('stores custom metadata on the R2 object', async () => {
    await env.ROUTES.put(
      `${domain1}:/test`,
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
