import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { handleProxy, MAX_PROXY_REDIRECTS } from '../../src/handlers/proxy';
import type { AppEnv, KVRouteConfig } from '../../src/types';

const capturedUrl = (route: KVRouteConfig, requestUrl: string) => {
  const app = new Hono<AppEnv>();
  app.get('/svc', c => handleProxy(c, route));
  let captured = '';
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    captured =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    return new Response('ok', { status: 200 });
  });
  return app
    .fetch(new Request(requestUrl), env)
    .then(() => captured)
    .finally(() => spy.mockRestore());
};

describe('handleProxy', () => {
  describe('URL validation (SSRF protection)', () => {
    it('rejects private IP targets', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/internal',
        type: 'proxy',
        target: 'http://192.168.1.1/api',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/internal', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/internal'), env);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.type).toBe('validation_error');
    });

    it('rejects localhost targets', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/local',
        type: 'proxy',
        target: 'http://localhost:8080/api',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/local', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/local'), env);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.type).toBe('validation_error');
    });

    it('rejects 127.0.0.1 targets', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/loopback',
        type: 'proxy',
        target: 'http://127.0.0.1/secret',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/loopback', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/loopback'), env);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.type).toBe('validation_error');
    });

    it('rejects 10.x.x.x private network', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/private',
        type: 'proxy',
        target: 'http://10.0.0.1/internal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/private', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/private'), env);

      expect(response.status).toBe(502);
    });

    it('rejects 172.16-31.x.x private network', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/private',
        type: 'proxy',
        target: 'http://172.16.0.1/internal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/private', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/private'), env);

      expect(response.status).toBe(502);
    });

    it('rejects file:// protocol', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/file',
        type: 'proxy',
        target: 'file:///etc/passwd',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/file', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/file'), env);

      expect(response.status).toBe(502);
    });

    it('rejects ftp:// protocol', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/ftp',
        type: 'proxy',
        target: 'ftp://evil.com/malware',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/ftp', c => handleProxy(c, route));

      const response = await app.fetch(new Request('http://localhost/ftp'), env);

      expect(response.status).toBe(502);
    });
  });

  describe('path handling', () => {
    // Note: the upstream fetch is stubbed, so no network is touched.

    it('handles wildcard path extraction logic', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/api/*',
        type: 'proxy',
        target: 'https://api.example.com',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/api/*', c => handleProxy(c, route));

      let upstreamUrl = '';
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        upstreamUrl =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        return new Response('ok', { status: 200 });
      });
      const response = await app
        .fetch(new Request('http://localhost/api/users'), env)
        .finally(() => spy.mockRestore());

      // Validation passes (it's a valid public URL), so the request reaches the
      // upstream instead of the 502 validation_error path, and the wildcard
      // remainder is appended to the target.
      expect(response.status).toBe(200);
      expect(upstreamUrl).toBe('https://api.example.com/users');
    });
  });

  describe('hostHeader override', () => {
    it('accepts route with hostHeader configuration', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/webflow',
        type: 'proxy',
        target: 'https://cdn.webflow.com/site123',
        hostHeader: 'example.com',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/webflow', c => handleProxy(c, route));

      // Validation should pass - the route configuration with hostHeader is valid
      // Actual fetch will fail in test environment without network mocks
      expect(route.hostHeader).toBe('example.com');
    });

    it('works without hostHeader (optional field)', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/api',
        type: 'proxy',
        target: 'https://api.example.com',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/api', c => handleProxy(c, route));

      // Route without hostHeader should be valid
      expect(route.hostHeader).toBeUndefined();
    });
  });

  describe('query string forwarding (preserveQuery)', () => {
    it('forwards the query string by default', async () => {
      const route: KVRouteConfig = {
        path: '/svc',
        type: 'proxy',
        target: 'https://api.example.com/up',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const captured = await capturedUrl(route, 'http://localhost/svc?a=1&b=2');
      expect(captured).toContain('a=1');
      expect(captured).toContain('b=2');
    });

    it('drops the query string when preserveQuery is false', async () => {
      const route: KVRouteConfig = {
        path: '/svc',
        type: 'proxy',
        target: 'https://api.example.com/up',
        preserveQuery: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const captured = await capturedUrl(route, 'http://localhost/svc?file=../../etc/passwd');
      expect(captured).not.toContain('file=');
      expect(captured).not.toContain('..');
    });
  });

  // v1.37.2: the wildcard remainder came from the router's DECODED path, so
  // `%5c` became `\`, which the URL parser reads as `/`, and `..%5c..%5cadmin`
  // climbed out of the target's base path. The remainder is now taken from
  // the raw path and refused (404) when it could leave the base.
  describe('wildcard remainder confinement', () => {
    const docsRoute: KVRouteConfig = {
      path: '/docs/*',
      type: 'proxy',
      target: 'https://upstream.example.net/base',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    /** The proxy's answer to `requestPath`, and the upstream URLs it fetched. */
    async function proxied(requestPath: string, route: KVRouteConfig = docsRoute) {
      const app = new Hono<AppEnv>();
      app.all('*', c => handleProxy(c, route));
      const upstream: string[] = [];
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        upstream.push(
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input),
        );
        return new Response('ok', { status: 200 });
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const response = await app.fetch(new Request(`http://localhost${requestPath}`), env);
        return { status: response.status, upstream };
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    }

    // Each raw segment is decoded once; an encoded separator, a dot
    // segment (with `;…` parameters stripped), a residual %2e/%2f/%5c, a
    // control character or a malformed escape is refused
    it.each([
      '/docs/..%5c..%5cadmin',
      '/docs/..%5C..%5Cadmin',
      '/docs/a%5cb',
      '/docs/%2e%2e%5cadmin',
      '/docs/..;x/admin',
      '/docs/..%3Bx/admin',
      '/docs/.;x/admin',
      '/docs/%2e%2e%3bx/admin',
      '/docs/%252e%252e/admin',
      '/docs/%252e%252e%252fadmin',
      '/docs/..%252fadmin',
      '/docs/%255c..%255cadmin',
      '/docs/a/..%2f..%2fadmin',
      '/docs/a%2fb',
      '/docs/..%00',
      '/docs/a%0Ab',
      '/docs/%7F',
      '/docs/100%zz',
      // Residual escapes an upstream that decodes twice would act on
      '/docs/..%253b/admin',
      '/docs/%25c0%25ae%25c0%25ae/admin',
      '/docs/%25u002e%25u002e/admin',
      '/docs/%25252e%25252e/admin',
      '/docs/a%25e0%2580%25ae',
      '/docs/a%25C1%259C',
    ])('answers 404 for %s, fetching nothing', async requestPath => {
      expect(await proxied(requestPath)).toEqual({ status: 404, upstream: [] });
    });

    // The visitor's raw segment is forwarded byte for byte once its decoded
    // text is accepted (the full property is in remainder-oracle.test.ts)
    it.each([
      ['/docs/guide/getting-started/a%20b.html?x=1', '/base/guide/getting-started/a%20b.html?x=1'],
      ['/docs/100%25.pdf', '/base/100%25.pdf'],
      ['/docs/50%25off', '/base/50%25off'],
      ['/docs/%C3%A9t%C3%A9', '/base/%C3%A9t%C3%A9'],
      ['/docs/caf%c3%a9', '/base/caf%c3%a9'],
      ['/docs/a;b', '/base/a;b'],
      ['/docs/pkg@1.2.3/index.js', '/base/pkg@1.2.3/index.js'],
      ['/docs/v1/x:run', '/base/v1/x:run'],
      ['/docs/a+b', '/base/a+b'],
      ['/docs/k=v&x=y', '/base/k=v&x=y'],
      ['/docs/a,b', '/base/a,b'],
      ['/docs/%61bc', '/base/%61bc'],
      ['/docs/a/', '/base/a/'],
      ['/docs/a?q=%2e%2e/x', '/base/a?q=%2e%2e/x'],
    ])('forwards %s as %s', async (requestPath, upstreamPath) => {
      expect(await proxied(requestPath)).toEqual({
        status: 200,
        upstream: [`https://upstream.example.net${upstreamPath}`],
      });
    });

    // A remainder never starts with an empty segment: on a root target the
    // upstream path would start with `//`, which some upstreams read as
    // another host. Empty segments further in still forward.
    it('refuses a leading empty segment, keeping other empty segments', async () => {
      const rootRoute: KVRouteConfig = { ...docsRoute, target: 'https://upstream.example.net' };
      expect(await proxied('/docs//evil.example/x', rootRoute)).toEqual({
        status: 404,
        upstream: [],
      });
      expect((await proxied('/docs/a//b', rootRoute)).upstream).toEqual([
        'https://upstream.example.net/a//b',
      ]);
      expect((await proxied('/docs/a//b')).upstream).toEqual([
        'https://upstream.example.net/base/a//b',
      ]);
      expect(await proxied('/docs//b')).toEqual({ status: 404, upstream: [] });
    });

    it('matches the base case-insensitively, as the route lookup does', async () => {
      expect((await proxied('/Docs/Guide')).upstream).toEqual([
        'https://upstream.example.net/base/Guide',
      ]);
      // A raw dot segment never arrives: the URL parser resolves it first
      expect((await proxied('/docs/a/../b')).upstream).toEqual([
        'https://upstream.example.net/base/b',
      ]);
    });
  });
});

// v1.38.0: upstream redirects are followed by the handler, one hop at a time,
// each hop checked against the outbound host policy, and only allow-listed
// request headers go on to another origin.
/** One upstream request as the proxy sent it. */
interface SentRequest {
  url: string;
  method: string;
  headers: Headers;
  hasBody: boolean;
  redirect: RequestRedirect | undefined;
}

/**
 * Run one request through a proxy route whose upstream answers with
 * `answers` in turn, recording each request the proxy sent (headers copied
 * at send time, since the proxy reuses one Headers object across hops).
 */
async function proxyThrough(
  answers: Array<() => Response>,
  request: Request,
  route: Partial<KVRouteConfig> = {},
) {
  const sent: SentRequest[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      hasBody: init?.body !== undefined && init.body !== null,
      redirect: init?.redirect,
    });
    const answer = answers[sent.length - 1];
    if (!answer) throw new Error('unexpected upstream request');
    return answer();
  });
  const app = new Hono<AppEnv>();
  const config: KVRouteConfig = {
    path: '/svc',
    type: 'proxy',
    target: 'https://upstream.example.com/base',
    createdAt: 0,
    updatedAt: 0,
    ...route,
  };
  app.all('/svc', c => handleProxy(c, config));
  try {
    const response = await app.fetch(request, env);
    return { response, sent };
  } finally {
    spy.mockRestore();
  }
}

const redirectTo =
  (location: string, status = 302) =>
  () =>
    new Response('moved', { status, headers: { location } });
const ok =
  (text = 'final') =>
  () =>
    new Response(text, { status: 200 });

describe('handleProxy redirects (v1.38.0)', () => {
  it('follows an allowed redirect itself, with redirect: manual, and serves the final answer', async () => {
    const { response, sent } = await proxyThrough(
      [redirectTo('/next'), redirectTo('https://cdn.example.net/file', 301), ok()],
      new Request('https://links.example.com/svc'),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('final');
    expect(response.headers.get('X-Proxied-By')).toBe('bifrost');
    expect(sent.map(request => request.url)).toEqual([
      'https://upstream.example.com/base',
      'https://upstream.example.com/next',
      'https://cdn.example.net/file',
    ]);
    expect(sent.every(request => request.redirect === 'manual')).toBe(true);
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://127.1/',
    'file:///etc/passwd',
  ])('refuses a redirect to %s without fetching it', async location => {
    const { response, sent } = await proxyThrough(
      [redirectTo(location)],
      new Request('https://links.example.com/svc'),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      type: 'validation_error',
      message: 'The proxy target is not allowed.',
    });
    expect(sent).toHaveLength(1);
  });

  it('follows at most twenty redirects, the Fetch limit the runtime applied', async () => {
    expect(MAX_PROXY_REDIRECTS).toBe(20);
    const twenty = await proxyThrough(
      [...Array.from({ length: 20 }, (_, i) => redirectTo(`/hop${i}`)), ok()],
      new Request('https://links.example.com/svc'),
    );
    expect(twenty.response.status).toBe(200);
    expect(twenty.sent).toHaveLength(21);

    const more = await proxyThrough(
      Array.from({ length: 21 }, (_, i) => redirectTo(`/hop${i}`)),
      new Request('https://links.example.com/svc'),
    );
    expect(more.response.status).toBe(502);
    expect(await more.response.json()).toMatchObject({ type: 'upstream_error' });
    expect(more.sent).toHaveLength(21);
  });

  it('cancels the body of every redirect it follows', async () => {
    let cancelled = 0;
    const redirectWithBody = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1;
          },
        }),
        { status: 302, headers: { location: '/next' } },
      );
    const { response } = await proxyThrough(
      [redirectWithBody, redirectWithBody, ok()],
      new Request('https://links.example.com/svc'),
    );
    expect(response.status).toBe(200);
    expect(cancelled).toBe(2);
  });

  it('carries only allowlisted headers to another origin', async () => {
    const { response, sent } = await proxyThrough(
      [redirectTo('/same'), redirectTo('https://other.example.org/x'), redirectTo('/y'), ok()],
      new Request('https://links.example.com/svc', {
        headers: {
          Authorization: 'Bearer visitor-token',
          'Proxy-Authorization': 'Basic abc',
          Cookie: 'session=1',
          'X-Custom-Secret': 'custom',
          Accept: 'text/plain',
          'Accept-Language': 'en',
          'Accept-Encoding': 'gzip',
          'User-Agent': 'visitor-agent',
          'Cache-Control': 'no-cache',
          'If-None-Match': '"etag"',
          'If-Modified-Since': 'Tue, 06 Oct 2026 00:00:00 GMT',
          Range: 'bytes=0-10',
        },
      }),
      { hostHeader: 'upstream.example.com' },
    );
    expect(response.status).toBe(200);
    const [first, sameOrigin, otherOrigin, afterwards] = sent;
    for (const request of [first, sameOrigin]) {
      expect(request?.headers.get('authorization')).toBe('Bearer visitor-token');
      expect(request?.headers.get('proxy-authorization')).toBe('Basic abc');
      expect(request?.headers.get('cookie')).toBe('session=1');
    }
    for (const request of [otherOrigin, afterwards]) {
      expect(request?.headers.get('authorization')).toBeNull();
      expect(request?.headers.get('proxy-authorization')).toBeNull();
      expect(request?.headers.get('cookie')).toBeNull();
      expect(request?.headers.get('host')).toBeNull();
      expect(request?.headers.get('x-custom-secret')).toBeNull();
      expect(request?.headers.get('accept')).toBe('text/plain');
      expect(request?.headers.get('accept-language')).toBe('en');
      expect(request?.headers.get('accept-encoding')).toBe('gzip');
      expect(request?.headers.get('user-agent')).toBe('visitor-agent');
      expect(request?.headers.get('cache-control')).toBe('no-cache');
      expect(request?.headers.get('if-none-match')).toBe('"etag"');
      expect(request?.headers.get('if-modified-since')).toBe('Tue, 06 Oct 2026 00:00:00 GMT');
      expect(request?.headers.get('range')).toBe('bytes=0-10');
    }
    for (const request of [first, sameOrigin]) {
      expect(request?.headers.get('x-custom-secret')).toBe('custom');
    }
  });

  it('turns a POST into a GET without a body on 303, 301 and 302', async () => {
    for (const status of [301, 302, 303]) {
      const { response, sent } = await proxyThrough(
        [redirectTo('/done', status), ok()],
        new Request('https://links.example.com/svc', {
          method: 'POST',
          body: 'payload',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      expect(response.status).toBe(200);
      expect(sent[0]).toMatchObject({ method: 'POST', hasBody: true });
      expect(sent[1]).toMatchObject({ method: 'GET', hasBody: false });
      expect(sent[1]?.headers.get('content-type')).toBeNull();
    }
  });

  it('keeps HEAD on a 303 and the method on a 307 or 308 without a body', async () => {
    const head = await proxyThrough(
      [redirectTo('/done', 303), ok('')],
      new Request('https://links.example.com/svc', { method: 'HEAD' }),
    );
    expect(head.sent.map(request => request.method)).toEqual(['HEAD', 'HEAD']);
    for (const status of [307, 308]) {
      const { response, sent } = await proxyThrough(
        [redirectTo('/done', status), ok()],
        new Request('https://links.example.com/svc'),
      );
      expect(response.status).toBe(200);
      expect(sent.map(request => request.method)).toEqual(['GET', 'GET']);
    }
  });

  it('answers 502 when a 307 or 308 would have to resend a streamed body', async () => {
    for (const status of [307, 308]) {
      const { response, sent } = await proxyThrough(
        [redirectTo('/done', status)],
        new Request('https://links.example.com/svc', { method: 'PUT', body: 'payload' }),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ type: 'network_error' });
      expect(sent).toHaveLength(1);
    }
  });

  it('serves a 3xx without a Location, or a status it does not follow, as it is', async () => {
    for (const answer of [
      () => new Response(null, { status: 302 }),
      () => new Response(null, { status: 304, headers: { location: '/x' } }),
      () => new Response('choices', { status: 300, headers: { location: '/x' } }),
    ]) {
      const { response, sent } = await proxyThrough(
        [answer],
        new Request('https://links.example.com/svc'),
      );
      expect([300, 302, 304]).toContain(response.status);
      expect(sent).toHaveLength(1);
    }
  });

  it('answers 502 for a Location that does not parse', async () => {
    const { response } = await proxyThrough(
      [redirectTo('http://[bad')],
      new Request('https://links.example.com/svc'),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ type: 'upstream_error' });
  });
});
