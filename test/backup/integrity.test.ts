/**
 * Backup content verification.
 * The archive is inflated with the runtime's DecompressionStream, so these
 * cases also pin what workerd's gzip decoder refuses: a truncated stream, a
 * bad CRC-32 trailer, and any byte after the gzip member.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { gzipCompress } from '../../src/backup/compress';
import { backupArchiveKey, backupManifestKey } from '../../src/backup/constants';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  BackupReadError,
  INFLATE_SLICE_BYTES,
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

/** A bucket whose stored archive arrives as exactly these body chunks. */
function chunkedBucket(chunks: Uint8Array[], routeCount?: string): R2Bucket {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return {
    get: async () => ({
      size,
      customMetadata: routeCount === undefined ? {} : { routeCount },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  } as unknown as R2Bucket;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** `bytes` cut into chunks of `size` bytes (the last may be shorter). */
function split(bytes: Uint8Array, size: number): Uint8Array[] {
  return Array.from({ length: Math.ceil(bytes.byteLength / size) }, (_, i) =>
    bytes.slice(i * size, (i + 1) * size),
  );
}

async function gzipBytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await gzipCompress(text));
}

// A real R2 body arrives over time, so the pump is usually waiting in
// source.read() when verification stops, and cancelling a native stream
// rejects that pending read ("Stream was cancelled."); a JS-constructed
// stream resolves it instead, and Miniflare's local R2 delivers too fast to
// show it. These bodies are workerd-native streams (IdentityTransformStream)
// written chunk by chunk, `delayMs` apart.
function slowBucket(
  bytes: Uint8Array,
  opts: { size?: number; delayMs?: number; failAfter?: number },
): R2Bucket {
  return {
    get: async () => {
      const { readable, writable } = new IdentityTransformStream();
      const writer = writable.getWriter();
      void (async () => {
        const chunks = split(bytes, opts.size ?? 64);
        for (let sent = 0; sent < chunks.length; sent += 1) {
          await new Promise(resolve => setTimeout(resolve, opts.delayMs ?? 2));
          if (sent === opts.failAfter) {
            await writer.abort(new Error('R2 stream reset')).catch(() => undefined);
            return;
          }
          await writer.write(chunks[sent]);
        }
        await writer.close();
      })().catch(() => undefined);
      return { size: bytes.byteLength, customMetadata: {}, body: readable };
    },
  } as unknown as R2Bucket;
}

/** The error workerd rejects a read on a cancelled native stream with. */
function cancelledError(): Error {
  return new Error('Stream was cancelled.');
}

/**
 * A body whose reader hands out `chunks`, then waits; once cancelled, it
 * rejects the waiting read and every later one with "Stream was
 * cancelled.", as workerd does for its native streams. With no more data
 * coming, the pump is waiting in, or about to call, source.read() when
 * verification stops, which pins the race the timed streams above can only
 * sometimes hit.
 */
function cancelRejectingBucket(
  chunks: Uint8Array[],
): R2Bucket & { stats: { opened: number; cancels: number } } {
  const stats = { opened: 0, cancels: 0 };
  let sent = 0;
  let cancelled = false;
  let rejectWaiting: ((error: Error) => void) | undefined;
  const reader = {
    read: () => {
      if (cancelled) return Promise.reject(cancelledError());
      if (sent < chunks.length) return Promise.resolve({ done: false, value: chunks[sent++] });
      return new Promise((_resolve, reject) => {
        rejectWaiting = reject;
      });
    },
    cancel: async () => {
      stats.cancels += 1;
      cancelled = true;
      rejectWaiting?.(cancelledError());
    },
  };
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) + 8;
  return {
    stats,
    get: async () => ({
      size,
      customMetadata: {},
      body: {
        getReader: () => {
          stats.opened += 1;
          return reader;
        },
        cancel: async () => undefined,
      },
    }),
  } as unknown as R2Bucket & { stats: { opened: number; cancels: number } };
}

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

  it('enforces the inflated cap while streaming: it stops pulling and cancels the archive', {
    timeout: 30_000,
  }, async () => {
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

// backupKV writes exactly one gzip member. Anything after it, junk or a second
// member, is refused wherever the chunk boundaries fall (v1.37.1). The check is
// workerd's: its DecompressionStream fails with "Trailing bytes after end of
// compressed data" once a member has ended, and the verifier reports that, like
// every decoder error, as the fixed content failure. These cases pin it.
describe('one gzip member only (v1.37.1)', () => {
  const record = '{"key":"a","value":1}';

  it('accepts the same archive in any chunking when nothing follows it', async () => {
    const gzip = await gzipBytes(record);
    for (const chunks of [[gzip], split(gzip, 7), split(gzip, 1), [gzip, new Uint8Array(0)]]) {
      expect(await verifyBackupArchive(chunkedBucket(chunks), 'k', 1)).toMatchObject({
        records: 1,
      });
    }
  });

  it.each([
    ['inside one chunk', (gzip: Uint8Array, tail: Uint8Array) => [concat(gzip, tail)]],
    ['exactly at the end of the member', (gzip: Uint8Array, tail: Uint8Array) => [gzip, tail]],
    ['across many chunks', (gzip: Uint8Array, tail: Uint8Array) => split(concat(gzip, tail), 5)],
    ['one byte at a time', (gzip: Uint8Array, tail: Uint8Array) => split(concat(gzip, tail), 1)],
  ])('rejects trailing bytes after a valid member, split %s', async (_label, chunking) => {
    const gzip = await gzipBytes(record);
    for (const tail of [
      new TextEncoder().encode('junk'),
      new Uint8Array([0, 0, 0, 0]),
      // The first byte of a gzip header, alone
      new Uint8Array([0x1f]),
    ]) {
      await expect(
        verifyBackupArchive(chunkedBucket(chunking(gzip, tail)), 'k', 1),
      ).rejects.toThrow(BACKUP_ERRORS.content);
    }
  });

  it('rejects a second gzip member, whole or split across chunks', async () => {
    const first = await gzipBytes(record);
    for (const second of [await gzipBytes(''), await gzipBytes('\n{"key":"b","value":2}')]) {
      const both = concat(first, second);
      for (const chunks of [[both], [first, second], split(both, 9), split(both, 1)]) {
        // Whether the expected count is the first member's or both members'
        for (const count of [1, 2]) {
          await expect(
            verifyBackupArchive(chunkedBucket(chunks, String(count)), 'k', count),
          ).rejects.toThrow(BACKUP_ERRORS.content);
        }
      }
    }
  });

  it('rejects both in memory before the write and as a stored R2 object', async () => {
    const first = await gzipBytes(record);
    const twoMembers = concat(first, await gzipBytes('\n{"key":"b","value":2}'));
    const trailing = concat(first, new TextEncoder().encode('junk'));
    for (const bytes of [twoMembers, trailing]) {
      await expect(verifyArchiveBytes(bytes, 1)).rejects.toThrow(BACKUP_ERRORS.content);
      await expect(verifyArchiveBytes(bytes, 2)).rejects.toThrow(BACKUP_ERRORS.content);
      await env.BACKUP_BUCKET.put(manifest.kv.file, bytes, { customMetadata: { routeCount: '1' } });
      await expect(verifyBackupArchive(env.BACKUP_BUCKET, manifest.kv.file, 1)).rejects.toThrow(
        BACKUP_ERRORS.content,
      );
    }
  });
});

// v1.37.1: R2 failing to deliver the archive is a read failure
// (BackupReadError, with the R2 error as its cause), never a content failure.
describe('archive read failures', () => {
  it('turns a rejected R2 get into a BackupReadError carrying the cause', async () => {
    const cause = new Error('R2 get failed');
    const bucket = { get: () => Promise.reject(cause) } as unknown as R2Bucket;
    const failure = await verifyBackupArchive(bucket, 'k', 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BackupReadError);
    expect((failure as Error).message).toBe('Backup archive could not be read');
    expect((failure as Error).cause).toBe(cause);
  });

  it('turns a body that fails mid-stream into a BackupReadError, wherever it fails', async () => {
    const gzip = await gzipBytes('{"key":"a","value":1}\n'.repeat(200));
    for (const sentChunks of [0, 1, 3]) {
      const chunks = split(gzip, 16);
      let sent = 0;
      const cause = new Error('R2 stream reset');
      const bucket = {
        get: async () => ({
          size: gzip.byteLength,
          customMetadata: {},
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === sentChunks) {
                controller.error(cause);
                return;
              }
              controller.enqueue(chunks[sent]);
              sent += 1;
            },
          }),
        }),
      } as unknown as R2Bucket;
      const failure = await verifyBackupArchive(bucket, 'k', 200).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `after ${sentChunks} chunks`).toBeInstanceOf(BackupReadError);
      expect((failure as Error).cause).toBe(cause);
    }
  });

  it('keeps the fixed message when cancelling a refused body rejects', async () => {
    for (const [size, message] of [
      [0, BACKUP_ERRORS.missing],
      [MAX_BACKUP_BYTES + 1, BACKUP_ERRORS.compressedSizeLimit],
    ] as const) {
      let cancels = 0;
      const body = {
        cancel: () => {
          cancels += 1;
          return Promise.reject(new Error('stream already errored'));
        },
      };
      const bucket = {
        get: async () => ({ size, customMetadata: {}, body }),
      } as unknown as R2Bucket;
      await expect(verifyBackupArchive(bucket, 'k', 1)).rejects.toThrow(message);
      expect(cancels).toBe(1);
    }
  });

  it('reports an integrity failure, not a read failure, when it stops a slow stream early', {
    timeout: 30_000,
  }, async () => {
    const line = '{"key":"k","value":"' + 'x'.repeat(200) + '"}';
    const many = Array.from({ length: 400 }, (_, i) => line.replace('"k"', `"k${i}"`)).join('\n');
    const gzip = await gzipBytes(many);
    // Inflated cap: passed long before the body ends
    await expect(
      verifyBackupArchive(slowBucket(gzip, { size: 32 }), 'k', 400, gzip.byteLength + 1),
    ).rejects.toThrow(BACKUP_ERRORS.sizeLimit);
    // Count: the second record already exceeds an expected count of one
    await expect(verifyBackupArchive(slowBucket(gzip, { size: 32 }), 'k', 1)).rejects.toThrow(
      BACKUP_ERRORS.countMismatch,
    );
    // Content: a bad record near the start of a long archive
    const corrupt = await gzipBytes(`not json\n${many}`);
    await expect(verifyBackupArchive(slowBucket(corrupt, { size: 32 }), 'k', 401)).rejects.toThrow(
      BACKUP_ERRORS.content,
    );
  });

  it('still reports a slow stream that fails mid-read as a read failure', {
    timeout: 30_000,
  }, async () => {
    const gzip = await gzipBytes(
      Array.from({ length: 400 }, (_, i) => `{"key":"k${i}","value":${i}}`).join('\n'),
    );
    for (const failAfter of [0, 1, 4]) {
      const failure = await verifyBackupArchive(
        slowBucket(gzip, { size: 16, failAfter }),
        'k',
        400,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `after ${failAfter} chunks`).toBeInstanceOf(BackupReadError);
    }
  });

  it('reports the integrity failure when its own cancel rejects the waiting read', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `{"key":"k${i}","value":${i}}`).join('\n');
    // Everything but the 8-byte trailer, so the stream has not ended
    const body = (await gzipBytes(many)).slice(0, -8);
    const corrupt = (await gzipBytes(`not json\n${many}`)).slice(0, -8);
    // The inflated cap sits above the compressed size (the bucket reports the
    // body plus the 8 trailer bytes) and below the inflated size, so the
    // stream is opened and the cap is passed while inflating
    const cap = body.byteLength + 8;
    expect(new TextEncoder().encode(many).byteLength).toBeGreaterThan(cap);
    for (const [chunks, count, maxBytes, message] of [
      [[body], 1, undefined, BACKUP_ERRORS.countMismatch],
      [[body], 50, cap, BACKUP_ERRORS.sizeLimit],
      [[corrupt], 51, undefined, BACKUP_ERRORS.content],
    ] as const) {
      const bucket = cancelRejectingBucket([...chunks]);
      // Exact message: sizeLimit is a prefix of compressedSizeLimit
      await expect(verifyBackupArchive(bucket, 'k', count, maxBytes)).rejects.toMatchObject({
        message,
      });
      expect(bucket.stats).toEqual({ opened: 1, cancels: 1 });
    }
  });

  it('reports a read that fails on its own as a read failure, over the content error that follows', async () => {
    const gzip = await gzipBytes('{"key":"a","value":1}\n{"key":"b","value":2}');
    const cause = new Error('R2 stream reset');
    let reads = 0;
    const reader = {
      read: () =>
        reads++ === 0
          ? Promise.resolve({ done: false, value: gzip.slice(0, 10) })
          : Promise.reject(cause),
      cancel: async () => undefined,
    };
    const bucket = {
      get: async () => ({
        size: gzip.byteLength,
        customMetadata: {},
        body: { getReader: () => reader, cancel: async () => undefined },
      }),
    } as unknown as R2Bucket;
    const failure = await verifyBackupArchive(bucket, 'k', 2).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BackupReadError);
    expect((failure as Error).cause).toBe(cause);
  });
});

// v1.37.1: workerd inflates each written chunk in full before any of it is
// read, so a small high-ratio archive delivered as one chunk could expand
// far past the inflated cap before the cap was checked. The scanner writes at
// most INFLATE_SLICE_BYTES at a time, and only once the previous slice's
// output has been read.
describe('decompression bomb', () => {
  it('stops a one-chunk bomb at the inflated cap after a few slices', {
    timeout: 30_000,
  }, async () => {
    // 64 MiB of zeros: about 64 KiB of gzip, four times the 16 MiB cap
    let made = 0;
    const zeros = new Uint8Array(1024 * 1024);
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (made++ < 64) controller.enqueue(zeros);
        else controller.close();
      },
    });
    const bomb = new Uint8Array(
      await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
    );
    const slices = Math.ceil(bomb.byteLength / INFLATE_SLICE_BYTES);
    expect(bomb.byteLength).toBeLessThan(MAX_BACKUP_BYTES);
    expect(slices).toBeGreaterThan(10);

    const writes: number[] = [];
    const write = WritableStreamDefaultWriter.prototype.write;
    const spy = vi
      .spyOn(WritableStreamDefaultWriter.prototype, 'write')
      .mockImplementation(function (this: WritableStreamDefaultWriter, chunk?: unknown) {
        writes.push(chunk instanceof Uint8Array ? chunk.byteLength : -1);
        return write.call(this, chunk);
      });
    try {
      // One chunk, as R2 might deliver a small object
      await expect(verifyBackupArchive(chunkedBucket([bomb]), 'k', 1)).rejects.toMatchObject({
        message: BACKUP_ERRORS.sizeLimit,
      });
    } finally {
      spy.mockRestore();
    }
    // Every write is one slice at most, and the cap stopped the scan after a
    // handful: 16 MiB at about 4 MiB a slice, not all of them
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.max(...writes)).toBeLessThanOrEqual(INFLATE_SLICE_BYTES);
    expect(writes.length).toBeLessThanOrEqual(6);
    expect(writes.length).toBeLessThan(slices);
  });

  it('still verifies an ordinary archive delivered as one large chunk', async () => {
    const records = Array.from(
      { length: 3000 },
      (_, i) => `{"key":"k${i}","value":"${'v'.repeat(i % 40)}"}`,
    );
    const gzip = await gzipBytes(records.join('\n'));
    expect(gzip.byteLength).toBeGreaterThan(INFLATE_SLICE_BYTES);
    expect(await verifyBackupArchive(chunkedBucket([gzip]), 'k', 3000)).toMatchObject({
      records: 3000,
    });
  });

  // If the inflated stream ends while the pump still holds archive bytes, the
  // pump must stop, not wait for a request that never comes, and the leftover
  // bytes are trailing data.
  it('rejects promptly when the inflater ends before all input is written', async () => {
    const encoder = new TextEncoder();
    class EarlyEndInflater {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor() {
        let output!: ReadableStreamDefaultController<Uint8Array>;
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
          },
        });
        let first = true;
        this.writable = new WritableStream<Uint8Array>({
          write() {
            if (!first) return;
            first = false;
            // One valid record, then the end, after the first slice only
            output.enqueue(encoder.encode('{"key":"a","value":1}\n'));
            output.close();
          },
        });
      }
    }
    vi.stubGlobal('DecompressionStream', EarlyEndInflater);
    try {
      const threeSlices = new Uint8Array(INFLATE_SLICE_BYTES * 3).fill(7);
      const outcome = await Promise.race([
        verifyBackupArchive(chunkedBucket([threeSlices]), 'k', 1).then(
          () => 'resolved',
          (error: unknown) => (error as Error).message,
        ),
        new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
      ]);
      expect(outcome).toBe(BACKUP_ERRORS.content);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
