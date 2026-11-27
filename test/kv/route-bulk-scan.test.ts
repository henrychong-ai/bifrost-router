/**
 * The route scan reads route records in bulk (v1.48.0): one KV operation per
 * 100 keys instead of one per key, so a namespace of more than 1,000 route
 * keys stays inside the 1,000 KV operations an invocation may make. Every
 * caller of the scan (the route lists, `findRoutesByR2Target`: by-target, the
 * cache purge and the preview-image check) gets the same results as with one
 * read per key: proved here against `readRouteState` key by key. A chunk
 * whose bulk call fails is read one key at a time.
 */
import { env } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KV_BULK_GET_MAX_KEYS } from '../../src/backup/kv';
import { findRoutesByR2Target, listAllDomainRoutes, scanRoutes } from '../../src/kv/routes';
import { routeKey } from '../../src/kv/schema';
import { readRouteState, readRouteStates } from '../../src/kv/stored-route';
import { routesUsingObject } from '../../src/routes/route-preview-image';
import { clearAllRoutes } from '../helpers';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const DOMAIN = 'links.example.com';
const ROUTE_COUNT = 1_250;
const IMAGE_KEY = 'previews/scale.png';
const INVALID_KEY = routeKey(DOMAIN, '/scale-broken');
const RATE_LIMIT_KEY = 'ratelimit:feedback:203.0.113.9';
const QR_KEYS = Array.from({ length: 30 }, (_, index) => `qr:${DOMAIN}:scale-${index}`);

/** The ROUTES binding with every list and get call counted (a bulk get is one call). */
function countingKv(): { kv: KVNamespace; lists: () => number; gets: () => number } {
  let lists = 0;
  let gets = 0;
  const kv = new Proxy(env.ROUTES, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'list') {
        return (...args: unknown[]) => {
          lists += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (property === 'get' || property === 'getWithMetadata') {
        return (...args: unknown[]) => {
          gets += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { kv, lists: () => lists, gets: () => gets };
}

function route(index: number): Record<string, unknown> {
  return {
    path: `/scale-${index}`,
    type: 'r2',
    target: `files/scale-${index}.pdf`,
    bucket: 'files',
    createdAt: 1,
    updatedAt: 1,
    // Two routes far apart in the listing show the image
    ...(index === 7 || index === 1_201
      ? {
          previewTitle: 'Scale',
          previewImageBucket: 'assets',
          previewImageKey: IMAGE_KEY,
          previewImageWidth: 1200,
          previewImageHeight: 630,
        }
      : {}),
  };
}

async function removeExtras(): Promise<void> {
  await Promise.all([RATE_LIMIT_KEY, ...QR_KEYS].map(key => env.ROUTES.delete(key)));
}

describe('the bulk route scan (v1.48.0)', () => {
  beforeAll(async () => {
    await clearAllRoutes();
    const writes: Promise<void>[] = [];
    for (let index = 0; index < ROUTE_COUNT; index += 1) {
      writes.push(
        env.ROUTES.put(routeKey(DOMAIN, `/scale-${index}`), JSON.stringify(route(index))),
      );
    }
    // Keys a route scan must list past but never read
    for (const [index, key] of QR_KEYS.entries()) {
      writes.push(env.ROUTES.put(key, JSON.stringify({ id: index })));
    }
    writes.push(env.ROUTES.put(RATE_LIMIT_KEY, JSON.stringify({ count: 1 })));
    // An unreadable route record among them
    writes.push(env.ROUTES.put(INVALID_KEY, '{"path": "/scale-broken", "type": "nope"'));
    await Promise.all(writes);
  }, 30_000);

  afterAll(async () => {
    await removeExtras();
    await clearAllRoutes();
  }, 30_000);
  afterEach(() => vi.restoreAllMocks());

  it('scans more than 1,000 route keys inside the operation budget, one read per 100 keys', async () => {
    const counting = countingKv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scan = await scanRoutes(counting.kv);

    expect(scan.routes).toHaveLength(ROUTE_COUNT);
    expect(scan.invalid).toEqual([{ domain: DOMAIN, path: '/scale-broken', invalid: true }]);
    // 1,281 keys: 2 listing pages; 1,251 route keys: 13 bulk reads of up to 100
    const routeKeys = ROUTE_COUNT + 1;
    expect(counting.lists()).toBe(2);
    expect(counting.gets()).toBe(Math.ceil(routeKeys / KV_BULK_GET_MAX_KEYS));
    // The unreadable record is logged once, as before, by its key; the QR
    // and rate-limit keys are never read
    const lines = warn.mock.calls.map(([line]) => String(line));
    const invalidLines = lines.filter(line => line.includes('boundary-invalid-value'));
    expect(invalidLines).toHaveLength(1);
    expect(invalidLines[0]).toContain(INVALID_KEY);
    expect(lines.join('\n')).not.toContain('ratelimit');
  }, 30_000);

  it('finds the routes that name the image across the whole namespace', async () => {
    const counting = countingKv();
    const uses = await routesUsingObject({ ROUTES: counting.kv }, 'assets', IMAGE_KEY);
    expect(uses.previewImage.map(found => found.path).toSorted()).toEqual([
      '/scale-1201',
      '/scale-7',
    ]);
    expect(counting.lists() + counting.gets()).toBeLessThan(1_000);
    // The by-target and purge listing finds a served file the same way
    expect(await findRoutesByR2Target(counting.kv, 'files', 'files/scale-1100.pdf')).toEqual([
      expect.objectContaining({ path: '/scale-1100', usage: 'file' }),
    ]);
  }, 30_000);

  it('gives every caller the results one read per key gave, each record on its own key', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The same path on a second domain, with another record: a record taken
    // from the wrong key would land on the wrong domain
    const OTHER = 'example.com';
    await env.ROUTES.put(
      routeKey(OTHER, '/scale-7'),
      JSON.stringify({ ...route(7), target: 'files/other-domain.pdf' }),
    );
    try {
      const listed: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.ROUTES.list(cursor === undefined ? {} : { cursor });
        listed.push(...page.keys.map(key => key.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const expected: string[] = [];
      for (const key of listed.filter(name => name.includes(':/') && !name.startsWith('qr:'))) {
        const read = await readRouteState(env.ROUTES, key);
        if (read.status === 'ok') {
          expected.push(JSON.stringify({ key, domain: key.split(':/')[0], route: read.value }));
        }
      }
      const scan = await scanRoutes(env.ROUTES);
      const triples = scan.routes.map(found => JSON.stringify(found));
      expect(triples.toSorted()).toEqual(expected.toSorted());
      expect(scan.routes.find(found => found.key === routeKey(OTHER, '/scale-7'))).toMatchObject({
        domain: OTHER,
        route: { target: 'files/other-domain.pdf' },
      });
      // The all-domains listing adds the domain only
      const all = (await listAllDomainRoutes(env.ROUTES)).routes;
      expect(all).toHaveLength(scan.routes.length);
      expect(
        all
          .filter(found => found.path === '/scale-7')
          .map(found => found.domain)
          .toSorted(),
      ).toEqual([OTHER, DOMAIN].toSorted());
    } finally {
      await env.ROUTES.delete(routeKey(OTHER, '/scale-7'));
      quiet.mockRestore();
    }
  }, 30_000);
});

describe('readRouteStates (v1.48.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads in chunks of 100 and answers each key as readRouteState would', async () => {
    await clearAllRoutes();
    const keys: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      const key = routeKey(DOMAIN, `/chunk-${index}`);
      keys.push(key);
      await env.ROUTES.put(
        key,
        JSON.stringify({
          path: `/chunk-${index}`,
          type: 'redirect',
          target: 'https://example.com/',
        }),
      );
    }
    await env.ROUTES.put(routeKey(DOMAIN, '/chunk-null'), 'null');
    await env.ROUTES.put(routeKey(DOMAIN, '/chunk-text'), 'not json');
    const odd = [
      routeKey(DOMAIN, '/chunk-null'),
      routeKey(DOMAIN, '/chunk-text'),
      routeKey(DOMAIN, '/chunk-missing'),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.spyOn(env.ROUTES, 'get');
    const reads = await readRouteStates(env.ROUTES, [...keys, ...odd]);
    expect(get).toHaveBeenCalledTimes(3);
    get.mockRestore();
    for (const key of [...keys.slice(0, 3), ...odd]) {
      expect({ key, read: reads.get(key) }).toEqual({
        key,
        read: await readRouteState(env.ROUTES, key),
      });
    }
    expect(reads.get(odd[0] ?? '')).toEqual({ status: 'invalid' });
    expect(reads.get(odd[1] ?? '')).toEqual({ status: 'invalid' });
    expect(reads.get(odd[2] ?? '')).toEqual({ status: 'missing' });
    expect([...reads.values()].filter(read => read.status === 'ok')).toHaveLength(250);
    // Each invalid record once from the bulk read (and once from each comparison read)
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines.filter(line => line.includes('/chunk-text'))).toHaveLength(2);
    await clearAllRoutes();
  }, 30_000);

  it('a chunk whose bulk call fails is read one key at a time, identical to single reads', async () => {
    await clearAllRoutes();
    const keys: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      const key = routeKey(DOMAIN, `/fallback-${index}`);
      keys.push(key);
      await env.ROUTES.put(
        key,
        JSON.stringify({
          path: `/fallback-${index}`,
          type: 'redirect',
          target: 'https://example.com/',
        }),
      );
    }
    // An unreadable record inside the chunk whose bulk call fails
    const broken = keys[150] ?? '';
    await env.ROUTES.put(broken, 'not json');
    const original = env.ROUTES.get.bind(env.ROUTES) as (...args: unknown[]) => unknown;
    const calls: Array<string | string[]> = [];
    // The second chunk's bulk call is refused (as KV answers 413 past 25 MB)
    vi.spyOn(env.ROUTES, 'get').mockImplementation(((
      key: string | string[],
      ...rest: unknown[]
    ) => {
      calls.push(key);
      if (Array.isArray(key) && key.includes(broken)) {
        return Promise.reject(new Error(`413 too large at ${broken}`));
      }
      return original(key, ...rest);
    }) as typeof env.ROUTES.get);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reads = await readRouteStates(env.ROUTES, keys);
    const bulkCalls = calls.filter(call => Array.isArray(call));
    const singleCalls = calls.filter(call => !Array.isArray(call));
    expect(bulkCalls).toHaveLength(3);
    // Only the failed chunk's 100 keys are read one at a time
    expect(singleCalls).toHaveLength(100);
    const lines = warn.mock.calls.map(([line]) => String(line));
    // The fallback line names the class and the size, never a key or the text
    expect(lines.filter(line => line.includes('route-bulk-read-fallback'))).toEqual([
      JSON.stringify({
        level: 'warn',
        message: 'route-bulk-read-fallback',
        errorName: 'Error',
        keys: 100,
      }),
    ]);
    // The unreadable record is logged once, by its key, as a single read logs it
    expect(lines.filter(line => line.includes('boundary-invalid-value'))).toEqual([
      JSON.stringify({
        level: 'warn',
        message: 'boundary-invalid-value',
        category: 'route',
        key: broken,
      }),
    ]);
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const key of keys) {
      expect({ key, read: reads.get(key) }).toEqual({
        key,
        read: await readRouteState(env.ROUTES, key),
      });
    }
    expect([...reads.values()].filter(read => read.status === 'ok')).toHaveLength(249);
    await clearAllRoutes();
  }, 30_000);

  it('the scan still lists every route when a bulk call fails', async () => {
    await clearAllRoutes();
    for (let index = 0; index < 120; index += 1) {
      await env.ROUTES.put(
        routeKey(DOMAIN, `/listed-${index}`),
        JSON.stringify({
          path: `/listed-${index}`,
          type: 'redirect',
          target: 'https://example.com/',
        }),
      );
    }
    const original = env.ROUTES.get.bind(env.ROUTES) as (...args: unknown[]) => unknown;
    vi.spyOn(env.ROUTES, 'get').mockImplementation(((key: string | string[], ...rest: unknown[]) =>
      Array.isArray(key)
        ? Promise.reject(new Error('413'))
        : original(key, ...rest)) as typeof env.ROUTES.get);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scan = await scanRoutes(env.ROUTES, DOMAIN);
    expect(scan.routes).toHaveLength(120);
    expect(scan.invalid).toEqual([]);
    vi.restoreAllMocks();
    await clearAllRoutes();
  }, 30_000);

  it('a key over 512 bytes is missing without a read; nothing asked, nothing read', async () => {
    const get = vi.spyOn(env.ROUTES, 'get');
    const long = routeKey(DOMAIN, `/${'a'.repeat(600)}`);
    expect(await readRouteStates(env.ROUTES, [long])).toEqual(
      new Map([[long, { status: 'missing' }]]),
    );
    expect(await readRouteStates(env.ROUTES, [])).toEqual(new Map());
    expect(get).not.toHaveBeenCalled();
  });

  it('a KV failure of the single reads too is thrown unchanged, and fails the scan closed', async () => {
    const outage = new Error('KV unavailable');
    await env.ROUTES.put(
      routeKey(DOMAIN, '/outage'),
      JSON.stringify({ path: '/outage', type: 'redirect', target: 'https://example.com/' }),
    );
    vi.spyOn(env.ROUTES, 'get').mockRejectedValue(outage);
    await expect(readRouteStates(env.ROUTES, [routeKey(DOMAIN, '/outage')])).rejects.toBe(outage);
    await expect(scanRoutes(env.ROUTES)).rejects.toMatchObject({
      name: 'KVReadError',
      message: 'Failed to read from KV: list:all',
    });
    vi.restoreAllMocks();
    await clearAllRoutes();
  });
});
