import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import {
  MAX_REDIRECTS,
  minimalOpenGraph,
  parseOpenGraph,
  ResponseTooLargeError,
  SSRFBlockedError,
  TooManyRedirectsError,
  validateUrlForSSRF,
} from '../../src/utils/og-parser';

const HTML = { 'content-type': 'text/html' };

/** The URLs the stubbed fetch was called with, in order. */
function fetchedUrls(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()));
}

/** The preview title parsed from a page whose <title> holds `encoded`. */
async function titleOf(encoded: string): Promise<string | null> {
  vi.mocked(fetch).mockResolvedValue(new Response(`<title>${encoded}</title>`, { headers: HTML }));
  return (await parseOpenGraph('https://example.com/article')).title;
}

/** A preview whose page sets og:image and og:url to the given values. */
async function previewOf(image: string, url: string) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      `<meta property="og:title" content="T"><meta property="og:image" content="${image}">` +
        `<meta property="og:url" content="${url}">`,
      { headers: HTML },
    ),
  );
  return parseOpenGraph('https://example.com/a/page');
}

/** A response body that records whether it was cancelled. */
function trackedBody(): { body: ReadableStream; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream({
    cancel: () => {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe('parseOpenGraph', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // v1.37.0: one pass over the source text. The old chain decoded numeric
  // references before `&amp;`, so `&#38;amp;` became `&`; every entity is now
  // decoded exactly once.
  describe('entity decoding', () => {
    it.each([
      ['&amp;lt;', '&lt;'],
      ['&amp;amp;', '&amp;'],
      ['&amp;#60;', '&#60;'],
      ['&amp;#x3C;', '&#x3C;'],
      ['&#38;amp;', '&amp;'],
      ['&#x26;amp;', '&amp;'],
      ['&#x26;lt;', '&lt;'],
      ['&#38;#38;', '&#38;'],
    ])('decodes %s exactly once, to %s', async (encoded, decoded) => {
      expect(await titleOf(encoded)).toBe(decoded);
    });

    it('decodes the named entities', async () => {
      expect(await titleOf('a&amp;b &quot;q&quot; 1&gt;0 x&nbsp;y')).toBe('a&b "q" 1>0 x y');
      // `<` cannot appear raw inside <title>, so check &lt; on its own.
      expect(await titleOf('&lt;tag')).toBe('<tag');
    });

    it('decodes decimal and hexadecimal references, either x case', async () => {
      expect(await titleOf('&#39;&#65;&#x42;&#X43;&#x4a;')).toBe("'ABCJ");
    });

    it('decodes a code point beyond the Basic Multilingual Plane', async () => {
      expect(await titleOf('Launch &#128640; &#x1F680;')).toBe('Launch \u{1F680} \u{1F680}');
    });

    it('leaves unknown, case-mismatched and out-of-range entities as written', async () => {
      expect(await titleOf('&copy; &AMP; &#99999999; &#x110000; &amp')).toBe(
        '&copy; &AMP; &#99999999; &#x110000; &amp',
      );
    });

    it('leaves a 400-digit reference as written', async () => {
      const huge = `&#${'9'.repeat(400)};`;
      expect(await titleOf(`x ${huge} y`)).toBe(`x ${huge} y`);
    });

    it.each([
      ['&#0;', '�'],
      ['&#x0;', '�'],
      ['&#xD800;', '�'],
      ['&#57343;', '�'],
      // A pair written as two references is two lone surrogates (as in HTML).
      ['&#xD83D;&#xDE80;', '��'],
    ])('decodes %s to U+FFFD, as browsers do', async (encoded, decoded) => {
      expect(await titleOf(`a${encoded}b`)).toBe(`a${decoded}b`);
    });

    it('decodes &apos; (case-sensitive)', async () => {
      expect(await titleOf('it&apos;s &APOS;')).toBe("it's &APOS;");
    });

    it('decodes og:title content the same way', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('<meta property="og:title" content="R&amp;amp;D &amp;lt;beta&amp;gt;">', {
          headers: HTML,
        }),
      );
      const preview = await parseOpenGraph('https://example.com/article');
      expect(preview.title).toBe('R&amp;D &lt;beta&gt;');
    });
  });

  // v1.37.0: og:image and og:url come from the fetched page; only http(s)
  // survives (the dashboard renders the image as <img src>).
  describe('og:image and og:url schemes', () => {
    it.each([
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:image/svg+xml,x',
      'blob:https://example.com/1',
      'ftp://example.com/x.png',
    ])('drops %s', async scheme => {
      const preview = await previewOf(scheme, scheme);
      expect(preview.image).toBeNull();
      // og:url falls back to the fetched page's URL.
      expect(preview.url).toBe('https://example.com/a/page');
    });

    it('resolves relative and protocol-relative values against the page', async () => {
      const preview = await previewOf('//cdn.example.net/card.png', '/canonical');
      expect(preview.image).toBe('https://cdn.example.net/card.png');
      expect(preview.url).toBe('https://example.com/canonical');
    });

    it('keeps absolute http and https values', async () => {
      const preview = await previewOf('http://img.example.org/c.png', 'https://example.com/p');
      expect(preview.image).toBe('http://img.example.org/c.png');
      expect(preview.url).toBe('https://example.com/p');
    });

    it('decodes entities before checking the scheme', async () => {
      const preview = await previewOf(
        '&#106;avascript:alert(1)',
        'https://example.com/?a=1&amp;b=2',
      );
      expect(preview.image).toBeNull();
      expect(preview.url).toBe('https://example.com/?a=1&b=2');
    });
  });

  // v1.37.0: the redirect recursion had no cap, and redirect, error and
  // non-HTML bodies were never read or released.
  describe('redirects and response bodies', () => {
    it('follows a redirect to the page it lands on', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/moved' } }))
        .mockResolvedValueOnce(new Response('<title>Moved</title>', { headers: HTML }));

      const preview = await parseOpenGraph('https://example.com/old');

      expect(fetchedUrls()).toEqual(['https://example.com/old', 'https://example.com/moved']);
      expect(preview.title).toBe('Moved');
      expect(preview.url).toBe('https://example.com/moved');
    });

    it(`stops an A→B→A redirect loop after ${MAX_REDIRECTS} hops`, async () => {
      const cancelled: string[] = [];
      vi.mocked(fetch).mockImplementation(async input => {
        const url = input instanceof Request ? input.url : input.toString();
        const next = url === 'https://a.example/' ? 'https://b.example/' : 'https://a.example/';
        const body = new ReadableStream({
          cancel: () => {
            cancelled.push(url);
          },
        });
        return new Response(body, { status: 302, headers: { location: next } });
      });

      await expect(parseOpenGraph('https://a.example/')).rejects.toThrow(TooManyRedirectsError);

      // The first fetch plus MAX_REDIRECTS followed hops, alternating A and B.
      expect(fetchedUrls()).toHaveLength(MAX_REDIRECTS + 1);
      expect(fetchedUrls().slice(0, 3)).toEqual([
        'https://a.example/',
        'https://b.example/',
        'https://a.example/',
      ]);
      // Every redirect body is released, the last one included.
      expect(cancelled).toHaveLength(MAX_REDIRECTS + 1);
    });

    it('ignores any hop count a caller passes: the cap always counts from zero', async () => {
      vi.mocked(fetch).mockImplementation(async input => {
        const url = input instanceof Request ? input.url : input.toString();
        return new Response(null, { status: 302, headers: { location: `${url}x` } });
      });
      // A stray third argument, as `urls.map(parseOpenGraph)` would pass the
      // array, or a negative count, must not buy extra hops
      const loose = parseOpenGraph as (...args: unknown[]) => Promise<unknown>;
      await expect(loose('https://loop.example/', {}, -100)).rejects.toThrow(TooManyRedirectsError);
      expect(fetchedUrls()).toHaveLength(MAX_REDIRECTS + 1);
      await expect(
        Promise.all(['https://loop.example/'].map(url => loose(url, undefined, ['x']))),
      ).rejects.toThrow(TooManyRedirectsError);
      expect(fetchedUrls()).toHaveLength(2 * (MAX_REDIRECTS + 1));
    });

    it('reports the effective redirect cap', async () => {
      vi.mocked(fetch).mockImplementation(async input => {
        const url = input instanceof Request ? input.url : input.toString();
        return new Response(null, { status: 302, headers: { location: `${url}x` } });
      });

      await expect(parseOpenGraph('https://loop.example/', { maxRedirects: 2 })).rejects.toThrow(
        'Too many redirects (max 2)',
      );
      expect(fetchedUrls()).toHaveLength(3);
    });

    it('checks the hop cap before the Location: at the cap a redirect is always TooManyRedirects', async () => {
      for (const headers of [{ location: 'http://127.0.0.1/' }, {} as Record<string, string>]) {
        vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers }));
        await expect(
          parseOpenGraph('https://a.example/', { maxRedirects: 0 }),
        ).rejects.toBeInstanceOf(TooManyRedirectsError);
      }
      expect(fetchedUrls()).toEqual(['https://a.example/', 'https://a.example/']);
    });

    it.each([
      ['a 3xx without Location', { status: 301 }, /HTTP 301/],
      [
        'a 3xx whose Location fails SSRF validation',
        { status: 302, location: 'http://127.0.0.1/' },
        SSRFBlockedError,
      ],
      ['a non-OK answer', { status: 500 }, /HTTP 500/],
    ] as const)('releases the body of %s before throwing', async (_label, shape, error) => {
      const tracked = trackedBody();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(tracked.body, {
          status: shape.status,
          headers: 'location' in shape ? { location: shape.location } : {},
        }),
      );

      await expect(parseOpenGraph('https://a.example/')).rejects.toThrow(error);
      expect(tracked.cancelled()).toBe(true);
      expect(fetchedUrls()).toEqual(['https://a.example/']);
    });

    it('releases the body of a non-HTML answer', async () => {
      const tracked = trackedBody();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(tracked.body, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );

      const result = await parseOpenGraph('https://a.example/doc.pdf');

      expect(result).toEqual(minimalOpenGraph('https://a.example/doc.pdf'));
      expect(tracked.cancelled()).toBe(true);
    });
  });

  // v1.37.0: both size-limit exits threw without releasing the body; the
  // streaming one only called releaseLock(), which leaves the rest of the body
  // arriving.
  describe('size limit', () => {
    const MAX = 1024 * 1024;

    it('cancels the body when Content-Length is over the limit', async () => {
      const tracked = trackedBody();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(tracked.body, {
          headers: { ...HTML, 'content-length': String(2 * MAX) },
        }),
      );

      await expect(parseOpenGraph('https://example.com/large')).rejects.toThrow(
        `Response too large: ${2 * MAX} bytes (max: ${MAX})`,
      );
      expect(tracked.cancelled()).toBe(true);
    });

    it('cancels the stream when the body grows past the limit', async () => {
      const chunk = 100 * 1024;
      let reads = 0;
      let cancelled = false;
      // An endless body: only a cancel stops it.
      const body = new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          cancelled = true;
        },
      });
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { headers: HTML }));

      await expect(parseOpenGraph('https://example.com/streaming-large')).rejects.toThrow(
        ResponseTooLargeError,
      );
      expect(cancelled).toBe(true);
      // 11 chunks of 100 KiB cross 1 MiB; nothing much is read after that.
      expect(reads).toBeLessThanOrEqual(Math.ceil(MAX / chunk) + 2);
    });

    it('still reads a body that ends under the limit', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(`<title>${'a'.repeat(MAX - 100)}</title>`, { headers: HTML }),
      );

      const preview = await parseOpenGraph('https://example.com/big-but-fine');
      expect(preview.title).toHaveLength(MAX - 100);
    });
  });

  // v1.37.1: a body cancel that rejects (a stream that has already errored)
  // used to replace the error or result being returned with its own rejection.
  describe('a cancel that rejects', () => {
    const cancelError = new Error('stream already errored');

    /** A response stub whose body only supports a cancel that rejects. */
    function rejectingCancel(status: number, headers: Record<string, string>) {
      const cancel = vi.fn<() => Promise<void>>().mockRejectedValue(cancelError);
      const response = {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        body: { cancel },
      };
      return { response: response as unknown as Response, cancel };
    }

    it('still reports ResponseTooLargeError for an oversized Content-Length', async () => {
      const { response, cancel } = rejectingCancel(200, {
        ...HTML,
        'content-length': String(2 * 1024 * 1024),
      });
      vi.mocked(fetch).mockResolvedValueOnce(response);

      await expect(parseOpenGraph('https://example.com/huge')).rejects.toThrow(
        ResponseTooLargeError,
      );
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('still reports ResponseTooLargeError when the streamed body passes the limit', async () => {
      const reader = {
        read: vi
          .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
          .mockResolvedValue({ done: false, value: new Uint8Array(600 * 1024) }),
        cancel: vi.fn<() => Promise<void>>().mockRejectedValue(cancelError),
        releaseLock: vi.fn<() => void>(),
      };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(HTML),
        body: { getReader: () => reader },
      } as unknown as Response);

      await expect(parseOpenGraph('https://example.com/stream')).rejects.toThrow(
        ResponseTooLargeError,
      );
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
    });

    it('still returns the minimal result for a non-HTML answer', async () => {
      const { response, cancel } = rejectingCancel(200, { 'content-type': 'application/pdf' });
      vi.mocked(fetch).mockResolvedValueOnce(response);

      expect(await parseOpenGraph('https://example.com/doc.pdf')).toEqual(
        minimalOpenGraph('https://example.com/doc.pdf'),
      );
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('still reports the HTTP status of an error answer', async () => {
      const { response, cancel } = rejectingCancel(503, HTML);
      vi.mocked(fetch).mockResolvedValueOnce(response);

      await expect(parseOpenGraph('https://example.com/down')).rejects.toThrow('HTTP 503');
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('still follows a redirect', async () => {
      const { response, cancel } = rejectingCancel(302, {
        location: 'https://example.com/next',
      });
      vi.mocked(fetch)
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response('<title>Next</title>', { headers: HTML }));

      expect((await parseOpenGraph('https://example.com/start')).title).toBe('Next');
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchedUrls()).toEqual(['https://example.com/start', 'https://example.com/next']);
    });
  });

  describe('GET /api/metadata/og', () => {
    const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };

    async function og(url: string): Promise<Response> {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);
      return app.fetch(
        new Request(`http://example.com/api/metadata/og?url=${encodeURIComponent(url)}`, {
          headers: { 'X-Admin-Key': 'test-api-key-12345' },
        }),
        testEnv,
      );
    }

    it('answers 200 with the page metadata', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('<meta property="og:title" content="Hello">', { headers: HTML }),
      );
      const response = await og('https://example.com/page');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, data: { title: 'Hello' } });
    });

    it('answers 400 without a url and 403 for an SSRF target, fetching nothing', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);
      const missing = await app.fetch(
        new Request('http://example.com/api/metadata/og', {
          headers: { 'X-Admin-Key': 'test-api-key-12345' },
        }),
        testEnv,
      );
      expect(missing.status).toBe(400);
      expect((await og('http://169.254.169.254/latest')).status).toBe(403);
      expect(fetchedUrls()).toEqual([]);
    });

    it('answers 502 for a redirect loop instead of following it to the subrequest limit', async () => {
      vi.mocked(fetch).mockImplementation(async input => {
        const url = input instanceof Request ? input.url : input.toString();
        return new Response(null, { status: 302, headers: { location: `${url}x` } });
      });

      const response = await og('https://loop.example/');

      expect(response.status).toBe(502);
      const body = await response.json<{ success: boolean; details: string }>();
      expect(body.success).toBe(false);
      expect(body.details).toBe(`Too many redirects (max ${MAX_REDIRECTS})`);
      expect(fetchedUrls()).toHaveLength(MAX_REDIRECTS + 1);
    });
  });
});

describe('validateUrlForSSRF', () => {
  describe('valid public URLs', () => {
    it('accepts valid HTTPS URLs', () => {
      const url = validateUrlForSSRF('https://example.com');
      expect(url.hostname).toBe('example.com');
    });

    it('accepts valid HTTP URLs', () => {
      const url = validateUrlForSSRF('http://example.com');
      expect(url.hostname).toBe('example.com');
    });

    it('accepts URLs with paths and query strings', () => {
      const url = validateUrlForSSRF('https://example.com/page?query=value');
      expect(url.pathname).toBe('/page');
      expect(url.search).toBe('?query=value');
    });

    it('accepts public IP addresses', () => {
      const url = validateUrlForSSRF('https://93.184.216.34');
      expect(url.hostname).toBe('93.184.216.34');
    });
  });

  describe('blocked schemes', () => {
    it('rejects file: protocol', () => {
      expect(() => validateUrlForSSRF('file:///etc/passwd')).toThrow(SSRFBlockedError);
    });

    it('rejects javascript: protocol', () => {
      expect(() => validateUrlForSSRF('javascript:alert(1)')).toThrow(SSRFBlockedError);
    });

    it('rejects ftp: protocol', () => {
      expect(() => validateUrlForSSRF('ftp://ftp.example.com')).toThrow(SSRFBlockedError);
    });

    it('rejects data: protocol', () => {
      expect(() => validateUrlForSSRF('data:text/html,<h1>test</h1>')).toThrow(SSRFBlockedError);
    });
  });

  describe('blocked hostnames', () => {
    it('rejects localhost', () => {
      expect(() => validateUrlForSSRF('http://localhost')).toThrow(SSRFBlockedError);
    });

    it('rejects localhost.localdomain', () => {
      expect(() => validateUrlForSSRF('http://localhost.localdomain')).toThrow(SSRFBlockedError);
    });

    it('rejects 0.0.0.0', () => {
      expect(() => validateUrlForSSRF('http://0.0.0.0')).toThrow(SSRFBlockedError);
    });

    it('rejects kubernetes service names', () => {
      expect(() => validateUrlForSSRF('http://kubernetes')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://kubernetes.default')).toThrow(SSRFBlockedError);
    });

    it('rejects metadata hostnames', () => {
      expect(() => validateUrlForSSRF('http://metadata')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://metadata.google.internal')).toThrow(SSRFBlockedError);
    });
  });

  describe('IPv4 private ranges', () => {
    it('blocks loopback (127.x.x.x)', () => {
      expect(() => validateUrlForSSRF('http://127.0.0.1')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://127.255.255.255')).toThrow(SSRFBlockedError);
    });

    it('blocks 10.x.x.x range', () => {
      expect(() => validateUrlForSSRF('http://10.0.0.1')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://10.255.255.255')).toThrow(SSRFBlockedError);
    });

    it('blocks 172.16-31.x.x range', () => {
      expect(() => validateUrlForSSRF('http://172.16.0.1')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://172.31.255.255')).toThrow(SSRFBlockedError);
    });

    it('allows IPs just outside 172.16-31.x.x range', () => {
      // 172.15.x.x and 172.32.x.x are public
      expect(() => validateUrlForSSRF('http://172.15.0.1')).not.toThrow();
      expect(() => validateUrlForSSRF('http://172.32.0.1')).not.toThrow();
    });

    it('blocks 192.168.x.x range', () => {
      expect(() => validateUrlForSSRF('http://192.168.0.1')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://192.168.255.255')).toThrow(SSRFBlockedError);
    });

    it('blocks link-local (169.254.x.x)', () => {
      expect(() => validateUrlForSSRF('http://169.254.0.1')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://169.254.255.255')).toThrow(SSRFBlockedError);
    });

    it('blocks 0.x.x.x range', () => {
      expect(() => validateUrlForSSRF('http://0.0.0.0')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://0.1.2.3')).toThrow(SSRFBlockedError);
    });
  });

  describe('cloud metadata endpoints', () => {
    it('blocks AWS/GCP/Azure metadata (169.254.169.254)', () => {
      expect(() => validateUrlForSSRF('http://169.254.169.254/latest/meta-data')).toThrow(
        SSRFBlockedError,
      );
    });

    it('blocks AWS ECS metadata (169.254.170.2)', () => {
      expect(() => validateUrlForSSRF('http://169.254.170.2')).toThrow(SSRFBlockedError);
    });

    it('blocks Alibaba Cloud metadata (100.100.100.200)', () => {
      expect(() => validateUrlForSSRF('http://100.100.100.200')).toThrow(SSRFBlockedError);
    });
  });

  describe('IPv6 addresses', () => {
    it('blocks IPv6 loopback (::1)', () => {
      expect(() => validateUrlForSSRF('http://[::1]')).toThrow(SSRFBlockedError);
    });

    it('blocks IPv6 private (fc00::/7)', () => {
      expect(() => validateUrlForSSRF('http://[fc00::1]')).toThrow(SSRFBlockedError);
      expect(() => validateUrlForSSRF('http://[fd00::1]')).toThrow(SSRFBlockedError);
    });

    it('blocks IPv6 link-local (fe80::/10)', () => {
      expect(() => validateUrlForSSRF('http://[fe80::1]')).toThrow(SSRFBlockedError);
    });
  });

  describe('invalid URLs', () => {
    it('rejects invalid URL format', () => {
      expect(() => validateUrlForSSRF('not-a-url')).toThrow(SSRFBlockedError);
    });

    it('rejects empty string', () => {
      expect(() => validateUrlForSSRF('')).toThrow(SSRFBlockedError);
    });

    it('rejects URLs without scheme', () => {
      expect(() => validateUrlForSSRF('example.com')).toThrow(SSRFBlockedError);
    });
  });
});
