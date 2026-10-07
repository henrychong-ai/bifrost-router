/**
 * Link previews of URLs on the Worker's own domains (v1.37.2). A Worker
 * cannot fetch a host it serves through the public edge, so those hops are
 * resolved in process from the same KV routes and service bindings the router
 * uses; every other host is still fetched. The host policy, hop cap, timeout
 * and body cap apply to every hop either way.
 */

import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv, Bindings, KVRouteConfig } from '../../src/types';
import { ownHostResolver } from '../../src/utils/og-own-host';
import {
  MAX_REDIRECTS,
  minimalOpenGraph,
  OPEN_GRAPH_REQUEST_HEADERS,
  parseOpenGraph,
  ResponseTooLargeError,
  SSRFBlockedError,
  TooManyRedirectsError,
} from '../../src/utils/og-parser';
import { clearAllRoutes, seedRoute } from '../helpers';

const HTML = { 'content-type': 'text/html' };

/** The URLs the stubbed global fetch was called with, in order. */
function fetchedUrls(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()));
}

/** A route on `domain`, enabled unless it says otherwise. */
function route(fields: Partial<KVRouteConfig> & Pick<KVRouteConfig, 'path' | 'type' | 'target'>) {
  return { enabled: true, ...fields } as KVRouteConfig;
}

/** A service binding that answers every request with `answer`, recording each. */
function serviceBinding(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = {
    fetch: vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return answer(request);
      },
    ),
  } as unknown as Fetcher;
  return { fetcher, requests };
}

/** A preview of `url` with own-host resolution for `bindings`. */
function preview(url: string, bindings: Partial<Bindings> = {}, maxRedirects?: number) {
  return parseOpenGraph(url, {
    ownHost: ownHostResolver({ ...env, ...bindings } as Bindings),
    ...(maxRedirects !== undefined && { maxRedirects }),
  });
}

describe('own-domain link previews', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an own-host short link in process and fetches only its destination', async () => {
    await seedRoute(
      route({ path: '/promo', type: 'redirect', target: 'https://dest.example.net/page' }),
      'links.example.com',
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<meta property="og:title" content="Destination">', { headers: HTML }),
    );

    const result = await preview('https://links.example.com/promo');

    expect(fetchedUrls()).toEqual(['https://dest.example.net/page']);
    expect(result).toMatchObject({ title: 'Destination', url: 'https://dest.example.net/page' });
  });

  it('sends the visitor to the same destination as the redirect handler', async () => {
    await seedRoute(
      route({
        path: '/docs/*',
        type: 'redirect',
        target: 'https://dest.example.net/base?kept=1',
        preservePath: true,
        statusCode: 301,
      }),
      'links.example.com',
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Doc</title>', { headers: HTML }));

    await preview('https://links.example.com/docs/a/b?kept=2&extra=3');

    expect(fetchedUrls()).toEqual(['https://dest.example.net/base/a/b?kept=1&extra=3']);
  });

  it('follows an own-host redirect chain in process, then fetches the page it lands on', async () => {
    await seedRoute(
      route({ path: '/a', type: 'redirect', target: 'https://links.example.com/b' }),
      'links.example.com',
    );
    await seedRoute(
      route({ path: '/b', type: 'redirect', target: 'https://secondary.example.net/c' }),
      'links.example.com',
    );
    await seedRoute(
      route({ path: '/c', type: 'redirect', target: 'https://dest.example.net/final' }),
      'secondary.example.net',
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Final</title>', { headers: HTML }));

    const result = await preview('https://links.example.com/a');

    expect(fetchedUrls()).toEqual(['https://dest.example.net/final']);
    expect(result).toMatchObject({ title: 'Final', url: 'https://dest.example.net/final' });
  });

  // Host matching follows the router: the FQDN spelling reaches the Worker,
  // so it is never fetched, but the router looks it up with its dot and finds
  // nothing; a non-default port is not served by the Worker at all
  it('resolves a trailing-dot host as the router does, and fetches a non-default port', async () => {
    await seedRoute(
      route({ path: '/c', type: 'redirect', target: 'https://dest.example.net/final' }),
      'secondary.example.net',
    );
    await expect(preview('https://secondary.example.net./c')).rejects.toThrow(/^HTTP 404$/);
    expect(fetchedUrls()).toEqual([]);

    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Port</title>', { headers: HTML }));
    expect((await preview('https://secondary.example.net:8443/c')).title).toBe('Port');
    expect(fetchedUrls()).toEqual(['https://secondary.example.net:8443/c']);
  });

  it('applies the admin-host traversal refusal to the exact admin hostname only', async () => {
    const admin = { ADMIN_API_DOMAIN: 'bifrost.example.com' };
    await seedRoute(
      route({ path: '/', type: 'redirect', target: 'https://dest.example.net/' }),
      'bifrost.example.com.',
    );
    vi.mocked(fetch).mockResolvedValue(new Response('<title>Dest</title>', { headers: HTML }));
    const exact = 'https://bifrost.example.com/?file=../x';
    expect(await preview(exact, admin)).toEqual(minimalOpenGraph(exact));
    // With its dot the hostname is not the admin host to denySensitivePaths
    // either, so the router looks up its routes under that spelling
    expect((await preview('https://bifrost.example.com./?file=../x', admin)).title).toBe('Dest');
  });

  it('counts own-host hops against the same redirect cap', async () => {
    await seedRoute(
      route({ path: '/a', type: 'redirect', target: 'https://links.example.com/b' }),
      'links.example.com',
    );
    await seedRoute(
      route({ path: '/b', type: 'redirect', target: 'https://links.example.com/a' }),
      'links.example.com',
    );

    await expect(preview('https://links.example.com/a')).rejects.toThrow(
      `Too many redirects (max ${MAX_REDIRECTS})`,
    );
    await expect(preview('https://links.example.com/a', {}, 1)).rejects.toBeInstanceOf(
      TooManyRedirectsError,
    );
    expect(fetchedUrls()).toEqual([]);
  });

  it('applies the host policy to a hop an own-host route redirects to', async () => {
    await seedRoute(
      route({ path: '/internal', type: 'redirect', target: 'http://169.254.169.254/latest' }),
      'links.example.com',
    );
    await expect(preview('https://links.example.com/internal')).rejects.toBeInstanceOf(
      SSRFBlockedError,
    );
    expect(fetchedUrls()).toEqual([]);
  });

  it('answers through the service binding when no route matches', async () => {
    const site = serviceBinding(
      () =>
        new Response(
          '<meta property="og:title" content="Site page"><meta property="og:image" content="/card.png">',
          {
            headers: HTML,
          },
        ),
    );

    const result = await preview('https://example.com/about?x=1', { EXAMPLE_SITE: site.fetcher });

    expect(fetchedUrls()).toEqual([]);
    expect(site.requests.map(request => request.url)).toEqual(['https://example.com/about?x=1']);
    for (const [name, value] of Object.entries(OPEN_GRAPH_REQUEST_HEADERS)) {
      expect(site.requests[0]?.headers.get(name)).toBe(value);
    }
    expect(result).toEqual({
      title: 'Site page',
      description: null,
      image: 'https://example.com/card.png',
      siteName: null,
      url: 'https://example.com/about?x=1',
    });
  });

  it('follows a redirect the service binding answers with, under the cap', async () => {
    const site = serviceBinding(request =>
      new URL(request.url).pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('<title>New</title>', { headers: HTML }),
    );

    const result = await preview('https://example.com/old', { EXAMPLE_SITE: site.fetcher });

    expect(site.requests.map(request => request.url)).toEqual([
      'https://example.com/old',
      'https://example.com/new',
    ]);
    expect(result).toMatchObject({ title: 'New', url: 'https://example.com/new' });
    expect(fetchedUrls()).toEqual([]);
  });

  it('applies the body cap to a service-binding page', async () => {
    const site = serviceBinding(
      () => new Response(`<title>${'a'.repeat(1024 * 1024)}</title>`, { headers: HTML }),
    );
    await expect(
      preview('https://example.com/huge', { EXAMPLE_SITE: site.fetcher }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('reports a failing service binding as the router does: HTTP 503', async () => {
    const failing = {
      fetch: vi
        .fn<() => Promise<Response>>()
        .mockRejectedValue(new Error('binding down: internal detail')),
    } as unknown as Fetcher;
    await expect(preview('https://example.com/page', { EXAMPLE_SITE: failing })).rejects.toThrow(
      /^HTTP 503$/,
    );
  });

  it('prefers a KV route over the service binding, as the router does', async () => {
    const site = serviceBinding(() => new Response('<title>Site</title>', { headers: HTML }));
    await seedRoute(route({ path: '/go', type: 'redirect', target: 'https://dest.example.net/' }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Dest</title>', { headers: HTML }));

    expect((await preview('https://example.com/go', { EXAMPLE_SITE: site.fetcher })).title).toBe(
      'Dest',
    );
    expect(site.requests).toEqual([]);
  });

  it('describes nothing for a redirect to a non-web destination', async () => {
    await seedRoute(
      route({ path: '/call', type: 'redirect', target: 'tel:+15550100' }),
      'links.example.com',
    );
    await seedRoute(
      route({ path: '/mail', type: 'redirect', target: 'mailto:team@example.com' }),
      'links.example.com',
    );
    for (const url of ['https://links.example.com/call', 'https://links.example.com/mail']) {
      expect(await preview(url)).toEqual(minimalOpenGraph(url));
    }
    expect(fetchedUrls()).toEqual([]);
  });

  it('follows a redirect route stored with a status code no write accepts, as the router does (302)', async () => {
    for (const statusCode of [200, 999]) {
      await clearAllRoutes();
      await env.ROUTES.put(
        'links.example.com:/odd',
        JSON.stringify({
          path: '/odd',
          type: 'redirect',
          target: 'https://dest.example.net/odd',
          statusCode,
        }),
      );
      vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Odd</title>', { headers: HTML }));
      const result = await preview('https://links.example.com/odd');
      expect(result).toMatchObject({ title: 'Odd', url: 'https://dest.example.net/odd' });
    }
  });

  it('answers 500, as the router does, for a redirect route whose target is not a URL', async () => {
    await seedRoute(
      route({ path: '/broken', type: 'redirect', target: 'not a url' }),
      'links.example.com',
    );
    await expect(preview('https://links.example.com/broken')).rejects.toThrow(/^HTTP 500$/);
    expect(fetchedUrls()).toEqual([]);
  });

  it('answers 404 for an unknown or disabled own-host path, fetching nothing', async () => {
    await seedRoute(
      route({
        path: '/off',
        type: 'redirect',
        target: 'https://dest.example.net/',
        enabled: false,
      }),
      'links.example.com',
    );
    for (const url of ['https://links.example.com/missing', 'https://links.example.com/off']) {
      await expect(preview(url)).rejects.toThrow(/^HTTP 404$/);
    }
    expect(fetchedUrls()).toEqual([]);
  });

  it('describes nothing on a path the Worker answers itself', async () => {
    const site = serviceBinding(() => new Response('<title>Site</title>', { headers: HTML }));
    // Routes stored at those paths are unreachable for a visitor
    for (const path of ['/health', '/api/routes', '/.well-known/security.txt', '/src/index.ts']) {
      await seedRoute(route({ path, type: 'redirect', target: 'https://dest.example.net/' }));
    }
    for (const url of [
      'https://example.com/health',
      'https://example.com/api',
      'https://example.com/api/',
      'https://example.com/api/routes',
      'https://example.com/.well-known/security.txt',
      'https://example.com/src/index.ts',
      'https://example.com/WRANGLER.TOML',
      'https://visitor@example.com/page',
    ]) {
      expect(await preview(url, { EXAMPLE_SITE: site.fetcher })).toEqual(minimalOpenGraph(url));
    }
    // A traversal-shaped query is refused on the admin host only
    const admin = 'https://bifrost.example.com/?file=../../etc';
    expect(await preview(admin, { ADMIN_API_DOMAIN: 'bifrost.example.com' })).toEqual(
      minimalOpenGraph(admin),
    );
    expect(site.requests).toEqual([]);
    expect(fetchedUrls()).toEqual([]);
  });

  it('resolves the paths the router hands to its routes: other /.well-known, other case', async () => {
    for (const path of ['/api', '/.well-known/other', '/health-check']) {
      await seedRoute(route({ path, type: 'redirect', target: `https://dest.example.net${path}` }));
    }
    vi.mocked(fetch).mockImplementation(
      async () => new Response('<title>Dest</title>', { headers: HTML }),
    );
    for (const path of ['/.well-known/other', '/health-check', '/Api']) {
      expect((await preview(`https://example.com${path}`)).title).toBe('Dest');
    }
    expect(fetchedUrls()).toEqual([
      'https://dest.example.net/.well-known/other',
      'https://dest.example.net/health-check',
      'https://dest.example.net/api',
    ]);
  });

  it('resolves the admin host in process too, so a development deployment previews its links', async () => {
    await seedRoute(
      route({ path: '/go', type: 'redirect', target: 'https://dest.example.net/dev' }),
      'admin.dev.example.org',
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Dev</title>', { headers: HTML }));
    const result = await preview('https://admin.dev.example.org/go', {
      ADMIN_API_DOMAIN: 'admin.dev.example.org',
    });
    expect(result.title).toBe('Dev');
    expect(fetchedUrls()).toEqual(['https://dest.example.net/dev']);
  });

  it('answers through the service binding for a disabled route, as the router does', async () => {
    const site = serviceBinding(() => new Response('<title>Site</title>', { headers: HTML }));
    await seedRoute(
      route({
        path: '/off',
        type: 'redirect',
        target: 'https://dest.example.net/',
        enabled: false,
      }),
    );
    expect((await preview('https://example.com/off', { EXAMPLE_SITE: site.fetcher })).title).toBe(
      'Site',
    );
    expect(fetchedUrls()).toEqual([]);
  });

  it('describes an r2 route minimally, reading no object', async () => {
    await seedRoute(
      route({ path: '/file', type: 'r2', target: 'docs/file.pdf' }),
      'links.example.com',
    );
    expect(await preview('https://links.example.com/file')).toEqual(
      minimalOpenGraph('https://links.example.com/file'),
    );
    expect(fetchedUrls()).toEqual([]);
  });

  describe('proxy routes', () => {
    beforeEach(async () => {
      await seedRoute(
        route({ path: '/blog/*', type: 'proxy', target: 'https://upstream.example.net/base' }),
        'links.example.com',
      );
    });

    it('fetches the upstream page and reports it under the public URL', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          '<meta property="og:title" content="Post"><meta property="og:url" content="/canonical">',
          { headers: HTML },
        ),
      );

      const result = await preview('https://links.example.com/blog/post?q=1');

      expect(fetchedUrls()).toEqual(['https://upstream.example.net/base/post?q=1']);
      const init = vi.mocked(fetch).mock.calls[0]?.[1];
      expect(init).toMatchObject({ headers: OPEN_GRAPH_REQUEST_HEADERS, redirect: 'manual' });
      expect(result).toMatchObject({
        title: 'Post',
        url: 'https://links.example.com/blog/post?q=1',
      });
    });

    // The page's own og:url would name the upstream
    it('reports the public URL even when the upstream page has an absolute og:url', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          '<meta property="og:title" content="Post">' +
            '<meta property="og:url" content="https://upstream.example.net/base/post">',
          { headers: HTML },
        ),
      );
      const result = await preview('https://links.example.com/blog/post');
      expect(result.url).toBe('https://links.example.com/blog/post');
      expect(JSON.stringify(result)).not.toContain('upstream.example.net');
    });

    it('follows an upstream redirect, still under the public URL', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(null, { status: 301, headers: { location: '/base/moved' } }),
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.net/final' },
          }),
        )
        .mockResolvedValueOnce(new Response('<title>Moved</title>', { headers: HTML }));

      const result = await preview('https://links.example.com/blog/old');

      expect(fetchedUrls()).toEqual([
        'https://upstream.example.net/base/old',
        'https://upstream.example.net/base/moved',
        'https://cdn.example.net/final',
      ]);
      expect(result).toEqual({
        title: 'Moved',
        description: null,
        image: null,
        siteName: null,
        url: 'https://links.example.com/blog/old',
      });
    });

    it('describes nothing once upstream redirects pass the same cap', async () => {
      vi.mocked(fetch).mockImplementation(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://upstream.example.net/x' },
          }),
      );
      expect(await preview('https://links.example.com/blog/loop', {}, 2)).toEqual(
        minimalOpenGraph('https://links.example.com/blog/loop'),
      );
      expect(fetchedUrls()).toHaveLength(3);
    });

    it('describes nothing when the upstream, or its redirect, is one of our own hosts', async () => {
      await seedRoute(
        route({ path: '/self', type: 'proxy', target: 'https://example.com/page' }),
        'links.example.com',
      );
      expect(await preview('https://links.example.com/self')).toEqual(
        minimalOpenGraph('https://links.example.com/self'),
      );
      expect(fetchedUrls()).toEqual([]);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://links.example.com/x' } }),
      );
      expect(await preview('https://links.example.com/blog/post')).toEqual(
        minimalOpenGraph('https://links.example.com/blog/post'),
      );
      expect(fetchedUrls()).toEqual(['https://upstream.example.net/base/post']);
    });

    it('lets an upstream that outlasts the timeout fail as a timeout', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(fetch).mockImplementation(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        );
        const outcome = preview('https://links.example.com/blog/slow').then(
          () => 'resolved',
          (error: unknown) => (error as Error).name,
        );
        await vi.advanceTimersByTimeAsync(5000);
        expect(await outcome).toBe('AbortError');
      } finally {
        vi.useRealTimers();
      }
    });

    it('describes nothing when an upstream redirect is refused, naming nothing', async () => {
      for (const location of [
        'http://10.0.0.1/admin',
        'http://[::1]/',
        'file:///etc/passwd',
        'http://[bad',
      ]) {
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location } }),
        );
        expect(await preview('https://links.example.com/blog/post')).toEqual(
          minimalOpenGraph('https://links.example.com/blog/post'),
        );
      }
      // Only the first hop of each was fetched; no refused target ever was
      expect(fetchedUrls()).toEqual(Array(4).fill('https://upstream.example.net/base/post'));
    });

    it('describes nothing for a Host override or a refused target', async () => {
      await seedRoute(
        route({
          path: '/hosted',
          type: 'proxy',
          target: 'https://upstream.example.net/',
          hostHeader: 'site.example.org',
        }),
        'links.example.com',
      );
      await seedRoute(
        route({ path: '/private', type: 'proxy', target: 'http://10.0.0.1/' }),
        'links.example.com',
      );
      for (const url of ['https://links.example.com/hosted', 'https://links.example.com/private']) {
        expect(await preview(url)).toEqual(minimalOpenGraph(url));
      }
      expect(fetchedUrls()).toEqual([]);
    });

    it('reports a failed upstream as HTTP 502, naming nothing', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('connect failed: upstream.example.net'));
      const failure = await preview('https://links.example.com/blog/down').then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe('HTTP 502');
      expect(failure?.cause).toBeUndefined();
    });

    it('answers 404 for a path that would leave the target base path', async () => {
      for (const url of [
        'https://links.example.com/blog/..%5c..%5cadmin',
        'https://links.example.com/blog/%2e%2e/admin',
      ]) {
        await expect(preview(url)).rejects.toThrow(/^HTTP 404$/);
      }
      expect(fetchedUrls()).toEqual([]);
    });
  });

  it('still fetches a host this Worker does not serve', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<title>Other</title>', { headers: HTML }));
    const result = await preview('https://other.example.org/page');
    expect(fetchedUrls()).toEqual(['https://other.example.org/page']);
    expect(result.title).toBe('Other');
  });

  it('stops an own-host hop that outlasts the timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging = {
        fetch: vi.fn<() => Promise<Response>>(() => new Promise<Response>(() => undefined)),
      } as unknown as Fetcher;
      const outcome = preview('https://example.com/slow', { EXAMPLE_SITE: hanging }).then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe('AbortError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a response that arrives after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const late = {
        fetch: vi.fn<() => Promise<Response>>(
          () =>
            new Promise<Response>(resolve => {
              setTimeout(() => {
                const body = new ReadableStream({
                  cancel: () => {
                    cancelled = true;
                  },
                });
                resolve(new Response(body, { headers: HTML }));
              }, 6000);
            }),
        ),
      } as unknown as Fetcher;
      const outcome = preview('https://example.com/late', { EXAMPLE_SITE: late }).then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe('AbortError');
      expect(cancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A Request constructor can refuse an escape the URL parser accepts (workerd
  // has, for malformed escapes). The path is derived without one, a refused
  // binding request is the router's 503, and no error text reaches the
  // response. The refusal is simulated, since the current runtime accepts them.
  it('resolves a URL a Request would refuse, quoting no error', async () => {
    const NativeRequest = Request;
    vi.stubGlobal(
      'Request',
      class extends NativeRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          if (String(input instanceof NativeRequest ? input.url : input).includes('/%2x/')) {
            throw new TypeError('Invalid URL: refused-escape detail');
          }
          super(input, init);
        }
      },
    );
    await seedRoute(
      route({ path: '/docs/*', type: 'redirect', target: 'https://dest.example.net/' }),
      'links.example.com',
    );
    vi.mocked(fetch).mockResolvedValue(new Response('<title>Doc</title>', { headers: HTML }));
    const site = serviceBinding(() => new Response('<title>Site</title>', { headers: HTML }));
    const app = new Hono<AppEnv>().route('/api', adminRoutes);
    const outcomes: Array<[number, string]> = [];
    for (const target of ['https://links.example.com/docs/%2x/a', 'https://example.com/%2x/page']) {
      const response = await app.fetch(
        new NativeRequest(`http://example.com/api/metadata/og?url=${encodeURIComponent(target)}`, {
          headers: { 'X-Admin-Key': 'test-api-key-12345' },
        }),
        { ...env, ADMIN_API_DOMAIN: 'example.com', EXAMPLE_SITE: site.fetcher },
      );
      outcomes.push([response.status, await response.text()]);
    }
    for (const [, text] of outcomes) expect(text).not.toContain('refused-escape');
    // The short link resolves; the binding host answers as the router would
    expect(outcomes[0]?.[0]).toBe(200);
    expect(outcomes[1]).toEqual([502, expect.stringContaining('HTTP 503')]);
    expect(site.requests).toEqual([]);
  });

  it('answers a failure inside the resolver as a bare HTTP 502, logging fixed text', async () => {
    const failingRoutes = {
      get: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('KV down: secret detail')),
    } as unknown as KVNamespace;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failure = await preview('https://links.example.com/x', { ROUTES: failingRoutes }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe('HTTP 502');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret detail');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('serves own-domain previews through GET /api/metadata/og', async () => {
    await seedRoute(
      route({ path: '/promo', type: 'redirect', target: 'https://dest.example.net/page' }),
      'links.example.com',
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<meta property="og:title" content="Via API">', { headers: HTML }),
    );
    const app = new Hono<AppEnv>().route('/api', adminRoutes);

    const response = await app.fetch(
      new Request(
        `http://example.com/api/metadata/og?url=${encodeURIComponent('https://links.example.com/promo')}`,
        { headers: { 'X-Admin-Key': 'test-api-key-12345' } },
      ),
      { ...env, ADMIN_API_DOMAIN: 'example.com' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { title: 'Via API' } });
    expect(fetchedUrls()).toEqual(['https://dest.example.net/page']);
  });
});
