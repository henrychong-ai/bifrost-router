import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { writeManifest } from '../../src/backup/manifest';
import type { KVBackupResult, BackupManifest } from '../../src/backup/types';

/**
 * Clear all objects from the BACKUP_BUCKET
 */
async function clearBackupBucket(): Promise<void> {
  const objects = await env.BACKUP_BUCKET.list();
  for (const obj of objects.objects) {
    await env.BACKUP_BUCKET.delete(obj.key);
  }
}

describe('writeManifest', () => {
  const kvResult: KVBackupResult = {
    domains: ['link.example.com', 'example.com'],
    totalRoutes: 150,
    file: 'daily/20260219/kv-routes.ndjson.gz',
  };

  beforeEach(async () => {
    await clearBackupBucket();
  });

  it('writes a manifest JSON file to R2', async () => {
    const manifest = await writeManifest(env.BACKUP_BUCKET, '20260219', kvResult);

    // Verify the manifest was returned
    expect(manifest).toBeDefined();
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.date).toBe('20260219');

    // Verify the R2 object exists
    const obj = await env.BACKUP_BUCKET.head('daily/20260219/manifest.json');
    expect(obj).not.toBeNull();
    expect(obj!.size).toBeGreaterThan(0);
  });

  it('returns manifest with correct structure', async () => {
    const manifest = await writeManifest(env.BACKUP_BUCKET, '20260219', kvResult);

    expect(manifest.version).toBe('2.0.0');
    expect(manifest.timestamp).toBeTypeOf('number');
    expect(manifest.timestamp).toBeGreaterThan(0);
    expect(manifest.date).toBe('20260219');

    // KV section
    expect(manifest.kv.domains).toEqual(['link.example.com', 'example.com']);
    expect(manifest.kv.totalRoutes).toBe(150);
    expect(manifest.kv.file).toBe('daily/20260219/kv-routes.ndjson.gz');
  });

  it('stores manifest content that can be read back as JSON', async () => {
    await writeManifest(env.BACKUP_BUCKET, '20260219', kvResult);

    // Read the manifest back from R2
    const obj = await env.BACKUP_BUCKET.get('daily/20260219/manifest.json');
    expect(obj).not.toBeNull();

    const stored = await obj!.json<BackupManifest>();
    expect(stored.version).toBe('2.0.0');
    expect(stored.date).toBe('20260219');
    expect(stored.kv.totalRoutes).toBe(150);
  });

  it('writes R2 object with correct custom metadata', async () => {
    await writeManifest(env.BACKUP_BUCKET, '20260219', kvResult);

    const obj = await env.BACKUP_BUCKET.head('daily/20260219/manifest.json');
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toEqual({
      date: '20260219',
      type: 'manifest',
    });
  });

  it('uses the correct R2 key path format', async () => {
    const date = '20260115';
    await writeManifest(env.BACKUP_BUCKET, date, kvResult);

    const key = `daily/${date}/manifest.json`;
    const obj = await env.BACKUP_BUCKET.head(key);
    expect(obj).not.toBeNull();
  });
});
