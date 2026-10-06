/**
 * Backup content verification.
 * The archive is inflated with pako chunk by chunk, so these cases also pin
 * what the scanner refuses: a truncated stream, a bad CRC-32 trailer, and any
 * byte after the gzip member.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { gzipCompress } from '../../src/backup/compress';
import { backupArchiveKey, backupManifestKey } from '../../src/backup/constants';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  BackupReadError,
  inflatedInputBytes,
  MAX_BACKUP_BYTES,
  MAX_RECORD_LINE_BYTES,
  parseBackupManifest,
  RecordLineBuffer,
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

// A real R2 body arrives over time, and cancelling a native stream rejects a
// pending read ("Stream was cancelled."); a JS-constructed stream resolves it
// instead, and Miniflare's local R2 delivers too fast to show it. These bodies
// are workerd-native streams (IdentityTransformStream) written chunk by chunk,
// `delayMs` apart.
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
 * cancelled.", as workerd does for its native streams. Verification must
 * cancel it exactly once, and its own cancel must never turn a size, count or
 * content failure into a read failure.
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
// member, is refused wherever the chunk boundaries fall (v1.37.1). The scanner
// refuses any chunk that arrives once the member has ended, and compares the
// bytes the member consumed with the bytes that arrived for a tail inside the
// same chunk; either way the failure is the fixed content message.
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

/** A gzip of `total` bytes repeating `unit`, compressed as a stream. */
async function gzipRepeated(unit: Uint8Array, total: number): Promise<Uint8Array> {
  let made = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (made >= total) {
        controller.close();
        return;
      }
      const block = new Uint8Array(Math.min(1024 * 1024, total - made));
      for (let at = 0; at < block.byteLength; at += unit.byteLength) block.set(unit, at);
      made += block.byteLength;
      controller.enqueue(block);
    },
  });
  return new Uint8Array(
    await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  );
}

/** Bytes handed to TextDecoder.decode while `run` runs. */
async function decodedBytesDuring(run: () => Promise<unknown>): Promise<number[]> {
  const sizes: number[] = [];
  const decode = TextDecoder.prototype.decode;
  const spy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
    this: TextDecoder,
    input?: AllowSharedBufferSource,
    options?,
  ) {
    sizes.push(input === undefined ? 0 : input.byteLength);
    return decode.call(this, input, options);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return sizes;
}

// The inflated cap is enforced inside the inflater's output callback, which
// pako calls for every 16 KiB of output and which throws mid-chunk: a small
// high-ratio archive delivered as one chunk stops at the cap instead of
// inflating in full first.
describe('decompression bomb', () => {
  it('stops a one-chunk bomb at the inflated cap', { timeout: 30_000 }, async () => {
    // 64 MiB of blank lines: about 64 KiB of gzip, four times the 16 MiB cap.
    // Blank lines are skipped, so only the inflated cap can stop it.
    const unit = new TextEncoder().encode(`${' '.repeat(1023)}\n`);
    const bomb = await gzipRepeated(unit, 64 * 1024 * 1024);
    expect(bomb.byteLength).toBeLessThan(MAX_BACKUP_BYTES / 64);

    const sizes = await decodedBytesDuring(() =>
      expect(verifyBackupArchive(chunkedBucket([bomb]), 'k', 1)).rejects.toMatchObject({
        message: BACKUP_ERRORS.sizeLimit,
      }),
    );
    // Every piece of output is at most one 16 KiB chunk, and no more than the
    // cap was ever decoded: the rest of the 64 MiB was never inflated
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16 * 1024);
    const decoded = sizes.reduce((sum, size) => sum + size, 0);
    expect(decoded).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
    expect(decoded).toBeGreaterThan(MAX_BACKUP_BYTES - 16 * 1024);
  });

  it('still verifies an ordinary archive delivered as one large chunk', async () => {
    const records = Array.from(
      { length: 3000 },
      (_, i) => `{"key":"k${i}","value":"${'v'.repeat(i % 40)}"}`,
    );
    const text = records.join('\n');
    // Many 16 KiB output chunks from one input chunk
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(4 * 16 * 1024);
    const gzip = await gzipBytes(text);
    expect(await verifyBackupArchive(chunkedBucket([gzip]), 'k', 3000)).toMatchObject({
      records: 3000,
    });
  });

  it('fails with a fixed message when pako stops exposing its compressed byte count', () => {
    for (const inflator of [
      {},
      { strm: {} },
      { strm: { total_in: '12' } },
      { strm: { total_in: Number.NaN } },
      { strm: { total_in: Number.POSITIVE_INFINITY } },
    ]) {
      expect(() => inflatedInputBytes(inflator as never)).toThrow(
        new BackupIntegrityError(BACKUP_ERRORS.inflaterUnsupported),
      );
    }
    expect(inflatedInputBytes({ strm: { total_in: 12 } } as never)).toBe(12);
  });

  it('cancels a body that streams past its declared size, at the compressed cap', async () => {
    let cancelled = false;
    let sent = 0;
    // Incompressible records: valid gzip, far more than 100 bytes of it
    const gzip = await gzipBytes(
      Array.from(
        { length: 400 },
        (_, i) => `{"key":"k${i}","value":"${crypto.randomUUID()}"}`,
      ).join('\n'),
    );
    expect(gzip.byteLength).toBeGreaterThan(1000);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(gzip.slice(sent, sent + 16));
        sent += 16;
      },
      cancel() {
        cancelled = true;
      },
    });
    // The object claims 10 bytes; the body keeps streaming past the 100-byte cap
    const bucket = { get: async () => ({ size: 10, body }) } as unknown as R2Bucket;
    await expect(verifyBackupArchive(bucket, 'k', 400, 100)).rejects.toMatchObject({
      message: BACKUP_ERRORS.compressedSizeLimit,
    });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(200);
  });
});

/**
 * A record line of exactly `bytes` UTF-8 bytes. {"key":"k","value":"…"} is 22
 * bytes around the value; 'é' is two bytes, so a cap counted in characters
 * would differ from one counted in bytes.
 */
function recordLineOf(bytes: number): string {
  const doubles = Math.floor((bytes - 22) / 2);
  const single = 'a'.repeat(bytes - 22 - doubles * 2);
  const line = JSON.stringify({ key: 'k', value: `${single}${'é'.repeat(doubles)}` });
  expect(new TextEncoder().encode(line).byteLength).toBe(bytes);
  return line;
}

// The line split searches only newly inflated output, and one record line is
// capped at MAX_RECORD_LINE_BYTES of UTF-8, so an archive with no newline is
// neither rescanned on every chunk nor held whole.
describe('record lines', () => {
  it('rejects a 16 MiB archive of one newline-free line, quickly', {
    timeout: 30_000,
  }, async () => {
    const line = await gzipRepeated(new TextEncoder().encode('a'), MAX_BACKUP_BYTES);
    expect(line.byteLength).toBeLessThan(MAX_BACKUP_BYTES / 64);
    let elapsed = 0;
    const sizes = await decodedBytesDuring(async () => {
      const started = performance.now();
      const outcome = await verifyArchiveBytes(line, 1).then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      elapsed = performance.now() - started;
      expect(outcome).toBe(BACKUP_ERRORS.content);
    });
    expect(elapsed).toBeLessThan(1000);
    // Stopped at the line cap, long before the inflated cap
    const decoded = sizes.reduce((sum, size) => sum + size, 0);
    expect(decoded).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES);
    expect(MAX_RECORD_LINE_BYTES).toBe(1024 * 1024);
  });

  it.each([
    ['followed by another record', (long: string) => `${long}\n{"key":"b","value":1}`],
    ['as the last line', (long: string) => `{"key":"b","value":1}\n${long}`],
    ['before a trailing newline', (long: string) => `{"key":"b","value":1}\n${long}\n`],
  ])(
    'accepts a line of exactly the cap and refuses one byte more, %s',
    {
      timeout: 30_000,
    },
    async (_label, archiveOf) => {
      const accepted = await gzipBytes(archiveOf(recordLineOf(MAX_RECORD_LINE_BYTES)));
      expect(await verifyArchiveBytes(accepted, 2)).toMatchObject({ records: 2 });
      const refused = await gzipBytes(archiveOf(recordLineOf(MAX_RECORD_LINE_BYTES + 1)));
      await expect(verifyArchiveBytes(refused, 2)).rejects.toMatchObject({
        message: BACKUP_ERRORS.content,
      });
    },
  );

  it('splits lines identically however the inflated output is chunked', async () => {
    // Records of every length around a 16 KiB output chunk, multi-byte text
    // included, so line ends fall at, before and after each chunk boundary
    const records = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ key: `k${i}`, value: `${'é'.repeat(i * 37)}${'x'.repeat(8180 + i)}` }),
    );
    const text = records.join('\n');
    const gzip = await gzipBytes(text);
    for (const chunks of [[gzip], split(gzip, 7), split(gzip, 4096)]) {
      expect(await verifyBackupArchive(chunkedBucket(chunks), 'k', 40)).toEqual({
        records: 40,
        inflatedBytes: new TextEncoder().encode(text).byteLength,
        countSource: 'manifest',
      });
    }
  });

  it('holds a line in one buffer that grows a few times, however finely it arrives', () => {
    const buffer = new RecordLineBuffer();
    const byte = new Uint8Array([0x61]);
    for (let i = 0; i < MAX_RECORD_LINE_BYTES; i += 1) buffer.append(byte);
    // 1 KiB doubling to 1 MiB: ten reallocations, not one piece per append
    expect(buffer.growths).toBe(10);
    expect(buffer.take().byteLength).toBe(MAX_RECORD_LINE_BYTES);
    // Kept for the next line, so no further growth
    buffer.append(new Uint8Array(MAX_RECORD_LINE_BYTES));
    expect(buffer.growths).toBe(10);
    expect(() => buffer.append(byte)).toThrow(new BackupIntegrityError(BACKUP_ERRORS.content));
  });

  it('verifies a near-cap record delivered one compressed byte at a time, in bounded memory', {
    timeout: 30_000,
  }, async () => {
    const text = `${recordLineOf(MAX_RECORD_LINE_BYTES - 64)}\n{"key":"b","value":1}`;
    const gzip = await gzipBytes(text);
    const appends = vi.spyOn(RecordLineBuffer.prototype, 'append');
    // grow is private; spied through its shape
    const grows = vi.spyOn(
      RecordLineBuffer.prototype as unknown as { grow(needed: number): void },
      'grow',
    );
    try {
      expect(await verifyBackupArchive(chunkedBucket(split(gzip, 1)), 'k', 2)).toMatchObject({
        records: 2,
        inflatedBytes: new TextEncoder().encode(text).byteLength,
      });
      // The line arrived in hundreds of pieces, all copied into one buffer
      expect(appends.mock.calls.length).toBeGreaterThan(500);
      expect(grows.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      appends.mockRestore();
      grows.mockRestore();
    }
  });

  it('refuses a multi-byte character cut by a newline', async () => {
    // 0xC3 starts a two-byte character; a newline cannot continue it, even
    // when the byte after the newline would
    const bytes = concat(
      new TextEncoder().encode('{"key":"a","value":"'),
      new Uint8Array([0xc3, 0x0a, 0xa9]),
      new TextEncoder().encode('"}'),
    );
    const gzip = new Uint8Array(
      await new Response(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );
    await expect(verifyArchiveBytes(gzip, 1)).rejects.toThrow(BACKUP_ERRORS.content);
  });
});
