import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleScheduled } from '../../src/backup/scheduled';
import type { Bindings } from '../../src/types';
import type { BackupManifest } from '../../src/backup/types';

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
  beforeEach(async () => {
    await clearKV();
    await clearBackupBucket();
  });

  it('completes a full backup cycle successfully', async () => {
    // Seed KV routes
    await env.ROUTES.put(
      'links.example.com:/github',
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );

    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // Verify manifest content
    const manifest = result.manifest!;
    expect(manifest.kv.totalRoutes).toBe(1);
    expect(manifest.kv.domains).toContain('links.example.com');
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
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.date).toBe(date);
  });

  it('writes KV backup file to R2', async () => {
    await env.ROUTES.put(
      'links.example.com:/test',
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const result = await handleScheduled(env as unknown as Bindings);
    expect(result.success).toBe(true);

    const manifest = result.manifest!;

    // Verify KV backup file exists
    const kvObj = await env.BACKUP_BUCKET.head(manifest.kv.file);
    expect(kvObj).not.toBeNull();
  });

  it('succeeds with empty KV', async () => {
    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.kv.totalRoutes).toBe(0);
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

  it('reports correct duration', async () => {
    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.duration).toBeTypeOf('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
