/**
 * Link previews for file routes (v1.48.0): the serving branch in handleR2.
 *
 * A recognised link-preview fetcher asking for a file whose route has a
 * preview title gets a small HTML document of Open Graph tags; everyone else
 * gets the file exactly as before. Driven through the real Worker so the
 * catch-all, the edge cache and the download recorder are all under test.
 * The order test checks that a person's request never validates the stored
 * preview, and the default-image cases that the shipped (empty) map changes
 * no served byte.
 */

import { env } from 'cloudflare:test';
import { PREVIEW_DEFAULT_IMAGES, type PreviewImageRef } from '@bifrost/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeKey } from '../../src/kv/schema';
import type { KVRouteConfig } from '../../src/types';
import * as linkPreview from '../../src/utils/link-preview';
import {
  clearAllRoutes,
  clearR2,
  createLegacyRecorderTables,
  createSettlingExecutionContext,
  seedR2Object,
  seedRoute,
  TEST_DOMAIN,
} from '../helpers';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const WHATSAPP = 'WhatsApp/2.23.20.0 A';
const LINKEDIN =
  'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IMESSAGE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';
const FILE_BYTES = '%PDF-1.7 preview test bytes';
const FILE_KEY = 'previews-test/briefing.pdf';

async function send(
  path: string,
  headers: Record<string, string> = {},
  options: { method?: string; host?: string; bindings?: Record<string, unknown> } = {},
): Promise<{ response: Response; body: string }> {
  const { default: worker } = await import('../../src/index');
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${options.host ?? TEST_DOMAIN}${path}`, {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
    }),
    { ...env, ...options.bindings },
    ctx,
  );
  const body = new TextDecoder().decode(await response.clone().arrayBuffer());
  await settled();
  return { response, body };
}

const previewRoute = (overrides: Partial<KVRouteConfig> = {}): KVRouteConfig => ({
  path: '/briefing',
  type: 'r2',
  target: FILE_KEY,
  previewTitle: 'Quarterly "briefing" <2026>',
  previewDescription: 'Facts & figures',
  previewImageBucket: 'assets',
  previewImageKey: 'previews/briefing card.jpg',
  previewImageWidth: 1200,
  previewImageHeight: 630,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const downloadRows = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM file_downloads').first<{ n: number }>())?.n ?? 0;

function expectPreviewHeaders(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(response.headers.get('Vary')).toBe('User-Agent');
  expect(response.headers.get('Content-Disposition')).toBeNull();
  expect(response.headers.get('Content-Range')).toBeNull();
  expect(response.headers.get('X-Cache-Status')).toBeNull();
}

describe('link previews on file routes (v1.48.0)', () => {
  beforeAll(async () => {
    await createLegacyRecorderTables();
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    await env.DB.prepare('DELETE FROM file_downloads').run();
    await seedR2Object(FILE_KEY, FILE_BYTES, 'application/pdf');
    await env.ASSETS_BUCKET.put('previews/briefing card.jpg', 'jpeg-bytes', {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await seedRoute(previewRoute());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fetcher gets the preview document for GET, with escaped tags and custom-domain addresses', async () => {
    const { response, body } = await send('/briefing?utm_source=x', { 'User-Agent': WHATSAPP });
    expectPreviewHeaders(response);
    expect(Number(response.headers.get('Content-Length'))).toBe(
      new TextEncoder().encode(body).byteLength,
    );
    expect(body).toContain(
      '<meta property="og:title" content="Quarterly &quot;briefing&quot; &lt;2026&gt;">',
    );
    expect(body).toContain('<meta property="og:description" content="Facts &amp; figures">');
    expect(body).toContain('<meta property="og:url" content="https://example.com/briefing">');
    expect(body).not.toContain('og:site_name');
    expect(body).toContain(
      '<meta property="og:image" content="https://assets.example.com/previews/briefing%20card.jpg">',
    );
    expect(body).toContain('<meta property="og:image:width" content="1200">');
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(body).toContain(`href="https://files.example.com/${FILE_KEY}">Open file</a>`);
    expect(body).not.toContain(FILE_BYTES);
    expect(body).not.toContain('utm_source');
  });

  it("Apple's Messages fetcher gets the card although it runs on WebKit", async () => {
    const { response } = await send('/briefing', {
      'User-Agent': IMESSAGE,
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    });
    expectPreviewHeaders(response);
  });

  it('a HEAD from a fetcher gets the same status and headers', async () => {
    const head = await send('/briefing', { 'User-Agent': LINKEDIN }, { method: 'HEAD' });
    const get = await send('/briefing', { 'User-Agent': LINKEDIN });
    expectPreviewHeaders(head.response);
    expect(head.response.headers.get('Content-Length')).toBe(
      get.response.headers.get('Content-Length'),
    );
  });

  it('a ranged or conditional GET from a fetcher still gets the whole document (200)', async () => {
    const ranged = await send('/briefing', {
      'User-Agent': 'facebookexternalhit/1.1',
      Range: 'bytes=0-9',
      'If-None-Match': '"anything"',
    });
    expectPreviewHeaders(ranged.response);
    expect(ranged.body).toContain('og:title');
  });

  it('a fetcher sending another method gets the method refusal, never the card', async () => {
    const { response, body } = await send(
      '/briefing',
      { 'User-Agent': WHATSAPP },
      { method: 'POST' },
    );
    expect(response.status).toBe(405);
    expect(body).not.toContain('og:title');
  });

  it('a person gets the file exactly as before, with no Vary header', async () => {
    const { response, body } = await send('/briefing', { 'User-Agent': CHROME });
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('a browser navigation with a spoofed fetcher agent gets the file', async () => {
    const { response, body } = await send('/briefing', {
      'User-Agent': `${CHROME} facebookexternalhit/1.1`,
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    });
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
  });

  it('a fetcher on a route with no preview title gets the file', async () => {
    await seedRoute(
      previewRoute({
        previewTitle: undefined,
        previewDescription: undefined,
        previewImageBucket: undefined,
        previewImageKey: undefined,
        previewImageWidth: undefined,
        previewImageHeight: undefined,
      }),
    );
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
  });

  it('a stored image key with a lone surrogate serves the file to a fetcher, never throwing', async () => {
    await seedRoute(previewRoute({ previewImageKey: 'previews/\uD800card.jpg' }));
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
  });

  it('an image bucket removed from the configuration serves the file, never a broken card', async () => {
    const domains = (await import('../../src/types')).R2_BUCKET_CUSTOM_DOMAINS;
    const saved = domains['assets'];
    delete domains['assets'];
    try {
      const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
      expect(response.status).toBe(200);
      expect(body).toBe(FILE_BYTES);
    } finally {
      if (saved) domains['assets'] = saved;
    }
  });

  it('a missing object falls through to the normal 404, with no card', async () => {
    await seedRoute(previewRoute({ path: '/gone', target: 'previews-test/missing.pdf' }));
    const { response, body } = await send('/gone', { 'User-Agent': WHATSAPP });
    expect(response.status).toBe(404);
    expect(body).not.toContain('og:title');
  });

  it('an R2 error on the head serves the file from R2, never from the cache', async () => {
    const head = vi.spyOn(env.FILES_BUCKET, 'head').mockRejectedValueOnce(new Error('r2 down'));
    const match = vi
      .spyOn(caches.default, 'match')
      .mockResolvedValue(new Response('stale-cached-bytes'));
    const put = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(head).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('briefing.pdf');
  });

  it('a deleted object is the normal 404 for a fetcher, never the stale cached file', async () => {
    // Warm the cache the way a person's visit does, then delete the object
    const cached = new Map<string, Response>();
    vi.spyOn(caches.default, 'put').mockImplementation(async (key, value) => {
      cached.set(typeof key === 'string' ? key : key.url, value);
    });
    const match = vi
      .spyOn(caches.default, 'match')
      .mockImplementation(async key =>
        cached.get(typeof key === 'string' ? key : key.url)?.clone(),
      );
    await send('/briefing', { 'User-Agent': CHROME });
    expect(cached.size).toBe(1);
    await env.FILES_BUCKET.delete(FILE_KEY);
    match.mockClear();
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'File not found', key: FILE_KEY });
    expect(match).not.toHaveBeenCalled();
  });

  it('an image file is served as itself to a fetcher (it previews as an image)', async () => {
    await env.FILES_BUCKET.put('previews-test/card.png', 'png-bytes', {
      httpMetadata: { contentType: 'image/png' },
    });
    await seedRoute(previewRoute({ path: '/card', target: 'previews-test/card.png' }));
    const { response, body } = await send('/card', { 'User-Agent': WHATSAPP });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(body).toBe('png-bytes');
  });

  it('a wildcard route is never answered with a card, even with a title stored out of band', async () => {
    await env.ROUTES.put(
      routeKey(TEST_DOMAIN, '/docs/*'),
      JSON.stringify(previewRoute({ path: '/docs/*' })),
    );
    const { response, body } = await send('/docs/anything', { 'User-Agent': WHATSAPP });
    // The record stays readable; a wildcard route is never card-eligible: the file
    expect(response.status).toBe(200);
    expect(body).toBe(FILE_BYTES);
  });

  it.each([
    ['a title over the cap', { previewTitle: 'x'.repeat(500) }],
    ['a bucket not in the list', { previewImageBucket: 'constructor' }],
    ['a bucket with no custom domain', { previewImageBucket: 'files-user1' }],
    ['half an image pair', { previewImageBucket: undefined }],
    ['a three-space image key', { previewImageKey: '   ' }],
    ['an image without its measured size', { previewImageWidth: undefined }],
    ['half a video size', { previewVideoWidth: 1920 }],
  ])(
    'a stored preview with %s serves the file to people and fetchers, with no card',
    async (_label, change) => {
      await env.ROUTES.put(
        routeKey(TEST_DOMAIN, '/briefing'),
        JSON.stringify({ ...previewRoute(), ...change }),
      );
      for (const userAgent of [WHATSAPP, CHROME]) {
        const { response, body } = await send('/briefing', { 'User-Agent': userAgent });
        expect(response.status).toBe(200);
        expect(body).toBe(FILE_BYTES);
        expect(body).not.toContain('og:title');
      }
    },
  );

  it('a cached file is never returned to a fetcher, and the document is never cached', async () => {
    const cachedFile = new Response('cached-file-bytes', {
      headers: { 'Content-Type': 'application/pdf' },
    });
    const match = vi.spyOn(caches.default, 'match').mockResolvedValue(cachedFile);
    const put = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expectPreviewHeaders(response);
    expect(body).not.toContain('cached-file-bytes');
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    // A person on the same URL still gets the cache's answer
    const person = await send('/briefing', { 'User-Agent': CHROME });
    expect(person.body).toBe('cached-file-bytes');
    expect(match).toHaveBeenCalledTimes(1);
  });

  it('a person served from R2 is cached as before; the cache entry is the file', async () => {
    vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
    const put = vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
    await send('/briefing', { 'User-Agent': CHROME });
    expect(put).toHaveBeenCalledTimes(1);
    const stored = put.mock.calls[0]?.[1] as Response;
    expect(stored.headers.get('Content-Type')).toBe('application/pdf');
    expect(stored.headers.get('Vary')).toBeNull();
  });

  it('the preview response records no file download; the file does', async () => {
    await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(await downloadRows()).toBe(0);
    await send('/briefing', { 'User-Agent': CHROME });
    expect(await downloadRows()).toBe(1);
  });

  it('unified traffic records a preview fetch as automation, whatever its agent looks like', async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS unified_traffic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, path TEXT NOT NULL,
        event_type TEXT NOT NULL, outcome TEXT NOT NULL, response_status INTEGER NOT NULL,
        response_bytes INTEGER, cache_status TEXT, country TEXT,
        traffic_class TEXT NOT NULL CHECK (traffic_class IN ('browser', 'automation', 'unknown')),
        latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
    ).run();
    await env.DB.prepare('DELETE FROM unified_traffic_events').run();
    const bindings = {
      UNIFIED_TRAFFIC_MODE: 'shadow',
      UNIFIED_TRAFFIC_CUTOVER_AT: '2026-01-01T00:00:00Z',
    };
    // WhatsApp's agent has no bot token and the iMessage one looks like
    // Safari: the classifier alone would not say automation for them
    await send('/briefing', { 'User-Agent': WHATSAPP }, { bindings });
    await send('/briefing', { 'User-Agent': IMESSAGE }, { bindings });
    await send('/briefing', { 'User-Agent': CHROME }, { bindings });
    const rows = (
      await env.DB.prepare('SELECT traffic_class FROM unified_traffic_events ORDER BY id').all<{
        traffic_class: string;
      }>()
    ).results;
    expect(rows.map(row => row.traffic_class)).toEqual(['automation', 'automation', 'browser']);
  });

  it('logs the route fields and platform only, never the preview text or the key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await send('/briefing?secret=visitor-query', { 'User-Agent': WHATSAPP });
    const lines = JSON.stringify(log.mock.calls);
    const previewLine = log.mock.calls
      .map(([text]) => String(text))
      .find(text => text.includes('"R2 link preview"'));
    expect(JSON.parse(previewLine ?? '{}')).toEqual({
      level: 'info',
      message: 'R2 link preview',
      domain: TEST_DOMAIN,
      routePath: '/briefing',
      bucket: 'files',
      platform: 'whatsapp',
    });
    expect(lines).not.toContain('briefing.pdf');
    expect(lines).not.toContain('Quarterly');
    expect(lines).not.toContain('figures');
    expect(lines).not.toContain('visitor-query');
  });

  it('video files get playback tags pointing at the file, never the short link', async () => {
    await seedR2Object('previews-test/film.mp4', 'mp4-bytes', 'video/mp4');
    await seedRoute(
      previewRoute({
        path: '/film',
        target: 'previews-test/film.mp4',
        previewVideoWidth: 1920,
        previewVideoHeight: 1080,
      }),
    );
    const { body } = await send('/film', { 'User-Agent': 'Discordbot/2.0' });
    expect(body).toContain('<meta property="og:type" content="video.other">');
    expect(body).toContain(
      '<meta property="og:video" content="https://files.example.com/previews-test/film.mp4">',
    );
    expect(body).toContain('<meta property="og:video:type" content="video/mp4">');
    expect(body).toContain(
      '<meta name="twitter:player:stream" content="https://files.example.com/previews-test/film.mp4">',
    );
  });

  it('a file bucket with no custom domain gets a card without a file link', async () => {
    const domains = (await import('../../src/types')).R2_BUCKET_CUSTOM_DOMAINS;
    const saved = domains['files'];
    delete domains['files'];
    try {
      const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
      expectPreviewHeaders(response);
      expect(body).not.toContain('Open file');
    } finally {
      if (saved) domains['files'] = saved;
    }
  });
});

describe('the fetcher test comes first: a person never pays for the preview check', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    await seedR2Object(FILE_KEY, FILE_BYTES, 'application/pdf');
    await seedRoute(previewRoute());
  });
  afterEach(() => vi.restoreAllMocks());

  it("a person's request never validates the stored preview; a fetcher's does once", async () => {
    const check = vi.spyOn(linkPreview, 'routeServablePreview');
    const person = await send('/briefing', { 'User-Agent': CHROME });
    expect(person.body).toBe(FILE_BYTES);
    expect(check).not.toHaveBeenCalled();
    await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('the default image per domain', () => {
  const defaults = PREVIEW_DEFAULT_IMAGES as Record<string, PreviewImageRef | null>;
  const titleOnly = previewRoute({
    previewImageBucket: undefined,
    previewImageKey: undefined,
    previewImageWidth: undefined,
    previewImageHeight: undefined,
  });

  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    await seedR2Object(FILE_KEY, FILE_BYTES, 'application/pdf');
    await seedRoute(titleOnly);
  });
  afterEach(() => {
    defaults[TEST_DOMAIN] = null;
  });

  it('the shipped map (all null) gives a text-only card', async () => {
    const { response, body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expectPreviewHeaders(response);
    expect(body).not.toContain('og:image');
    expect(body).toContain('<meta name="twitter:card" content="summary">');
  });

  it("an operator's default shows on a titled route with no image, with its stored size", async () => {
    defaults[TEST_DOMAIN] = {
      bucket: 'assets',
      key: 'previews/default.png',
      width: 1200,
      height: 630,
    };
    const { body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(body).toContain(
      '<meta property="og:image" content="https://assets.example.com/previews/default.png">',
    );
    expect(body).toContain('<meta property="og:image:height" content="630">');
    // The route's own image wins
    await seedRoute(previewRoute());
    const own = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(own.body).toContain('previews/briefing%20card.jpg');
    expect(own.body).not.toContain('previews/default.png');
  });

  it('a default a route could not serve is skipped, never served', async () => {
    defaults[TEST_DOMAIN] = { bucket: 'files-user1', key: 'a.png', width: 1200, height: 630 };
    const { body } = await send('/briefing', { 'User-Agent': WHATSAPP });
    expect(body).not.toContain('og:image');
  });
});
