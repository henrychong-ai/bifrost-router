import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  BackupListingError,
  MAX_RECORD_LINE_BYTES,
} from '../../src/backup/integrity';
import { BACKUP_SKIPPED_NOT_JSON, backupKV, KV_BULK_GET_MAX_KEYS } from '../../src/backup/kv';
import { readBackupRecords } from './archive-records';

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

describe('backupKV', () => {
  beforeEach(async () => {
    await clearKV();
    await clearBackupBucket();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs up KV routes to R2 as a compressed file', async () => {
    // Seed KV with routes
    const route1 = { path: '/github', type: 'redirect', target: 'https://github.com' };
    const route2 = { path: '/docs', type: 'redirect', target: 'https://docs.example.com' };
    await env.ROUTES.put('links.example.com:/github', JSON.stringify(route1));
    await env.ROUTES.put('links.example.com:/docs', JSON.stringify(route2));

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    // Verify result metadata
    expect(result.totalRoutes).toBe(2);
    expect(result.domains).toContain('links.example.com');
    expect(result.file).toBe('daily/20260219/kv-routes.ndjson.gz');

    // Verify R2 object was written
    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBeGreaterThan(0);
  });

  it('captures routes across multiple domains', async () => {
    await env.ROUTES.put(
      'links.example.com:/github',
      JSON.stringify({ path: '/github', type: 'redirect', target: 'https://github.com' }),
    );
    await env.ROUTES.put(
      'example.com:/about',
      JSON.stringify({ path: '/about', type: 'redirect', target: 'https://example.com/about' }),
    );
    await env.ROUTES.put(
      'secondary.example.net:/home',
      JSON.stringify({ path: '/home', type: 'redirect', target: 'https://secondary.example.net' }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRoutes).toBe(3);
    expect(result.domains).toContain('links.example.com');
    expect(result.domains).toContain('example.com');
    expect(result.domains).toContain('secondary.example.net');
  });

  it('handles empty KV namespace (no routes)', async () => {
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    expect(result.totalRoutes).toBe(0);
    expect(result.file).toBe('daily/20260219/kv-routes.ndjson.gz');

    // File should still exist (empty compressed content)
    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
  });

  it('writes R2 object with correct key path format', async () => {
    await env.ROUTES.put(
      'links.example.com:/test',
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const date = '20260115';
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);

    expect(result.file).toBe(`daily/${date}/kv-routes.ndjson.gz`);
    expect(result.file).toMatch(/^daily\/\d{8}\/kv-routes\.ndjson\.gz$/);
  });

  it('stores custom metadata on the R2 object', async () => {
    await env.ROUTES.put(
      'links.example.com:/test',
      JSON.stringify({ path: '/test', type: 'redirect', target: 'https://example.com' }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260219');

    const obj = await env.BACKUP_BUCKET.head(result.file);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toEqual(
      expect.objectContaining({
        date: '20260219',
        type: 'kv-routes',
        routeCount: '1',
      }),
    );
  });

  it('reads in bulk within the KV operation budget, keeping order and values', {
    timeout: 30_000,
  }, async () => {
    // Above the old per-key ceiling: one get per key spent one of the 1,000
    // KV operations an invocation may make on each record.
    const total = 2500;
    const values: Array<[string, unknown]> = [];
    for (let i = 0; i < total; i++) {
      const name = `links.example.com:/bulk-${String(i).padStart(4, '0')}`;
      // Falsy and nested values ride along: `!== null` keeps every one
      const value =
        i % 500 === 0
          ? 0
          : { path: `/bulk-${i}`, type: 'redirect', target: `https://example.com/${i}` };
      values.push([name, value]);
    }
    await Promise.all(values.map(([name, value]) => env.ROUTES.put(name, JSON.stringify(value))));

    const bulkSizes: number[] = [];
    let singleGets = 0;
    let lists = 0;
    const recording = new Proxy(env.ROUTES, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== 'function') return member;
        if (property === 'get') {
          return (key: string | string[], ...rest: unknown[]) => {
            if (Array.isArray(key)) bulkSizes.push(key.length);
            else singleGets += 1;
            return (member as (...args: unknown[]) => unknown).call(target, key, ...rest);
          };
        }
        if (property === 'list') {
          return (...args: unknown[]) => {
            lists += 1;
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return member.bind(target);
      },
    });

    const result = await backupKV(recording, env.BACKUP_BUCKET, '20260115');

    expect(result.totalRoutes).toBe(total);
    expect(singleGets).toBe(0);
    expect(Math.max(...bulkSizes)).toBeLessThanOrEqual(KV_BULK_GET_MAX_KEYS);
    expect(bulkSizes.reduce((sum, size) => sum + size, 0)).toBe(total);
    // 25 bulk reads + 3 list pages for the populated prefix + one list per
    // other prefix: far inside the 1,000-operation budget
    const operations = bulkSizes.length + lists;
    expect(operations).toBeLessThan(100);

    // Every record, in listing order, byte-identical to a per-key read
    const records = await readBackupRecords(env.BACKUP_BUCKET, {
      version: '2.0.0',
      timestamp: 0,
      date: '20260115',
      kv: result,
    });
    const perKey: string[] = [];
    for (const [name] of values) {
      perKey.push(JSON.stringify({ key: name, value: await env.ROUTES.get(name, 'json') }));
    }
    expect(records.map(record => JSON.stringify(record))).toEqual(perKey);
  });

  it('stops at the size cap while reading KV: no gzip, no R2 call, and the rest unread', async () => {
    // 1,000 records of about 100 serialised bytes against a 2,000-byte cap
    for (let i = 0; i < 1000; i++) {
      await env.ROUTES.put(
        `links.example.com:/cap-${String(i).padStart(4, '0')}`,
        JSON.stringify({ target: `https://example.com/${'x'.repeat(40)}` }),
      );
    }
    const bulkSizes: number[] = [];
    const kv = new Proxy(env.ROUTES, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== 'function') return member;
        if (property === 'get') {
          return (key: string | string[], ...rest: unknown[]) => {
            if (Array.isArray(key)) bulkSizes.push(key.length);
            return (member as (...args: unknown[]) => unknown).call(target, key, ...rest);
          };
        }
        return member.bind(target);
      },
    });
    let bucketCalls = 0;
    const bucket = new Proxy(env.BACKUP_BUCKET, {
      get(target, property) {
        bucketCalls += 1;
        return Reflect.get(target, property);
      },
    });

    await expect(backupKV(kv, bucket, '20260115', 2000)).rejects.toThrow(
      'Backup exceeds the size limit (MAX_BACKUP_BYTES)',
    );
    // Only the first bulk read ran: the cap fell inside it
    expect(bulkSizes).toEqual([KV_BULK_GET_MAX_KEYS]);
    expect(bucketCalls).toBe(0);
    expect((await env.BACKUP_BUCKET.list()).objects).toEqual([]);
  });

  it.each([
    ['a truncated page with no cursor', () => ({ keys: [], list_complete: false, cursor: '' })],
    ['a repeated cursor', () => ({ keys: [], list_complete: false, cursor: 'same' })],
  ])('refuses %s instead of backing up a partial listing', async (_label, page) => {
    let lists = 0;
    const kv = {
      list: async () => {
        lists += 1;
        if (lists > 5) throw new Error('listing never stopped');
        return page();
      },
      get: async () => new Map(),
    } as unknown as KVNamespace;
    let bucketCalls = 0;
    const bucket = new Proxy(env.BACKUP_BUCKET, {
      get(target, property) {
        bucketCalls += 1;
        return Reflect.get(target, property);
      },
    });

    const failure = backupKV(kv, bucket, '20260115');
    // Identified by class (v1.37.1), with the same fixed message
    await expect(failure).rejects.toBeInstanceOf(BackupListingError);
    await expect(failure).rejects.toThrow('Backup listing cursor invalid');
    expect(bucketCalls).toBe(0);
  });

  it('refuses a key the listing returns twice', async () => {
    const kv = {
      list: async ({ prefix }: { prefix: string }) =>
        prefix === 'example.com:'
          ? { keys: [{ name: 'example.com:/a' }, { name: 'example.com:/a' }], list_complete: true }
          : { keys: [], list_complete: true },
      get: async (keys: string[]) =>
        new Map(keys.map(key => [key, JSON.stringify({ target: 'x' })])),
    } as unknown as KVNamespace;

    await expect(backupKV(kv, env.BACKUP_BUCKET, '20260115')).rejects.toThrow(
      'Backup contains a duplicate key',
    );
  });

  // v1.38.0: a value that is not JSON is skipped, counted and logged by its key
  // only, and the backup of every other record goes on. The archive's records
  // are `{key, value}` with a JSON value, restored as `JSON.stringify(value)`,
  // so it cannot hold raw text unchanged; one such value used to fail every
  // nightly backup until someone deleted it.
  it('skips a value that is not JSON next to valid records, counting it, quoting nothing', async () => {
    // Short and bare: V8's parse error quotes the first ten characters
    const secret = 'zq7f3a91x';
    const good = { path: '/good', type: 'redirect', target: 'https://example.com/' };
    const qr = { id: 'promo', type: 'text', payload: { text: 'hi' } };
    await env.ROUTES.put('links.example.com:/good', JSON.stringify(good));
    await env.ROUTES.put('links.example.com:/bad', secret);
    await env.ROUTES.put('qr:links.example.com:promo', JSON.stringify(qr));
    await env.ROUTES.put('qr:links.example.com:broken', `{"id":"${secret}"`);

    const lines: string[] = [];
    for (const channel of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260115');
    expect(result.totalRoutes).toBe(2);
    expect(result.skippedNotJson).toBe(2);

    // One fixed line per skipped record, naming its key and nothing else
    expect(lines).toEqual([
      `[Backup] ${BACKUP_SKIPPED_NOT_JSON}: links.example.com:/bad`,
      `[Backup] ${BACKUP_SKIPPED_NOT_JSON}: qr:links.example.com:broken`,
    ]);
    expect(lines.join('\n')).not.toContain(secret);

    // The valid records restore unchanged
    const records = await readBackupRecords(env.BACKUP_BUCKET, {
      version: '2.0.0',
      timestamp: 0,
      date: '20260115',
      kv: result,
    });
    expect(records).toEqual([
      { key: 'links.example.com:/good', value: good },
      { key: 'qr:links.example.com:promo', value: qr },
    ]);
  });

  it('counts no skipped record when every value is JSON', async () => {
    await env.ROUTES.put('links.example.com:/good', JSON.stringify({ target: 'x' }));
    expect(await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260115')).toMatchObject({
      totalRoutes: 1,
      skippedNotJson: 0,
    });
  });

  // v1.37.2: a record the verifier would refuse as an over-long line fails
  // before any gzip, with its own fixed message, located but never named.
  it('refuses a record over the line limit with fixed text, before writing', async () => {
    await env.ROUTES.put('links.example.com:/good', JSON.stringify({ target: 'x' }));
    await env.ROUTES.put(
      'links.example.com:/huge',
      JSON.stringify({ target: `https://app.example/${'a'.repeat(MAX_RECORD_LINE_BYTES)}` }),
    );

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260115').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BackupIntegrityError);
    expect((failure as Error).message).toBe(BACKUP_ERRORS.recordTooLarge);
    // `/good` sorts before `/huge`
    expect(errorLog.mock.calls).toEqual([
      [`[Backup] ${BACKUP_ERRORS.recordTooLarge}: prefix links.example.com:, listing index 1`],
    ]);
    expect(await env.BACKUP_BUCKET.head('daily/20260115/kv-routes.ndjson.gz')).toBeNull();
  });

  it('keeps a record just under the line limit', async () => {
    // {"key":"links.example.com:/edge","value":{"target":"…"}} wraps the target
    const key = 'links.example.com:/edge';
    const wrapper = JSON.stringify({ key, value: { target: '' } }).length;
    const target = 'a'.repeat(MAX_RECORD_LINE_BYTES - wrapper);
    await env.ROUTES.put(key, JSON.stringify({ target }));
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260115');
    expect(result.totalRoutes).toBe(1);
  });

  it('skips a stored JSON null like a key that vanished', async () => {
    await env.ROUTES.put('links.example.com:/kept', JSON.stringify({ target: 'x' }));
    await env.ROUTES.put('links.example.com:/null', 'null');
    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260115');
    expect(result.totalRoutes).toBe(1);
    // Not counted as skipped (v1.39.0): backup health warns only about values
    // that are not JSON, never about a record that vanished or holds null
    expect(result.skippedNotJson).toBe(0);
    expect(
      await readBackupRecords(env.BACKUP_BUCKET, {
        version: '2.0.0',
        timestamp: 0,
        date: '20260115',
        kv: result,
      }),
    ).toEqual([{ key: 'links.example.com:/kept', value: { target: 'x' } }]);
  });
});
