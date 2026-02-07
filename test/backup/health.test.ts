import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkBackupHealth } from '../../src/backup/health';
import type { BackupManifest } from '../../src/backup/types';

/**
 * Create a mock R2Bucket for testing
 */
function createMockBucket(options: {
  delimitedPrefixes?: string[];
  manifest?: BackupManifest | null;
  files?: Map<string, { size: number } | null>;
}) {
  const { delimitedPrefixes = [], manifest = null, files = new Map() } = options;

  return {
    list: vi.fn().mockResolvedValue({
      delimitedPrefixes,
      objects: [],
      truncated: false,
      cursor: undefined,
    }),
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key.endsWith('manifest.json') && manifest) {
        return {
          json: () => Promise.resolve(manifest),
        };
      }
      return null;
    }),
    head: vi.fn().mockImplementation(async (key: string) => {
      const file = files.get(key);
      return file ?? null;
    }),
  } as unknown as R2Bucket;
}

/**
 * Create a valid test manifest
 */
function createTestManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    version: '1.0.0',
    timestamp: Date.now() - 4 * 60 * 60 * 1000, // 4 hours ago
    date: '20260123',
    kv: {
      domains: ['example.com', 'link.example.com'],
      totalRoutes: 320,
      file: 'daily/20260123/kv-routes.ndjson.gz',
    },
    d1: {
      tables: ['link_clicks', 'page_views', 'file_downloads', 'proxy_requests', 'audit_logs'],
      totalRows: 18046,
      files: {
        link_clicks: 'daily/20260123/d1-link_clicks.ndjson.gz',
        page_views: 'daily/20260123/d1-page_views.ndjson.gz',
        file_downloads: 'daily/20260123/d1-file_downloads.ndjson.gz',
        proxy_requests: 'daily/20260123/d1-proxy_requests.ndjson.gz',
        audit_logs: 'daily/20260123/d1-audit_logs.ndjson.gz',
      },
    },
    retention: {
      daily: 30,
      weekly: 90,
    },
    ...overrides,
  };
}

/**
 * Create a complete files map for a backup
 */
function createCompleteFilesMap(date: string): Map<string, { size: number }> {
  const files = new Map<string, { size: number }>();
  files.set(`daily/${date}/manifest.json`, { size: 1234 });
  files.set(`daily/${date}/kv-routes.ndjson.gz`, { size: 45678 });
  files.set(`daily/${date}/d1-link_clicks.ndjson.gz`, { size: 123456 });
  files.set(`daily/${date}/d1-page_views.ndjson.gz`, { size: 45678 });
  files.set(`daily/${date}/d1-file_downloads.ndjson.gz`, { size: 12345 });
  files.set(`daily/${date}/d1-proxy_requests.ndjson.gz`, { size: 6789 });
  files.set(`daily/${date}/d1-audit_logs.ndjson.gz`, { size: 3456 });
  return files;
}

describe('checkBackupHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set current time to 2026-01-23 12:00:00 UTC
    vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
  });

  describe('healthy status', () => {
    it('returns healthy when backup is recent and complete', async () => {
      const date = '20260123';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('healthy');
      expect(health.issues).toHaveLength(0);
      expect(health.checks.backupExists).toBe(true);
      expect(health.checks.backupAge).toBe('ok');
      expect(health.checks.manifestValid).toBe(true);
      expect(health.checks.filesComplete).toBe(true);
      expect(health.checks.routeCountOk).toBe(true);
    });

    it('returns last backup info with correct age', async () => {
      const date = '20260122'; // Yesterday - backup runs at 20:00 UTC
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.lastBackup).not.toBeNull();
      expect(health.lastBackup?.date).toBe(date);
      // 20:00 yesterday to 12:00 today = 16 hours
      expect(health.lastBackup?.ageHours).toBeCloseTo(16, 1);
    });
  });

  describe('warning status', () => {
    it('returns warning when backup age exceeds warning threshold', async () => {
      // Set time to 21:30 UTC, which is 25.5 hours after 20:00 previous day
      vi.setSystemTime(new Date('2026-01-23T21:30:00Z'));

      const date = '20260122';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('warning');
      expect(health.checks.backupAge).toBe('warning');
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining('hours old'),
        })
      );
    });

    it('returns warning when route count is below minimum', async () => {
      const date = '20260123';
      const manifest = createTestManifest({
        date,
        kv: {
          domains: ['example.com'],
          totalRoutes: 50, // Below default minimum of 100
          file: 'daily/20260123/kv-routes.ndjson.gz',
        },
      });

      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest,
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('warning');
      expect(health.checks.routeCountOk).toBe(false);
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining('Route count'),
        })
      );
    });
  });

  describe('critical status', () => {
    it('returns critical when no backup exists', async () => {
      const bucket = createMockBucket({
        delimitedPrefixes: [],
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('critical');
      expect(health.lastBackup).toBeNull();
      expect(health.checks.backupExists).toBe(false);
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'critical',
          message: 'No backup found in R2 bucket',
        })
      );
    });

    it('returns critical when backup age exceeds critical threshold', async () => {
      // Set time to 22:30 UTC, which is 26.5 hours after 20:00 previous day
      vi.setSystemTime(new Date('2026-01-23T22:30:00Z'));

      const date = '20260122';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('critical');
      expect(health.checks.backupAge).toBe('critical');
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'critical',
          message: expect.stringContaining('hours old'),
        })
      );
    });

    it('returns critical when manifest is missing', async () => {
      const date = '20260123';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: null, // Missing manifest
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('critical');
      expect(health.checks.manifestValid).toBe(false);
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'critical',
          message: 'Backup manifest is missing or invalid',
        })
      );
    });

    it('returns critical when backup files are missing', async () => {
      const date = '20260123';
      const incompleteFiles = createCompleteFilesMap(date);
      incompleteFiles.delete(`daily/${date}/d1-link_clicks.ndjson.gz`);
      incompleteFiles.delete(`daily/${date}/d1-page_views.ndjson.gz`);

      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: incompleteFiles,
      });

      const health = await checkBackupHealth(bucket);

      expect(health.status).toBe('critical');
      expect(health.checks.filesComplete).toBe(false);
      expect(health.issues).toContainEqual(
        expect.objectContaining({
          severity: 'critical',
          message: expect.stringContaining('Missing backup files'),
        })
      );
    });
  });

  describe('configuration', () => {
    it('uses custom warning threshold', async () => {
      // Set time to 21:30 UTC - would be warning with default (25h) but not with custom (27h)
      vi.setSystemTime(new Date('2026-01-23T21:30:00Z'));

      const date = '20260122';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket, { warningAgeHours: 27 });

      expect(health.status).toBe('healthy');
      expect(health.checks.backupAge).toBe('ok');
    });

    it('uses custom minimum route count', async () => {
      const date = '20260123';
      const manifest = createTestManifest({
        date,
        kv: {
          domains: ['example.com'],
          totalRoutes: 50, // Below default minimum but above custom
          file: 'daily/20260123/kv-routes.ndjson.gz',
        },
      });

      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest,
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket, { minExpectedRoutes: 25 });

      expect(health.status).toBe('healthy');
      expect(health.checks.routeCountOk).toBe(true);
    });
  });

  describe('file status reporting', () => {
    it('reports file sizes correctly', async () => {
      const date = '20260123';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.lastBackup?.files).toHaveLength(7);
      expect(health.lastBackup?.files).toContainEqual({
        key: `daily/${date}/manifest.json`,
        size: 1234,
        exists: true,
      });
    });

    it('reports missing files with size 0', async () => {
      const date = '20260123';
      const incompleteFiles = new Map<string, { size: number }>();
      incompleteFiles.set(`daily/${date}/manifest.json`, { size: 1234 });

      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: incompleteFiles,
      });

      const health = await checkBackupHealth(bucket);

      const missingFile = health.lastBackup?.files.find(
        (f) => f.key === `daily/${date}/kv-routes.ndjson.gz`
      );
      expect(missingFile).toEqual({
        key: `daily/${date}/kv-routes.ndjson.gz`,
        size: 0,
        exists: false,
      });
    });
  });

  describe('manifest summary', () => {
    it('includes manifest summary in response', async () => {
      const date = '20260123';
      const bucket = createMockBucket({
        delimitedPrefixes: [`daily/${date}/`],
        manifest: createTestManifest({ date }),
        files: createCompleteFilesMap(date),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.lastBackup?.manifest).not.toBeNull();
      expect(health.lastBackup?.manifest?.version).toBe('1.0.0');
      expect(health.lastBackup?.manifest?.kv.totalRoutes).toBe(320);
      expect(health.lastBackup?.manifest?.kv.domains).toContain('example.com');
      expect(health.lastBackup?.manifest?.d1.totalRows).toBe(18046);
      expect(health.lastBackup?.manifest?.d1.tables).toHaveLength(5);
    });
  });

  describe('edge cases', () => {
    it('handles multiple backup dates and picks most recent', async () => {
      const bucket = createMockBucket({
        delimitedPrefixes: ['daily/20260120/', 'daily/20260122/', 'daily/20260121/'],
        manifest: createTestManifest({ date: '20260122' }),
        files: createCompleteFilesMap('20260122'),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.lastBackup?.date).toBe('20260122');
    });

    it('ignores invalid date prefixes', async () => {
      const bucket = createMockBucket({
        delimitedPrefixes: ['daily/invalid/', 'daily/20260122/', 'daily/notadate/'],
        manifest: createTestManifest({ date: '20260122' }),
        files: createCompleteFilesMap('20260122'),
      });

      const health = await checkBackupHealth(bucket);

      expect(health.lastBackup?.date).toBe('20260122');
    });
  });
});
