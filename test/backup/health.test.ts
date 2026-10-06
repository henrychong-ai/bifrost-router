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

/** A healthy-looking backup for 20260123 whose `get` misbehaves as given. */
function bucketWithGet(get: (key: string, real: R2Bucket['get']) => Promise<unknown>) {
  const bucket = createMockBucket({
    delimitedPrefixes: ['daily/20260123/'],
    manifest: createTestManifest(),
    files: createCompleteFilesMap('20260123'),
  });
  const original = vi.mocked(bucket.get).getMockImplementation();
  if (!original) throw new Error('mock bucket has no get');
  const real = ((key: string) => original(key)) as unknown as R2Bucket['get'];
  vi.mocked(bucket.get).mockImplementation(key => get(key, real) as never);
  return bucket;
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
    // The console spies some cases install
    vi.restoreAllMocks();
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

  // v1.37.1: any R2 listing or head failure is a critical issue in a 200
  // body, with a fixed message; it used to throw (a 500 from the endpoint).
  it('reports an R2 listing failure as critical with a fixed message, never a throw', async () => {
    const bucket = createMockBucket({});
    vi.mocked(bucket.list).mockRejectedValue(new Error('R2 unavailable: internal detail'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(health.lastBackup).toBeNull();
    expect(health.issues).toEqual([{ severity: 'critical', message: 'Backup listing failed' }]);
    expect(health.checks.backupExists).toBe(false);
    expect(JSON.stringify(health)).not.toContain('internal detail');
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('reports a failure on a later listing page the same way', async () => {
    const bucket = createMockBucket({});
    vi.mocked(bucket.list)
      .mockResolvedValueOnce({
        delimitedPrefixes: ['daily/20260122/'],
        objects: [],
        truncated: true,
        cursor: 'page-2',
      } as unknown as R2Objects)
      .mockRejectedValueOnce(new Error('R2 page 2 failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await checkBackupHealth(bucket)).issues).toEqual([
      { severity: 'critical', message: 'Backup listing failed' },
    ]);
  });

  it('reports an R2 head failure as critical with a fixed message, never a throw', async () => {
    const bucket = createMockBucket({
      delimitedPrefixes: ['daily/20260123/'],
      manifest: createTestManifest(),
      files: createCompleteFilesMap('20260123'),
    });
    vi.mocked(bucket.head).mockRejectedValue(new Error('R2 head timed out: internal detail'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(health.checks.filesComplete).toBe(false);
    expect(health.lastBackup?.files).toEqual([]);
    // No archive read without a complete file check
    expect(health.lastBackup?.archive).toBeNull();
    expect(health.issues).toContainEqual({
      severity: 'critical',
      message: 'Backup files could not be checked',
    });
    expect(JSON.stringify(health)).not.toContain('internal detail');
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('detects the cursor failure by class: a plain error with its text is a listing failure', async () => {
    const bucket = createMockBucket({});
    vi.mocked(bucket.list).mockRejectedValue(new Error('Backup listing cursor invalid'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await checkBackupHealth(bucket)).issues).toEqual([
      { severity: 'critical', message: 'Backup listing failed' },
    ]);
  });

  // v1.37.1: R2 failing to read the archive is a storage fault with its own
  // fixed message; it used to be reported as a content failure.
  it('reports a rejected archive GET as unreadable, logged, never as content', async () => {
    const bucket = bucketWithGet((key, real) =>
      key.endsWith('.ndjson.gz') ? Promise.reject(new Error('R2 get: internal detail')) : real(key),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'Backup archive could not be read' },
    ]);
    expect(health.lastBackup?.archive).toBeNull();
    expect(JSON.stringify(health)).not.toContain('internal detail');
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('reports an archive stream that fails mid-read as unreadable', async () => {
    const bucket = bucketWithGet(async (key, real) => {
      if (!key.endsWith('.ndjson.gz')) return real(key);
      const gzip = new Uint8Array(await gzipCompress('{"key":"a","value":1}\n'.repeat(50)));
      let sent = false;
      return {
        size: gzip.byteLength,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.error(new Error('R2 stream reset: internal detail'));
              return;
            }
            sent = true;
            controller.enqueue(gzip.slice(0, 10));
          },
        }),
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = await checkBackupHealth(bucket);
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'Backup archive could not be read' },
    ]);
  });

  it('still reports corrupt archive content as content, not as unreadable', async () => {
    const bucket = bucketWithGet(async (key, real) =>
      key.endsWith('.ndjson.gz')
        ? { size: 4, body: new Response(new Uint8Array([1, 2, 3, 4])).body }
        : real(key),
    );
    expect((await checkBackupHealth(bucket)).issues).toEqual([
      { severity: 'critical', message: 'Backup content verification failed' },
    ]);
  });

  it('tells a manifest GET failure from a missing or invalid manifest', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = bucketWithGet((key, real) =>
      key.endsWith('manifest.json')
        ? Promise.reject(new Error('R2 get: internal detail'))
        : real(key),
    );
    let health = await checkBackupHealth(failing);
    expect(health.status).toBe('critical');
    expect(health.checks.manifestValid).toBe(false);
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'Backup manifest could not be read' },
    ]);
    expect(JSON.stringify(health)).not.toContain('internal detail');
    expect(errorLog).toHaveBeenCalledOnce();

    // The body failing to read is the same R2 fault
    const unreadable = bucketWithGet((key, real) =>
      key.endsWith('manifest.json')
        ? Promise.resolve({ json: () => Promise.reject(new TypeError('body stream reset')) })
        : real(key),
    );
    health = await checkBackupHealth(unreadable);
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'Backup manifest could not be read' },
    ]);

    // A body that is not JSON is an invalid manifest, as before
    const invalid = bucketWithGet((key, real) =>
      key.endsWith('manifest.json')
        ? Promise.resolve({ json: () => Promise.reject(new SyntaxError('not JSON')) })
        : real(key),
    );
    health = await checkBackupHealth(invalid);
    expect(health.issues).toEqual([
      { severity: 'critical', message: 'Backup manifest is missing or invalid' },
    ]);
  });

  it('throws a programming error instead of reporting it as an R2 outage', async () => {
    const bucket = createMockBucket({});
    // A listing page whose delimitedPrefixes is not iterable: not an R2 failure
    vi.mocked(bucket.list).mockResolvedValue({
      delimitedPrefixes: 5,
      objects: [],
      truncated: false,
    } as unknown as R2Objects);
    await expect(checkBackupHealth(bucket)).rejects.toThrow(TypeError);
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

  it('warns once the inflated archive passes half the verification cap', {
    timeout: 30_000,
  }, async () => {
    const bucket = createMockBucket({
      delimitedPrefixes: ['daily/20260123/'],
      manifest: createTestManifest({
        kv: { domains: [], totalRoutes: 9, file: 'daily/20260123/kv-routes.ndjson.gz' },
      }),
      files: createCompleteFilesMap('20260123'),
    });
    // Nine records padded just past 8 MiB inflated, each under the 1 MiB line
    // cap (MAX_RECORD_LINE_BYTES); they gzip to a few KB
    const big = await gzipCompress(
      Array.from({ length: 9 }, (_, i) =>
        JSON.stringify({
          key: `big${i}`,
          value: 'a'.repeat(Math.ceil(MAX_BACKUP_BYTES / 18) + 200),
        }),
      ).join('\n'),
    );
    vi.mocked(bucket.get).mockImplementation(async key =>
      key.endsWith('manifest.json')
        ? ({
            json: async () =>
              createTestManifest({
                kv: { domains: [], totalRoutes: 9, file: 'daily/20260123/kv-routes.ndjson.gz' },
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
