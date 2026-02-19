import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanupOldBackups } from '../../src/backup/retention';

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
 * Seed a backup object into R2 with a given date path
 */
async function seedBackupObject(date: string, filename: string): Promise<void> {
  const key = `daily/${date}/${filename}`;
  await env.BACKUP_BUCKET.put(key, 'test-data');
}

describe('cleanupOldBackups', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await clearBackupBucket();
  });

  it('deletes backups older than the daily retention period', async () => {
    vi.useFakeTimers();
    // Set "now" to 2026-03-01
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));

    // Seed a backup from 45 days ago (2026-01-15, Thursday)
    // With 30-day daily retention, this should be deleted
    await seedBackupObject('20260115', 'kv-routes.ndjson.gz');
    await seedBackupObject('20260115', 'manifest.json');

    // Seed a recent backup (2026-02-25, Wednesday) - should be kept
    await seedBackupObject('20260225', 'kv-routes.ndjson.gz');
    await seedBackupObject('20260225', 'manifest.json');

    const result = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);

    expect(result.deleted).toHaveLength(2);
    expect(result.deleted).toContain('daily/20260115/kv-routes.ndjson.gz');
    expect(result.deleted).toContain('daily/20260115/manifest.json');

    // Verify recent backup still exists
    const recent = await env.BACKUP_BUCKET.head('daily/20260225/kv-routes.ndjson.gz');
    expect(recent).not.toBeNull();
  });

  it('keeps Sunday backups for the weekly retention period', async () => {
    vi.useFakeTimers();
    // Set "now" to 2026-03-01
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));

    // 2026-01-04 is a Sunday - 56 days ago, past daily (30) but within weekly (90)
    await seedBackupObject('20260104', 'kv-routes.ndjson.gz');

    // 2026-01-05 is a Monday - 55 days ago, past daily retention
    await seedBackupObject('20260105', 'kv-routes.ndjson.gz');

    const result = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);

    // Monday backup should be deleted (past daily retention)
    expect(result.deleted).toContain('daily/20260105/kv-routes.ndjson.gz');

    // Sunday backup should be kept (within weekly retention)
    expect(result.deleted).not.toContain('daily/20260104/kv-routes.ndjson.gz');
    const sunday = await env.BACKUP_BUCKET.head('daily/20260104/kv-routes.ndjson.gz');
    expect(sunday).not.toBeNull();
  });

  it('deletes Sunday backups older than the weekly retention period', async () => {
    vi.useFakeTimers();
    // Set "now" to 2026-06-01
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

    // 2026-01-04 is a Sunday - 148 days ago, past weekly retention (90)
    await seedBackupObject('20260104', 'kv-routes.ndjson.gz');

    const result = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);

    expect(result.deleted).toContain('daily/20260104/kv-routes.ndjson.gz');
  });

  it('returns empty list when no backups exist', async () => {
    const result = await cleanupOldBackups(env.BACKUP_BUCKET);

    expect(result.deleted).toHaveLength(0);
  });

  it('returns empty list when all backups are within retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));

    // All backups within last 30 days
    await seedBackupObject('20260210', 'kv-routes.ndjson.gz');
    await seedBackupObject('20260215', 'manifest.json');
    await seedBackupObject('20260218', 'kv-routes.ndjson.gz');

    const result = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);

    expect(result.deleted).toHaveLength(0);
  });

  it('respects custom retention periods', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));

    // 2026-02-05 = 14 days ago (Wednesday)
    await seedBackupObject('20260205', 'kv-routes.ndjson.gz');

    // With 7-day retention, this should be deleted
    const result7 = await cleanupOldBackups(env.BACKUP_BUCKET, 7, 90);
    expect(result7.deleted).toHaveLength(1);

    // Re-seed and try with 30-day retention, should be kept
    await seedBackupObject('20260205', 'kv-routes.ndjson.gz');
    const result30 = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);
    expect(result30.deleted).toHaveLength(0);
  });

  it('ignores objects with invalid date prefixes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));

    // Create an object with a non-standard prefix that does not match YYYYMMDD
    await env.BACKUP_BUCKET.put('daily/invalid/kv-routes.ndjson.gz', 'test');
    await env.BACKUP_BUCKET.put('other/20260101/kv-routes.ndjson.gz', 'test');

    const result = await cleanupOldBackups(env.BACKUP_BUCKET, 30, 90);

    // Neither should be deleted (don't match expected pattern)
    expect(result.deleted).toHaveLength(0);
  });
});
