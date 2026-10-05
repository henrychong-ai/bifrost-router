/**
 * Backup content verification.
 * The archive is inflated with the runtime's DecompressionStream, so these
 * cases also pin what workerd's gzip decoder refuses: a truncated stream and a
 * bad CRC-32 trailer.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { gzipCompress } from '../../src/backup/compress';
import { backupArchiveKey, backupManifestKey } from '../../src/backup/constants';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  MAX_BACKUP_BYTES,
  parseBackupManifest,
  verifyArchiveBytes,
  verifyBackupArchive,
} from '../../src/backup/integrity';
import { backupKV } from '../../src/backup/kv';
import type { BackupManifest } from '../../src/backup/types';
import { clearAllRoutes } from '../helpers';
import { readBackupRecords } from './archive-records';

const date = '20261005';
const manifest: BackupManifest = {
  version: '2.0.0',
  timestamp: 1,
  date,
  kv: { domains: [], totalRoutes: 1, file: `daily/${date}/kv-routes.ndjson.gz` },
};

async function archive(text: string) {
  await env.BACKUP_BUCKET.put(manifest.kv.file, await gzipCompress(text));
}

const anyArchiveFailure = /^Backup (content verification failed|record count does not match)$/;

describe('backup manifest validation', () => {
  it('accepts a well-formed manifest for its own date and archive', () => {
    expect(backupArchiveKey(date)).toBe('daily/20261005/kv-routes.ndjson.gz');
    expect(backupManifestKey(date)).toBe('daily/20261005/manifest.json');
    expect(parseBackupManifest(manifest, date)).toEqual(manifest);
  });

  it('rejects malformed manifests and cross-date or foreign archive paths', () => {
    for (const value of [
      null,
      {},
      { ...manifest, version: '1.0.0' },
      { ...manifest, date: '20261004' },
      { ...manifest, timestamp: -1 },
      { ...manifest, kv: { ...manifest.kv, totalRoutes: -1 } },
      { ...manifest, kv: { ...manifest.kv, totalRoutes: 1.5 } },
      { ...manifest, kv: { ...manifest.kv, file: 'other/archive.gz' } },
      { ...manifest, kv: { ...manifest.kv, file: 'daily/20261004/kv-routes.ndjson.gz' } },
    ]) {
      expect(() => parseBackupManifest(value, date)).toThrow('Invalid backup manifest');
    }
  });
});

describe('backup content verification', () => {
  it('round-trips route and QR records, falsy values included, without transforming them', async () => {
    await clearAllRoutes();
    const source = [
      {
        key: 'links.example.com:/fixture',
        value: { type: 'redirect', target: 'https://example.com', enabled: false },
      },
      {
        key: 'qr:example.com:fixture',
        value: { type: 'wifi', payload: { ssid: 'fixture', password: 'fixture-only' } },
      },
      // A truthiness check used to drop these from the archive
      { key: 'example.com:/zero', value: 0 },
      { key: 'example.com:/false', value: false },
      { key: 'example.com:/empty', value: '' },
    ];
    for (const record of source) await env.ROUTES.put(record.key, JSON.stringify(record.value));
    const kv = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);
    expect(kv.totalRoutes).toBe(source.length);
    const recovered = await readBackupRecords(env.BACKUP_BUCKET, { ...manifest, kv });
    expect(new Map(recovered.map(record => [record.key, record.value]))).toEqual(
      new Map(source.map(record => [record.key, record.value])),
    );
  });

  // Each case pairs a valid record with the bad line under a count of 2, so
  // only the bad line itself can make verification fail.
  it.each([
    'not-json',
    '{}',
    '{"key":"x"}',
    '{"key":"x","value":null}',
    '{"key":"","value":1}',
    `{"key":"${'k'.repeat(513)}","value":1}`,
  ])('rejects a malformed record without exposing it: %#', async bad => {
    await archive(`{"key":"ok","value":1}\n${bad}`);
    await expect(
      readBackupRecords(env.BACKUP_BUCKET, {
        ...manifest,
        kv: { ...manifest.kv, totalRoutes: 2 },
      }),
    ).rejects.toThrow(new BackupIntegrityError(BACKUP_ERRORS.content));
  });

  it('rejects a duplicate key with its own fixed message, naming neither key nor value', async () => {
    await archive('{"key":"secret-key","value":"secret-value"}\n{"key":"secret-key","value":2}');
    const failure = readBackupRecords(env.BACKUP_BUCKET, {
      ...manifest,
      kv: { ...manifest.kv, totalRoutes: 2 },
    });
    await expect(failure).rejects.toThrow(BACKUP_ERRORS.duplicateKey);
    await expect(failure).rejects.not.toThrow(/secret/);
  });

  it('gives each check its own fixed message', () => {
    expect(new Set(Object.values(BACKUP_ERRORS)).size).toBe(Object.keys(BACKUP_ERRORS).length);
    expect(BACKUP_ERRORS.sizeLimit).toBe('Backup exceeds the size limit (MAX_BACKUP_BYTES)');
  });

  it('accepts the same two-record shape when both records are valid', async () => {
    await archive('{"key":"ok","value":1}\n{"key":"ok2","value":2}');
    expect(
      await readBackupRecords(env.BACKUP_BUCKET, {
        ...manifest,
        kv: { ...manifest.kv, totalRoutes: 2 },
      }),
    ).toEqual([
      { key: 'ok', value: 1 },
      { key: 'ok2', value: 2 },
    ]);
  });

  it('rejects a record count that differs from the manifest in either direction', async () => {
    await archive('{"key":"x","value":1}\n{"key":"y","value":2}');
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.countMismatch,
    );
    await expect(
      readBackupRecords(env.BACKUP_BUCKET, { ...manifest, kv: { ...manifest.kv, totalRoutes: 3 } }),
    ).rejects.toThrow(BACKUP_ERRORS.countMismatch);
  });

  it('accepts an archive of an empty namespace only when the count is zero', async () => {
    await archive('');
    const empty = { ...manifest, kv: { ...manifest.kv, totalRoutes: 0 } };
    expect(await readBackupRecords(env.BACKUP_BUCKET, empty)).toEqual([]);
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.countMismatch,
    );
  });

  it('rejects a missing, empty or non-gzip archive', async () => {
    await env.BACKUP_BUCKET.delete(manifest.kv.file);
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.missing,
    );
    await env.BACKUP_BUCKET.put(manifest.kv.file, '');
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.missing,
    );
    await env.BACKUP_BUCKET.put(manifest.kv.file, 'broken-gzip');
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.content,
    );
  });

  it('bounds the compressed size and the inflated size', async () => {
    await archive(JSON.stringify({ key: 'x', value: 'a'.repeat(1000) }));
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest, 1)).rejects.toThrow(
      BACKUP_ERRORS.compressedSizeLimit,
    );
    // Compressed it fits in 100 bytes; inflated it does not
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest, 100)).rejects.toThrow(
      BACKUP_ERRORS.sizeLimit,
    );
    expect(await readBackupRecords(env.BACKUP_BUCKET, manifest, 2000)).toHaveLength(1);
  });

  it('enforces the inflated cap while streaming: it stops pulling and cancels the archive', async () => {
    // Moderately compressible lines: the compressed archive fits the cap while
    // its inflated text is several times larger.
    const lines = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ key: `k${i}`, value: `${crypto.randomUUID()}-${'x'.repeat(200)}` }),
    );
    const text = lines.join('\n');
    const gzip = new Uint8Array(await gzipCompress(text));
    const cap = 256 * 1024;
    expect(gzip.byteLength).toBeLessThan(cap);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(cap * 2);

    const CHUNK = 1024;
    const totalChunks = Math.ceil(gzip.byteLength / CHUNK);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const start = pulls * CHUNK;
          pulls += 1;
          if (start >= gzip.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(gzip.slice(start, start + CHUNK));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const bucket = { get: async () => ({ size: gzip.byteLength, body }) } as unknown as R2Bucket;

    await expect(verifyBackupArchive(bucket, 'any', lines.length, cap)).rejects.toThrow(
      BACKUP_ERRORS.sizeLimit,
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(totalChunks / 2);
  });

  it('verifies count-only and reports the record count and inflated size', async () => {
    const text = '{"key":"a","value":1}\n{"key":"b","value":false}';
    await archive(text);
    // A legacy archive (no routeCount metadata) is checked against the given count
    expect(await verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 2)).toEqual({
      records: 2,
      inflatedBytes: new TextEncoder().encode(text).byteLength,
      countSource: 'manifest',
    });
    await expect(verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 3)).rejects.toThrow(
      BACKUP_ERRORS.countMismatch,
    );
  });

  it('rejects a truncated gzip stream', async () => {
    const gzip = new Uint8Array(await gzipCompress('{"key":"x","value":1}'));
    for (const cut of [9, gzip.length - 4]) {
      await env.BACKUP_BUCKET.put(manifest.kv.file, gzip.slice(0, cut));
      await expect(readBackupRecords(env.BACKUP_BUCKET, manifest), `cut ${cut}`).rejects.toThrow(
        anyArchiveFailure,
      );
    }
  });

  it('rejects a corrupted CRC-32 trailer even though the JSON still inflates', async () => {
    const bytes = new Uint8Array(await gzipCompress('{"key":"x","value":1}'));
    bytes[bytes.length - 8] ^= 1;
    await env.BACKUP_BUCKET.put(manifest.kv.file, bytes);
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.content,
    );
  });

  it('rejects bytes that are not UTF-8', async () => {
    const invalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const gzip = await new Response(
      new Blob([invalid]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    await env.BACKUP_BUCKET.put(manifest.kv.file, gzip);
    await expect(readBackupRecords(env.BACKUP_BUCKET, manifest)).rejects.toThrow(
      BACKUP_ERRORS.content,
    );
  });

  it('accepts trailing blank lines without inventing records', async () => {
    await archive('{"key":"x","value":false}\n\n');
    expect(await readBackupRecords(env.BACKUP_BUCKET, manifest)).toEqual([
      { key: 'x', value: false },
    ]);
  });
});

describe('verification before and after the write', () => {
  it('verifies archive bytes in memory with the same checks as a stored archive', async () => {
    const good = new Uint8Array(await gzipCompress('{"key":"a","value":1}\n{"key":"b","value":2}'));
    expect(await verifyArchiveBytes(good, 2)).toEqual({ records: 2, inflatedBytes: 43 });
    await expect(verifyArchiveBytes(good, 1)).rejects.toThrow(BACKUP_ERRORS.countMismatch);
    const duplicate = new Uint8Array(
      await gzipCompress('{"key":"a","value":1}\n{"key":"a","value":2}'),
    );
    await expect(verifyArchiveBytes(duplicate, 2)).rejects.toThrow(BACKUP_ERRORS.duplicateKey);
    await expect(verifyArchiveBytes(new Uint8Array(0), 0)).rejects.toThrow(BACKUP_ERRORS.missing);
    await expect(verifyArchiveBytes(good, 2, 10)).rejects.toThrow(
      BACKUP_ERRORS.compressedSizeLimit,
    );
  });

  it('checks a stored archive against its own routeCount metadata, not the caller count', async () => {
    await env.BACKUP_BUCKET.put(
      manifest.kv.file,
      await gzipCompress('{"key":"a","value":1}\n{"key":"b","value":2}'),
      { customMetadata: { routeCount: '2' } },
    );
    // The manifest says 1; the archive says 2 and holds 2
    expect(await verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 1)).toMatchObject({
      records: 2,
      countSource: 'archive',
    });

    // Metadata that disagrees with the content fails verification
    await env.BACKUP_BUCKET.put(manifest.kv.file, await gzipCompress('{"key":"a","value":1}'), {
      customMetadata: { routeCount: '2' },
    });
    await expect(verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 1)).rejects.toThrow(
      BACKUP_ERRORS.countMismatch,
    );
  });

  it('falls back to the given count when routeCount is missing or malformed', async () => {
    for (const customMetadata of [
      {},
      { routeCount: '' },
      { routeCount: '-1' },
      { routeCount: 'x' },
    ]) {
      await env.BACKUP_BUCKET.put(manifest.kv.file, await gzipCompress('{"key":"a","value":1}'), {
        customMetadata,
      });
      expect(await verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 1)).toMatchObject({
        records: 1,
        countSource: 'manifest',
      });
    }
  });

  it('reports a missing stored archive', async () => {
    await env.BACKUP_BUCKET.delete(manifest.kv.file);
    await expect(verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 1)).rejects.toThrow(
      BACKUP_ERRORS.missing,
    );
    expect(MAX_BACKUP_BYTES).toBe(16 * 1024 * 1024);
  });
});
