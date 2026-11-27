/**
 * The dashboard's link-preview panel on an r2 route with a stored preview
 * (v1.48.0): the own-host resolver answers with the very document a
 * link-preview fetcher receives, decided by the same predicates as the
 * serving branch, so the panel never shows a card the link does not serve.
 * Every other r2 route keeps the minimal result.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, KVRouteConfig } from '../../src/types';
import { ownHostResolver } from '../../src/utils/og-own-host';
import { minimalOpenGraph, parseOpenGraph } from '../../src/utils/og-parser';
import { clearAllRoutes, clearR2, seedR2Object, seedRoute } from '../helpers';
import { usePreviewBuckets } from '../link-preview-config';

usePreviewBuckets();

const HOST = 'links.example.com';
const PAGE_URL = `https://${HOST}/briefing`;

const preview = (url = PAGE_URL) =>
  parseOpenGraph(url, { ownHost: ownHostResolver(env as unknown as Bindings) });

const fileRoute = (overrides: Partial<KVRouteConfig> = {}): KVRouteConfig => ({
  path: '/briefing',
  type: 'r2',
  target: 'previews-test/briefing.pdf',
  previewTitle: 'Quarterly briefing',
  previewDescription: 'Facts & figures',
  previewImageBucket: 'assets',
  previewImageKey: 'previews/card.png',
  previewImageWidth: 1200,
  previewImageHeight: 630,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('own-host preview of an r2 route with a stored card', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await clearR2();
    vi.stubGlobal('fetch', vi.fn());
    await seedR2Object('previews-test/briefing.pdf', '%PDF', 'application/pdf');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the card fetchers receive: title, description and the image address', async () => {
    await seedRoute(fileRoute(), HOST);
    expect(await preview()).toEqual({
      title: 'Quarterly briefing',
      description: 'Facts & figures',
      image: 'https://assets.example.com/previews/card.png',
      siteName: null,
      url: PAGE_URL,
    });
    // Resolved in process: nothing is fetched
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each([
    ['no preview title', { previewTitle: undefined, previewDescription: undefined }],
    ['a stored preview out of shape', { previewTitle: ' padded ' }],
    ['a wildcard route', { path: '/briefing/*' }],
  ])('%s keeps the minimal result', async (_label, change) => {
    const route = fileRoute(change);
    await seedRoute(route, HOST);
    const url = route.path.endsWith('*') ? `https://${HOST}/briefing/x` : PAGE_URL;
    expect(await preview(url)).toEqual(minimalOpenGraph(url));
  });

  it('a missing object or an image file keeps the minimal result', async () => {
    await seedRoute(fileRoute({ target: 'previews-test/none.pdf' }), HOST);
    expect(await preview()).toEqual(minimalOpenGraph(PAGE_URL));
    await env.FILES_BUCKET.put('previews-test/card.png', 'png', {
      httpMetadata: { contentType: 'image/png' },
    });
    await seedRoute(fileRoute({ target: 'previews-test/card.png' }), HOST);
    expect(await preview()).toEqual(minimalOpenGraph(PAGE_URL));
  });

  it('a stored target the handler refuses keeps the minimal result, reading no object', async () => {
    await env.ROUTES.put(
      `${HOST}:/briefing`,
      JSON.stringify(fileRoute({ target: '../escape.pdf' })),
    );
    const head = vi.spyOn(env.FILES_BUCKET, 'head');
    expect(await preview()).toEqual(minimalOpenGraph(PAGE_URL));
    expect(head).not.toHaveBeenCalled();
  });
});
