import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipCompress } from '../../src/backup/compress';
import { checkBackupHealth } from '../../src/backup/health';
import { backupKV } from '../../src/backup/kv';
import { writeManifest } from '../../src/backup/manifest';
import { handleScheduled } from '../../src/backup/scheduled';
import type { BackupManifest } from '../../src/backup/types';
import type { Bindings } from '../../src/types';

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

interface RecordedCall {
  op: string;
  name: string;
  options?: R2PutOptions;
}

/**
 * The real bucket, recording every put/get/delete (with put options); `failPut`
 * makes R2 refuse chosen puts.
 */
function recordingBucket(calls: RecordedCall[], failPut?: (key: string) => boolean): R2Bucket {
  return new Proxy(env.BACKUP_BUCKET, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'put' || property === 'get' || property === 'delete') {
        return async (key: string, ...rest: unknown[]) => {
          const name = key.split('/').pop() ?? key;
          calls.push({
            op: String(property),
            name,
            ...(property === 'put' && { options: rest[1] as R2PutOptions }),
          });
          if (property === 'put' && failPut?.(key)) throw new Error('R2 refused the put');
          return (value as (...args: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        };
      }
      return value.bind(target);
    },
  });
}

/** Today's backup date (UTC), as handleScheduled names it. */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

/** Every key in the backup bucket, sorted. */
async function bucketKeys(): Promise<string[]> {
  return (await env.BACKUP_BUCKET.list()).objects.map(o => o.key).toSorted();
}

/** Lowercase hex of `bytes`. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** An object's bytes, or null when it does not exist. */
async function readBytes(key: string): Promise<Uint8Array | null> {
  const object = await env.BACKUP_BUCKET.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

describe('handleScheduled', () => {
  beforeEach(async () => {
    await clearKV();
    await clearBackupBucket();
    // Freeze the date (only Date: timers and I/O run as normal), so a run that
    // straddles UTC midnight cannot name a different day than todayDate()
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T20:00:30Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    // The console spies some cases install
    vi.restoreAllMocks();
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
    // The frozen clock names the day
    expect(manifest.date).toBe('20261005');
    expect(todayDate()).toBe('20261005');
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

  // v1.38.0: a value that is not JSON no longer fails every nightly backup
  it('backs up the readable records past a value that is not JSON, counted in the manifest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await env.ROUTES.put(
      'links.example.com:/github',
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );
    await env.ROUTES.put('links.example.com:/broken', 'not json at all');

    const result = await handleScheduled(env as unknown as Bindings);
    expect(result.success).toBe(true);
    expect(result.manifest?.kv).toMatchObject({ totalRoutes: 1, skippedNotJson: 1 });
    const stored = await env.BACKUP_BUCKET.get(`daily/${result.manifest?.date}/manifest.json`);
    expect(await stored?.json()).toMatchObject({ kv: { totalRoutes: 1, skippedNotJson: 1 } });
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

  it('verifies in memory, then writes the archive once with sha256 and routeCount, then the manifest', async () => {
    await env.ROUTES.put(
      'qr:example.com:verified',
      JSON.stringify({ id: 'verified', type: 'text', payload: { text: 'x' } }),
    );
    const calls: RecordedCall[] = [];
    const result = await handleScheduled({
      ...env,
      BACKUP_BUCKET: recordingBucket(calls),
    } as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(calls.map(c => `${c.op} ${c.name}`)).toEqual([
      'put kv-routes.ndjson.gz',
      'put manifest.json',
    ]);
    const archiveKey = `daily/${todayDate()}/kv-routes.ndjson.gz`;
    const stored = await readBytes(archiveKey);
    // The raw digest is handed to R2, which checks the body against it
    const sent = calls[0]?.options?.sha256;
    expect(sent).toBeInstanceOf(ArrayBuffer);
    expect(hex(new Uint8Array(sent as ArrayBuffer))).toBe(await sha256Hex(stored!));
    const checksum = (await env.BACKUP_BUCKET.head(archiveKey))?.checksums.sha256;
    expect(checksum && hex(new Uint8Array(checksum))).toBe(await sha256Hex(stored!));
    expect(calls[0]?.options?.customMetadata).toEqual({
      date: todayDate(),
      type: 'kv-routes',
      routeCount: '1',
    });
    expect((await env.BACKUP_BUCKET.head(archiveKey))?.customMetadata?.['routeCount']).toBe('1');
    expect(await bucketKeys()).toEqual([archiveKey, `daily/${todayDate()}/manifest.json`]);
  });

  it('writes nothing to R2 when the in-memory verification fails', {
    timeout: 30_000,
  }, async () => {
    await env.ROUTES.put(
      'links.example.com:/first',
      JSON.stringify({ path: '/first', type: 'redirect', target: 'https://example.com/1' }),
    );
    expect((await handleScheduled(env as unknown as Bindings)).success).toBe(true);
    const date = todayDate();
    const before = {
      archive: await readBytes(`daily/${date}/kv-routes.ndjson.gz`),
      manifest: await readBytes(`daily/${date}/manifest.json`),
      keys: await bucketKeys(),
    };

    // Records that together take the serialised records past the 16 MiB cap,
    // each under the 1 MiB record line limit
    for (let i = 0; i < 17; i += 1) {
      await env.ROUTES.put(`links.example.com:/huge${i}`, JSON.stringify('a'.repeat(1_000_000)));
    }
    const calls: RecordedCall[] = [];
    const second = await handleScheduled({
      ...env,
      BACKUP_BUCKET: recordingBucket(calls),
    } as unknown as Bindings);

    expect(second.success).toBe(false);
    // Stopped while reading KV, before any gzip or verification
    expect(second.error).toBe('Backup exceeds the size limit (MAX_BACKUP_BYTES)');
    expect(calls).toEqual([]);
    expect({
      archive: await readBytes(`daily/${date}/kv-routes.ndjson.gz`),
      manifest: await readBytes(`daily/${date}/manifest.json`),
      keys: await bucketKeys(),
    }).toEqual(before);
  });

  it('leaves the earlier archive and manifest byte-identical when R2 refuses the archive put', async () => {
    await env.ROUTES.put(
      'links.example.com:/first',
      JSON.stringify({ path: '/first', type: 'redirect', target: 'https://example.com/1' }),
    );
    expect((await handleScheduled(env as unknown as Bindings)).success).toBe(true);
    const date = todayDate();
    const before = {
      archive: await readBytes(`daily/${date}/kv-routes.ndjson.gz`),
      manifest: await readBytes(`daily/${date}/manifest.json`),
      keys: await bucketKeys(),
    };

    await env.ROUTES.put(
      'links.example.com:/second',
      JSON.stringify({ path: '/second', type: 'redirect', target: 'https://example.com/2' }),
    );
    const calls: RecordedCall[] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await handleScheduled({
      ...env,
      BACKUP_BUCKET: recordingBucket(calls, key => key.endsWith('kv-routes.ndjson.gz')),
    } as unknown as Bindings);

    expect(second.success).toBe(false);
    // v1.37.1: the result is fixed text; the platform error is logged once
    expect(second.error).toBe('Storage or platform error');
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]?.[0]).toBe('[Backup] Platform error:');
    expect(errorLog.mock.calls[0]?.[1]).toMatchObject({ message: 'R2 refused the put' });
    expect(calls.map(c => `${c.op} ${c.name}`)).toEqual(['put kv-routes.ndjson.gz']);
    expect({
      archive: await readBytes(`daily/${date}/kv-routes.ndjson.gz`),
      manifest: await readBytes(`daily/${date}/manifest.json`),
      keys: await bucketKeys(),
    }).toEqual(before);
  });

  it('warns, not fails, when the manifest write fails after the archive was replaced', async () => {
    await env.ROUTES.put(
      'links.example.com:/first',
      JSON.stringify({ path: '/first', type: 'redirect', target: 'https://example.com/1' }),
    );
    expect((await handleScheduled(env as unknown as Bindings)).success).toBe(true);
    await env.ROUTES.put(
      'links.example.com:/second',
      JSON.stringify({ path: '/second', type: 'redirect', target: 'https://example.com/2' }),
    );
    const second = await handleScheduled({
      ...env,
      BACKUP_BUCKET: recordingBucket([], key => key.endsWith('manifest.json')),
    } as unknown as Bindings);
    expect(second.success).toBe(false);

    const health = await checkBackupHealth(env.BACKUP_BUCKET, { minExpectedRoutes: 0 });
    expect(health.status).toBe('warning');
    expect(health.issues).toContainEqual({
      severity: 'warning',
      message: 'Backup manifest is out of date with its archive',
    });
    expect(health.issues.some(issue => issue.severity === 'critical')).toBe(false);
    // The archive verified against its own count (2), not the stale manifest's (1)
    expect(health.lastBackup?.manifest?.kv.totalRoutes).toBe(1);
    expect(health.lastBackup?.archive?.records).toBe(2);
  });

  it('ends interleaved runs with a consistent archive and its own count; health is at worst a warning', async () => {
    const date = todayDate();
    const archiveKey = `daily/${date}/kv-routes.ndjson.gz`;
    await env.ROUTES.put(
      'links.example.com:/a',
      JSON.stringify({ path: '/a', type: 'redirect', target: 'https://example.com/a' }),
    );
    const runA = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);
    await env.ROUTES.put(
      'links.example.com:/b',
      JSON.stringify({ path: '/b', type: 'redirect', target: 'https://example.com/b' }),
    );
    const runB = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);

    // B's manifest lands first, then A's late one: the manifest is stale
    await writeManifest(env.BACKUP_BUCKET, date, runB);
    await writeManifest(env.BACKUP_BUCKET, date, runA);
    let health = await checkBackupHealth(env.BACKUP_BUCKET, { minExpectedRoutes: 0 });
    expect((await env.BACKUP_BUCKET.head(archiveKey))?.customMetadata?.['routeCount']).toBe('2');
    expect(health.lastBackup?.archive?.records).toBe(2);
    expect(health.status).toBe('warning');
    expect(health.issues).toEqual([
      { severity: 'warning', message: 'Backup manifest is out of date with its archive' },
    ]);

    // The other order agrees with the archive: healthy
    await writeManifest(env.BACKUP_BUCKET, date, runB);
    health = await checkBackupHealth(env.BACKUP_BUCKET, { minExpectedRoutes: 0 });
    expect(health.status).toBe('healthy');
    expect(health.issues).toEqual([]);
  });

  it('verifies a legacy archive without routeCount metadata against its manifest', async () => {
    const date = todayDate();
    await env.BACKUP_BUCKET.put(
      `daily/${date}/kv-routes.ndjson.gz`,
      await gzipCompress('{"key":"a","value":1}\n{"key":"b","value":2}'),
    );
    await writeManifest(env.BACKUP_BUCKET, date, {
      domains: [],
      totalRoutes: 2,
      file: `daily/${date}/kv-routes.ndjson.gz`,
    });
    const health = await checkBackupHealth(env.BACKUP_BUCKET, { minExpectedRoutes: 0 });
    expect(health.status).toBe('healthy');
    expect(health.lastBackup?.archive?.records).toBe(2);
  });

  it.each([
    [
      'a count that differs from its routeCount',
      '{"key":"a","value":1}',
      '2',
      'Backup record count does not match',
    ],
    [
      'a duplicate key',
      '{"key":"a","value":1}\n{"key":"a","value":2}',
      '2',
      'Backup contains a duplicate key',
    ],
  ])(
    'reports %s as critical, with its fixed message',
    async (_label, text, routeCount, message) => {
      const date = todayDate();
      await env.BACKUP_BUCKET.put(`daily/${date}/kv-routes.ndjson.gz`, await gzipCompress(text), {
        customMetadata: { date, type: 'kv-routes', routeCount },
      });
      await writeManifest(env.BACKUP_BUCKET, date, {
        domains: [],
        totalRoutes: 2,
        file: `daily/${date}/kv-routes.ndjson.gz`,
      });
      const health = await checkBackupHealth(env.BACKUP_BUCKET, { minExpectedRoutes: 0 });
      expect(health.status).toBe('critical');
      expect(health.issues).toContainEqual({ severity: 'critical', message });
      expect(health.lastBackup?.archive).toBeNull();
    },
  );

  it('reports correct duration', async () => {
    const result = await handleScheduled(env as unknown as Bindings);

    expect(result.success).toBe(true);
    expect(result.duration).toBeTypeOf('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
