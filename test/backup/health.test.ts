import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipCompress } from '../../src/backup/compress';
import { checkBackupHealth } from '../../src/backup/health';
import { MAX_BACKUP_BYTES } from '../../src/backup/integrity';
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
    list: vi.fn<(options?: R2ListOptions) => Promise<unknown>>().mockResolvedValue({
      delimitedPrefixes,
      objects: [],
      truncated: false,
      cursor: undefined,
    }),
    get: vi.fn<(key: string) => Promise<unknown>>().mockImplementation(async (key: string) => {
      if (key.endsWith('manifest.json') && manifest) {
        return {
          json: () => Promise.resolve(manifest),
        };
      }
      //: health reads the archive back, so a present archive holds
      // exactly the manifest's record count.
      if (manifest && key === manifest.kv.file && files.get(key)) {
        const data = await gzipCompress(
          Array.from({ length: manifest.kv.totalRoutes }, (_, i) =>
            JSON.stringify({ key: `fixture:${i}`, value: { target: 'https://example.com' } }),
          ).join('\n'),
        );
        return { size: data.byteLength, body: new Response(data).body };
      }
      return null;
    }),
    head: vi.fn<(key: string) => Promise<unknown>>().mockImplementation(async (key: string) => {
      const file = files.get(key);
      return file ?? null;
    }),
  } as unknown as R2Bucket;
}

/**
 * Create a valid test manifest
 */
function createTestManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  const date = overrides.date ?? '20260123';
  return {
    version: '2.0.0',
    timestamp: Date.now() - 4 * 60 * 60 * 1000, // 4 hours ago
    date: '20260123',
    kv: {
      domains: ['example.com', 'links.example.com'],
      totalRoutes: 320,
      file: `daily/${date}/kv-routes.ndjson.gz`,
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
  return files;
}

describe('checkBackupHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set current time to 2026-01-23 12:00:00 UTC
    vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
      );
    });

    it('returns critical when backup files are missing', async () => {
      const date = '20260123';
      const incompleteFiles = new Map<string, { size: number }>();
      // Only manifest, missing kv-routes
      incompleteFiles.set(`daily/${date}/manifest.json`, { size: 1234 });

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
        }),
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

      expect(health.lastBackup?.files).toHaveLength(2);
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
        f => f.key === `daily/${date}/kv-routes.ndjson.gz`,
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
      expect(health.lastBackup?.manifest?.version).toBe('2.0.0');
      expect(health.lastBackup?.manifest?.kv.totalRoutes).toBe(320);
      expect(health.lastBackup?.manifest?.kv.domains).toContain('example.com');
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

describe('backup integrity health boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks later listing pages before choosing the latest backup', async () => {
    const bucket = createMockBucket({
      manifest: createTestManifest(),
      files: createCompleteFilesMap('20260123'),
    });
    vi.mocked(bucket.list)
      .mockResolvedValueOnce({
        delimitedPrefixes: ['daily/20260101/'],
        objects: [],
        truncated: true,
        cursor: 'next',
      } as R2Objects)
      .mockResolvedValueOnce({
        delimitedPrefixes: ['daily/20260123/'],
        objects: [],
        truncated: false,
      } as R2Objects);
    expect((await checkBackupHealth(bucket)).lastBackup?.date).toBe('20260123');
    expect(bucket.list).toHaveBeenLastCalledWith({
      prefix: 'daily/',
      delimiter: '/',
      cursor: 'next',
    });
  });

  it('reports a repeated or missing cursor as critical instead of looping, throwing or certifying a partial listing', async () => {
    const repeated = createMockBucket({});
    vi.mocked(repeated.list).mockResolvedValue({
      delimitedPrefixes: [],
      objects: [],
      truncated: true,
      cursor: 'same',
    } as R2Objects);
    const missing = createMockBucket({});
    vi.mocked(missing.list).mockResolvedValue({
      delimitedPrefixes: ['daily/20260123/'],
      objects: [],
      truncated: true,
      cursor: '',
    } as R2Objects);

    for (const bucket of [repeated, missing]) {
      const health = await checkBackupHealth(bucket);
      expect(health.status).toBe('critical');
      expect(health.lastBackup).toBeNull();
      expect(health.issues).toEqual([
        { severity: 'critical', message: 'Backup listing cursor invalid' },
      ]);
    }
    // The repeated cursor was requested once more, then the listing stopped
    expect(repeated.list).toHaveBeenCalledTimes(2);
  });

  it('reads a listing page without delimitedPrefixes as no directories, not a crash', async () => {
    const bucket = createMockBucket({});
    vi.mocked(bucket.list).mockResolvedValue({
      objects: [],
      truncated: false,
    } as unknown as R2Objects);
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'No backup found in R2 bucket' },
    ]);
  });

  it('still throws a listing failure that is not a cursor problem', async () => {
    const bucket = createMockBucket({});
    vi.mocked(bucket.list).mockRejectedValue(new Error('R2 unavailable'));
    await expect(checkBackupHealth(bucket)).rejects.toThrow('R2 unavailable');
  });

  it('reports the verified archive size and record count', async () => {
    const health = await checkBackupHealth(
      createMockBucket({
        delimitedPrefixes: ['daily/20260123/'],
        manifest: createTestManifest(),
        files: createCompleteFilesMap('20260123'),
      }),
    );
    expect(health.lastBackup?.archive?.records).toBe(320);
    expect(health.lastBackup?.archive?.inflatedBytes).toBeGreaterThan(0);
    expect(health.issues.some(issue => issue.message.includes('verification cap'))).toBe(false);
  });

  it('warns once the inflated archive passes half the verification cap', async () => {
    const bucket = createMockBucket({
      delimitedPrefixes: ['daily/20260123/'],
      manifest: createTestManifest({
        kv: { domains: [], totalRoutes: 1, file: 'daily/20260123/kv-routes.ndjson.gz' },
      }),
      files: createCompleteFilesMap('20260123'),
    });
    // One record padded past 8 MiB inflated; it gzips to a few KB
    const big = await gzipCompress(
      JSON.stringify({ key: 'big', value: 'a'.repeat(MAX_BACKUP_BYTES / 2 + 1024) }),
    );
    vi.mocked(bucket.get).mockImplementation(async key =>
      key.endsWith('manifest.json')
        ? ({
            json: async () =>
              createTestManifest({
                kv: { domains: [], totalRoutes: 1, file: 'daily/20260123/kv-routes.ndjson.gz' },
              }),
          } as R2ObjectBody)
        : ({ size: big.byteLength, body: new Response(big).body } as R2ObjectBody),
    );
    const health = await checkBackupHealth(bucket);
    expect(health.lastBackup?.archive?.inflatedBytes).toBeGreaterThan(MAX_BACKUP_BYTES / 2);
    expect(health.status).toBe('warning');
    expect(health.issues).toContainEqual({
      severity: 'warning',
      message: 'Backup archive is 8.0 MiB inflated, over half the 16.0 MiB verification cap',
    });
  });

  it('reports malformed manifests, and one naming another archive, as invalid', async () => {
    for (const manifest of [
      {} as BackupManifest,
      createTestManifest({
        kv: { domains: [], totalRoutes: 1, file: 'daily/20260122/kv-routes.ndjson.gz' },
      }),
    ]) {
      const bucket = createMockBucket({ delimitedPrefixes: ['daily/20260123/'], manifest });
      const health = await checkBackupHealth(bucket);
      expect(health.checks.manifestValid).toBe(false);
      expect(health.status).toBe('critical');
    }
  });

  it('treats an empty backup file as missing', async () => {
    const files = createCompleteFilesMap('20260123');
    files.set('daily/20260123/kv-routes.ndjson.gz', { size: 0 });
    const health = await checkBackupHealth(
      createMockBucket({
        delimitedPrefixes: ['daily/20260123/'],
        manifest: createTestManifest(),
        files,
      }),
    );
    expect(health.checks.filesComplete).toBe(false);
    expect(health.status).toBe('critical');
    expect(health.issues).toContainEqual({
      severity: 'critical',
      message: 'Missing backup files: daily/20260123/kv-routes.ndjson.gz',
    });
  });

  it('reports a corrupt archive as critical even when every object exists', async () => {
    const bucket = createMockBucket({
      delimitedPrefixes: ['daily/20260123/'],
      manifest: createTestManifest(),
      files: createCompleteFilesMap('20260123'),
    });
    vi.mocked(bucket.get).mockImplementation(async key =>
      key.endsWith('manifest.json')
        ? ({ json: async () => createTestManifest() } as R2ObjectBody)
        : ({ size: 6, body: new Response('broken').body } as R2ObjectBody),
    );
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(health.issues).toContainEqual({
      severity: 'critical',
      message: 'Backup content verification failed',
    });
  });
});
