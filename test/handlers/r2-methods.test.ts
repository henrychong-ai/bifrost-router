/**
 * File routes serve GET and HEAD only.
 *
 * The KV catch-all (`app.all('*')`) hands every method to `handleR2`. A POST,
 * PUT, PATCH, DELETE or OPTIONS to a file URL used to be served the object (the
 * cached GET body on an edge-cache HIT), and a missing object's 404 to such a
 * method named its key. Download counting was already GET-only; the tests
 * that no download is recorded are regression guards. Now OPTIONS gets 204
 * and every other method 405, both with `Allow: GET, HEAD, OPTIONS` and
 * `Cache-Control: no-store` and no `Access-Control-*` header, decided first in
 * the handler, before any cache or R2 read.
 *
 * Most cases drive the real Worker, so the catch-all and the analytics
 * recorders are under test too.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_SERVING_ALLOWED_METHODS,
  fileMethodRefusal,
  handleR2,
  isFileServingMethod,
} from '../../src/handlers/r2';
import type { AppEnv, Bindings, KVRouteConfig } from '../../src/types';
import {
  clearAllRoutes,
  clearR2,
  createLegacyRecorderTables,
  createSettlingExecutionContext,
  seedR2Object,
  seedRoute,
  TEST_DOMAIN,
} from '../helpers';

const REFUSED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Send one request through the real Worker with unified capture on, settling its writes. */
async function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: string }> {
  const { default: worker } = await import('../../src/index');
  const { ctx, settled } = createSettlingExecutionContext();
  const bindings = {
    ...(env as unknown as Bindings),
    UNIFIED_TRAFFIC_MODE: 'shadow',
    UNIFIED_TRAFFIC_CUTOVER_AT: '2026-01-01T00:00:00Z',
  } as Bindings;
  const response = await worker.fetch(
    new Request(`https://${TEST_DOMAIN}${path}`, { method, headers, redirect: 'manual' }),
    bindings,
    ctx,
  );
  const body = await response.clone().text();
  await settled();
  return { response, body };
}

async function createUnifiedTable(): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS unified_traffic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_bytes INTEGER,
      cache_status TEXT,
      country TEXT,
      traffic_class TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
}

const downloadCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM file_downloads').first<{ n: number }>())?.n ?? 0;

const unifiedRows = async () =>
  (
    await env.DB.prepare(
      'SELECT event_type, outcome, response_status FROM unified_traffic_events ORDER BY id',
    ).all<{ event_type: string; outcome: string; response_status: number }>()
  ).results;

/** Any other method: 405, `Allow`, no-store, a fixed JSON body, no object or CORS headers. */
function expect405(response: Response, body: string): void {
  expect(response.status).toBe(405);
  expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Cache-Status')).toBeNull();
  expect(response.headers.get('ETag')).toBeNull();
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(JSON.parse(body)).toEqual({ error: 'Method Not Allowed' });
}

/** OPTIONS: 204, `Allow`, no-store, no body, no object headers, no CORS headers. */
function expect204(response: Response, body: string): void {
  expect(response.status).toBe(204);
  expect(body).toBe('');
  expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Cache-Status')).toBeNull();
  expect(response.headers.get('ETag')).toBeNull();
  expect(response.headers.get('Content-Type')).toBeNull();
  for (const [name] of response.headers) {
    expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
  }
}

async function seedRoutes(): Promise<void> {
  await seedR2Object('methods/file.txt', 'public-bytes', 'text/plain');
  await seedRoute({
    path: '/m-file',
    type: 'r2',
    target: 'methods/file.txt',
    createdAt: 1,
    updatedAt: 1,
  });
  await seedRoute({
    path: '/m-missing',
    type: 'r2',
    target: 'methods/none.txt',
    createdAt: 1,
    updatedAt: 1,
  });
  await seedRoute({
    path: '/m-wild/*',
    type: 'r2',
    target: 'methods/file.txt',
    createdAt: 1,
    updatedAt: 1,
  });
}

const r2Route: KVRouteConfig = {
  path: '/media',
  type: 'r2',
  target: 'file.txt',
  createdAt: 1,
  updatedAt: 1,
};

describe('file routes serve GET and HEAD only', () => {
  beforeAll(async () => {
    await createLegacyRecorderTables();
    await createUnifiedTable();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    for (const table of [
      'file_downloads',
      'link_clicks',
      'proxy_requests',
      'unified_traffic_events',
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isFileServingMethod and fileMethodRefusal', () => {
    it('reads the file for GET and HEAD only', () => {
      expect(FILE_SERVING_ALLOWED_METHODS).toBe('GET, HEAD, OPTIONS');
      for (const method of ['GET', 'HEAD']) {
        expect(isFileServingMethod(method)).toBe(true);
      }
      for (const method of [...REFUSED_METHODS, 'OPTIONS', 'TRACE', 'PROPFIND', 'get']) {
        expect(isFileServingMethod(method)).toBe(false);
      }
    });

    it('answers OPTIONS 204 and anything else 405', async () => {
      const options = fileMethodRefusal('OPTIONS');
      expect204(options, await options.text());
      const trace = fileMethodRefusal('TRACE');
      expect405(trace, await trace.text());
      expect(trace.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('through the Worker', () => {
    it('GET and HEAD serve as before, uncached then cached, and revalidate', {
      timeout: 30_000,
    }, async () => {
      await seedRoutes();
      const path = '/m-file?case=get-head';

      const first = await send('GET', path);
      expect(first.response.status).toBe(200);
      expect(first.body).toBe('public-bytes');
      expect(first.response.headers.get('X-Cache-Status')).toBe('MISS');

      const hit = await send('GET', path);
      expect(hit.response.status).toBe(200);
      expect(hit.body).toBe('public-bytes');
      expect(hit.response.headers.get('X-Cache-Status')).toBe('HIT');

      const head = await send('HEAD', path);
      expect(head.response.status).toBe(200);
      expect(head.body).toBe('');

      const range = await send('GET', path, { Range: 'bytes=0-5' });
      expect(range.response.status).toBe(206);
      expect(range.body).toBe('public');

      expect((await send('GET', path, { 'If-None-Match': '*' })).response.status).toBe(304);
      expect((await send('HEAD', path, { 'If-None-Match': '*' })).response.status).toBe(304);
      expect((await send('GET', path, { 'If-Match': '"no-such-tag"' })).response.status).toBe(412);
    });

    for (const method of REFUSED_METHODS) {
      it(`${method} gets 405 on an object route, uncached and after a cached GET`, {
        timeout: 30_000,
      }, async () => {
        await seedRoutes();
        const path = `/m-file?case=${method}`;

        const uncached = await send(method, path);
        expect405(uncached.response, uncached.body);

        // Warm the edge cache with a GET: the method is still refused and never
        // handed the cached GET body
        expect((await send('GET', path)).response.headers.get('X-Cache-Status')).toBe('MISS');
        expect((await send('GET', path)).response.headers.get('X-Cache-Status')).toBe('HIT');
        const cached = await send(method, path);
        expect405(cached.response, cached.body);
        expect(cached.body).not.toContain('public-bytes');
      });

      it(`${method} with Range or a conditional header, matching or not, gets 405, never 304 or 412`, async () => {
        await seedRoutes();
        for (const headers of [
          { 'If-None-Match': '*' },
          { 'If-None-Match': '"no-such-tag"' },
          { 'If-Match': '"no-such-tag"' },
          { 'If-Modified-Since': 'Wed, 01 Jan 2099 00:00:00 GMT' },
          { 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
          { Range: 'bytes=0-3' },
        ]) {
          const { response, body } = await send(method, '/m-file', headers);
          expect405(response, body);
        }
      });

      it(`${method} gets the same 405 whether or not the object exists, and on a wildcard route`, async () => {
        await seedRoutes();
        const missing = await send(method, '/m-missing');
        expect405(missing.response, missing.body);
        expect(missing.body).not.toContain('methods/none.txt');

        const wildcard = await send(method, '/m-wild/anything');
        expect405(wildcard.response, wildcard.body);
      });
    }

    it('OPTIONS gets 204 with no body: uncached, after a cached GET, conditional, missing and wildcard', {
      timeout: 30_000,
    }, async () => {
      await seedRoutes();
      const path = '/m-file?case=options';
      const preflight = { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' };

      const uncached = await send('OPTIONS', path, preflight);
      expect204(uncached.response, uncached.body);

      expect((await send('GET', path)).response.headers.get('X-Cache-Status')).toBe('MISS');
      expect((await send('GET', path)).response.headers.get('X-Cache-Status')).toBe('HIT');
      // A plain OPTIONS (no conditional header) is the one that could reach the
      // edge-cache HIT, which would hand it the cached GET body: it must not,
      // and it records no download (a regression guard)
      const downloadsBefore = await downloadCount();
      const cached = await send('OPTIONS', path);
      expect204(cached.response, cached.body);
      expect(await downloadCount()).toBe(downloadsBefore);

      const conditional = await send('OPTIONS', path, { 'If-None-Match': '*' });
      expect204(conditional.response, conditional.body);
      const ranged = await send('OPTIONS', path, { Range: 'bytes=0-3' });
      expect204(ranged.response, ranged.body);

      const missing = await send('OPTIONS', '/m-missing');
      expect204(missing.response, missing.body);
      const wildcard = await send('OPTIONS', '/m-wild/anything');
      expect204(wildcard.response, wildcard.body);
    });

    it('OPTIONS records no download; its unified row is an r2 success with 204', async () => {
      await seedRoutes();
      await send('OPTIONS', '/m-file');
      expect(await downloadCount()).toBe(0);
      expect(await unifiedRows()).toEqual([
        { event_type: 'r2', outcome: 'success', response_status: 204 },
      ]);
    });

    it('a refused method records no download, and its unified row is an r2 client error', async () => {
      await seedRoutes();
      await send('POST', '/m-file');
      expect(await downloadCount()).toBe(0);
      expect(await unifiedRows()).toEqual([
        { event_type: 'r2', outcome: 'client_error', response_status: 405 },
      ]);

      // A GET still records both, as before
      await send('GET', '/m-file');
      expect(await downloadCount()).toBe(1);
      expect((await unifiedRows())[1]).toEqual({
        event_type: 'r2',
        outcome: 'success',
        response_status: 200,
      });
    });
  });

  describe('handler order', () => {
    it('refuses before any cache or R2 read, conditional or not', async () => {
      const bucket = { get: vi.fn<() => Promise<null>>(), head: vi.fn<() => Promise<null>>() };
      const cacheMatch = vi
        .spyOn(caches.default, 'match')
        .mockResolvedValue(new Response('cached GET body'));
      const app = new Hono<AppEnv>();
      app.all('/media', c => handleR2(c, r2Route));

      for (const method of [...REFUSED_METHODS, 'OPTIONS']) {
        const response = await app.fetch(
          new Request('http://localhost/media', {
            method,
            headers: { 'If-None-Match': '"abc123"' },
          }),
          { ENVIRONMENT: 'development', FILES_BUCKET: bucket as unknown as R2Bucket },
        );
        expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405);
        expect(await response.text()).not.toContain('cached GET body');
      }
      expect(cacheMatch).not.toHaveBeenCalled();
      expect(bucket.get).not.toHaveBeenCalled();
      expect(bucket.head).not.toHaveBeenCalled();
    });

    it('refuses before the cache lookup when an edge-cache HIT is in place (no conditional header)', async () => {
      // A conditional request skips the edge cache by design, so only a plain
      // request can reach the HIT path: this pass is the one that pins the order
      const bucket = { get: vi.fn<() => Promise<null>>(), head: vi.fn<() => Promise<null>>() };
      const cacheMatch = vi
        .spyOn(caches.default, 'match')
        .mockImplementation(async () => new Response('cached GET body'));
      const app = new Hono<AppEnv>();
      app.all('/media', c => handleR2(c, r2Route));
      const fetchMedia = (method: string) =>
        app.fetch(new Request('http://localhost/media', { method }), {
          ENVIRONMENT: 'development',
          FILES_BUCKET: bucket as unknown as R2Bucket,
        });

      for (const method of ['OPTIONS', ...REFUSED_METHODS]) {
        const response = await fetchMedia(method);
        expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405);
        expect(response.headers.get('X-Cache-Status')).toBeNull();
        expect(await response.text()).not.toContain('cached GET body');
      }
      expect(cacheMatch).not.toHaveBeenCalled();
      expect(bucket.get).not.toHaveBeenCalled();
      expect(bucket.head).not.toHaveBeenCalled();

      // Control: the same arrangement does serve a GET from the cache HIT, so
      // the assertions above can fail if the check moves below the lookup
      const get = await fetchMedia('GET');
      expect(get.status).toBe(200);
      expect(get.headers.get('X-Cache-Status')).toBe('HIT');
      expect(await get.text()).toBe('cached GET body');
      expect(cacheMatch).toHaveBeenCalledTimes(1);
      expect(bucket.get).not.toHaveBeenCalled();
    });

    it('refuses before the bucket and key checks, so a broken route config is not revealed', async () => {
      const app = new Hono<AppEnv>();
      app.all('/media', c => handleR2(c, { ...r2Route, bucket: 'no-such-bucket' }));
      const response = await app.fetch(new Request('http://localhost/media', { method: 'PUT' }), {
        ENVIRONMENT: 'development',
      });
      expect405(response, await response.text());
    });
  });

  describe('other route types keep their own method rules', () => {
    it('a redirect route still redirects a POST', async () => {
      await seedRoute({
        path: '/m-go',
        type: 'redirect',
        target: 'https://example.com/landing',
        createdAt: 1,
        updatedAt: 1,
      });
      const { response } = await send('POST', '/m-go');
      expect(response.status).toBe(302);
      expect(response.headers.get('Allow')).toBeNull();
    });

    it('a proxy route still forwards a POST upstream', async () => {
      const upstream = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response('upstream ok', { status: 201 }));
      await seedRoute({
        path: '/m-api/*',
        type: 'proxy',
        target: 'https://upstream.example.com/api/',
        createdAt: 1,
        updatedAt: 1,
      });
      const { response, body } = await send('POST', '/m-api/items');
      expect(response.status).toBe(201);
      expect(body).toBe('upstream ok');
      expect(upstream).toHaveBeenCalledTimes(1);
      const init = upstream.mock.calls[0]?.[1] as RequestInit | undefined;
      const input = upstream.mock.calls[0]?.[0];
      const method = init?.method ?? (input instanceof Request ? input.method : undefined);
      expect(method).toBe('POST');
    });
  });
});
