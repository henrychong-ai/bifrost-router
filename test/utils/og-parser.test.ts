import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import {
  describeOpenGraphFailure,
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

/** The preview of a page whose HTML is `html`. */
async function previewOfHtml(html: string) {
  vi.mocked(fetch).mockResolvedValue(new Response(html, { headers: HTML }));
  return parseOpenGraph('https://example.com/page');
}

/** `html`'s preview, and how long parsing it took. */
async function timed(html: string) {
  const started = performance.now();
  const preview = await previewOfHtml(html);
  return { preview, elapsed: performance.now() - started };
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

    // v1.37.2: the shared host policy applies to both, as to every hop
    it.each([
      'http://127.0.0.1/card.png',
      'http://169.254.169.254/latest',
      'http://[::1]/card.png',
      'http://localhost/card.png',
      'http://printer.local/card.png',
      'http://2130706433/card.png',
      'http://[fd12:3456::1]/card.png',
    ])('drops %s, a host the outbound policy refuses', async blocked => {
      const preview = await previewOf(blocked, blocked);
      expect(preview.image).toBeNull();
      expect(preview.url).toBe('https://example.com/a/page');
    });

    it('drops a value that is not a URL', async () => {
      const preview = await previewOf('https://[bad', 'http://exa mple.com:99999/');
      expect(preview.image).toBeNull();
      expect(preview.url).toBe('https://example.com/a/page');
    });

    // v1.37.2: the operator's browser loads these, so names it may resolve
    // privately are dropped too
    it.each([
      'http://intranet/card.png',
      'http://intranet./card.png',
      'https://nas.lan/card.png',
      'https://router.home.arpa/card.png',
      'https://home.arpa/card.png',
      'https://build.corp/card.png',
      'https://box.your-tailnet.ts.net/card.png',
      'https://nas.home/card.png',
      'https://nas.home./card.png',
      'https://wiki.intranet/card.png',
      'https://wiki.intranet./card.png',
      'https://srv.private/card.png',
      'https://srv.private./card.png',
      'https://box.localdomain/card.png',
      'https://box.localdomain./card.png',
      'https://router.home.arpa./card.png',
    ])('drops %s, a name the browser may resolve privately', async blocked => {
      const preview = await previewOf(blocked, blocked);
      expect(preview.image).toBeNull();
      expect(preview.url).toBe('https://example.com/a/page');
    });

    it('keeps names that merely contain a private suffix', async () => {
      const preview = await previewOf(
        'https://lan.example.net/c.png',
        'https://corp.example.org/p',
      );
      expect(preview.image).toBe('https://lan.example.net/c.png');
      expect(preview.url).toBe('https://corp.example.org/p');
    });

    it('keeps public IPv4 and IPv6 hosts', async () => {
      const preview = await previewOf('http://8.8.8.8/c.png', 'https://[2606:4700:4700::1111]/p');
      expect(preview.image).toBe('http://8.8.8.8/c.png');
      expect(preview.url).toBe('https://[2606:4700:4700::1111]/p');
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

    // v1.40.0: one deadline for the whole preview. Each hop had its own 5 s,
    // so five slow redirects could hold a preview for about 30 s.
    it('gives every hop one shared 5 s deadline', async () => {
      vi.useFakeTimers();
      try {
        const signals: AbortSignal[] = [];
        // Each hop answers after 2 s with a redirect, until aborted
        vi.mocked(fetch).mockImplementation(
          (_input, init) =>
            new Promise<Response>((resolve, reject) => {
              const signal = init?.signal ?? undefined;
              if (signal) signals.push(signal);
              const timer = setTimeout(
                () =>
                  resolve(
                    new Response(null, {
                      status: 302,
                      headers: { location: `/hop-${signals.length}` },
                    }),
                  ),
                2000,
              );
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason);
              });
            }),
        );
        const outcome = parseOpenGraph('https://example.com/start').then(
          () => 'resolved',
          (error: unknown) => (error as Error).name,
        );
        await vi.advanceTimersByTimeAsync(5000);
        expect(await outcome).toBe('AbortError');
        // Three hops started (at 0, 2 and 4 s), all under the one signal
        expect(signals).toHaveLength(3);
        expect(new Set(signals).size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
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
      // The preview's answer names the cap that was applied, not the default
      const failure: unknown = await parseOpenGraph('https://loop.example/', {
        maxRedirects: 2,
      }).catch((error: unknown) => error);
      expect(describeOpenGraphFailure(failure)).toEqual({
        status: 502,
        error: 'Failed to fetch URL',
        details: 'Too many redirects (max 2)',
      });
      expect(describeOpenGraphFailure(new TooManyRedirectsError(MAX_REDIRECTS)).details).toBe(
        `Too many redirects (max ${MAX_REDIRECTS})`,
      );
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

    // v1.37.2: every hop goes through the shared host policy
    it.each([
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://100.64.0.1/',
      'http://db.internal/',
      'http://[64:ff9b::a9fe:a9fe]/',
    ])('refuses a redirect hop to %s before fetching it', async location => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location } }),
      );
      await expect(parseOpenGraph('https://a.example/')).rejects.toThrow(SSRFBlockedError);
      expect(fetchedUrls()).toEqual(['https://a.example/']);
    });

    it('reports an unparseable Location as an error, fetching nothing more', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://[bad' } }),
      );
      await expect(parseOpenGraph('https://a.example/')).rejects.toThrow(TypeError);
      expect(fetchedUrls()).toEqual(['https://a.example/']);
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

  // v1.37.2: meta tags and the title are read in one linear pass. The old
  // regular expressions backtracked: about 52 KB of unclosed meta tags took
  // tens of seconds.
  describe('meta and title parsing', () => {
    it.each([
      ['unclosed meta tags', "<meta property='og:title' content='"],
      ['unclosed meta tags, double quotes', '<meta property="og:title" content="'],
      ['meta tags without a closing quote', '<meta property=og:title content='],
      ['open title tags', '<title'],
      ['title tags with no text', '<title>'],
      ['meta openers alone', '<meta '],
    ])('parses 1 MB of %s in well under a second', async (_label, unit) => {
      const html = unit.repeat(Math.floor(1_000_000 / unit.length));
      for (const page of [html, `${html}>`, `${html}<title>Kept</title>`]) {
        const { elapsed } = await timed(page);
        expect(elapsed).toBeLessThan(1000);
      }
      // Still finds a real tag after the adversarial run (an open <title>
      // element is RCDATA, so it is closed first)
      const closer = unit === '<title>' ? '</title>' : '';
      const { preview, elapsed } = await timed(
        `${html.slice(0, 500_000)}>${closer}<meta property="og:description" content="Found">`,
      );
      expect(elapsed).toBeLessThan(1000);
      expect(preview.description).toBe('Found');
    });

    it('reads content before or after property, in either quote style', async () => {
      const preview = await previewOfHtml(
        `<meta content='Desc' property='og:description'><meta content="T" property="og:title">`,
      );
      expect(preview).toMatchObject({ title: 'T', description: 'Desc' });
    });

    it('prefers property over name, whatever the order, and the first tag of each', async () => {
      const preview = await previewOfHtml(
        '<meta name="og:title" content="By name"><meta property="og:title" content="First">' +
          '<meta property="og:title" content="Second">',
      );
      expect(preview.title).toBe('First');
      expect((await previewOfHtml('<meta name="description" content="Named">')).description).toBe(
        'Named',
      );
    });

    it('matches tag, attribute names and keys case-insensitively', async () => {
      const preview = await previewOfHtml(
        '<META PROPERTY="OG:Title" CONTENT="Upper"><Meta Name="Application-Name" Content="App">',
      );
      expect(preview).toMatchObject({ title: 'Upper', siteName: 'App' });
    });

    it('reads unquoted values, spaces around =, self-closing tags and > inside quotes', async () => {
      const preview = await previewOfHtml(
        '<meta property = og:title content = Bare/><meta\nproperty="og:description"\n' +
          'content="a > b" />',
      );
      expect(preview).toMatchObject({ title: 'Bare/', description: 'a > b' });
    });

    it('keeps an apostrophe inside a double-quoted value', async () => {
      const preview = await previewOfHtml(`<meta property="og:title" content="It's here">`);
      expect(preview.title).toBe("It's here");
    });

    it('skips an empty content and uses the next tag', async () => {
      const preview = await previewOfHtml(
        '<meta property="og:title" content=""><meta property="og:title" content="Next">',
      );
      expect(preview.title).toBe('Next');
    });

    it('takes the first of a repeated attribute, as HTML does', async () => {
      const preview = await previewOfHtml('<meta property="og:title" content="One" content="Two">');
      expect(preview.title).toBe('One');
    });

    it('skips a tag longer than 16 KiB and reads the next one', async () => {
      const long = `<meta property="og:title" data-x="${'x'.repeat(16 * 1024)}" content="Long">`;
      expect((await previewOfHtml(long)).title).toBeNull();
      const preview = await previewOfHtml(`${long}<meta property="og:title" content="Short">`);
      expect(preview.title).toBe('Short');
      // Just under the cap is still read
      const fits = `<meta property="og:title" content="Fits" data-x="${'x'.repeat(16 * 1024 - 60)}">`;
      expect(fits.length).toBeLessThanOrEqual(16 * 1024);
      expect((await previewOfHtml(fits)).title).toBe('Fits');
    });

    it('reads a 3,000-character og:description', async () => {
      const description = 'd'.repeat(3000);
      const preview = await previewOfHtml(
        `<meta property="og:description" content="${description}">`,
      );
      expect(preview.description).toBe(description);
    });

    it('does not read <metadata> or other tags as meta', async () => {
      const preview = await previewOfHtml(
        '<metadata property="og:title" content="No"><link property="og:title" content="No">',
      );
      expect(preview.title).toBeNull();
    });

    // An oversized tag is skipped to its REAL end, quote-aware. A scan
    // restarted at the size limit landed inside the quoted value and read the
    // markup written there as tags.
    it('reads nothing from inside an oversized quoted value', async () => {
      const page =
        `<meta content="${'a'.repeat(17 * 1024)} ` +
        '<meta property=og:title content=Injected> ' +
        '<meta property=og:image content=https://evil.example.net/x.png> ' +
        '<title>Injected title</title>">' +
        '<title>Real</title><meta property="og:description" content="After">';
      const preview = await previewOfHtml(page);
      expect(preview.title).toBe('Real');
      expect(preview.image).toBeNull();
      expect(preview.description).toBe('After');
    });

    // A quote opens a value only directly after `=`. In an attribute name or
    // an unquoted value it is an ordinary character, so an oversized tag that
    // overflows there is skipped to the next `>`, never to a later quote.
    it.each([
      [
        'an unquoted value',
        `<meta a=${'X'.repeat(17 * 1024)}"> <meta name=x content="  > ` +
          '<meta property=og:image content=https://evil.example.net/u.png> ' +
          '<meta property=og:title content=Injected>  ">',
      ],
      [
        'an unquoted value ending in a quote character',
        `<meta name=x data=${'A'.repeat(17 * 1024)}'q content=zz> <meta name=d content='> ` +
          '<meta property=og:title content=Injected> ' +
          "<meta property=og:image content=https://evil.example.net/u.png> '>",
      ],
    ])(
      'reads nothing injected after an oversized tag that overflows inside %s',
      async (_label, page) => {
        const preview = await previewOfHtml(`${page}<title>Real</title>`);
        expect(preview.title).toBe('Real');
        expect(preview.image).toBeNull();
      },
    );

    it('ends a tag name only at ASCII whitespace, / or >', async () => {
      for (const separator of ['\u00a0', '\u2028', '\u3000']) {
        const preview = await previewOfHtml(
          `<meta${separator}property="og:title" content="Spoof"><title${separator}x>Spoof title</title>`,
        );
        expect(preview.title).toBeNull();
      }
      expect((await previewOfHtml('<meta\fproperty="og:title" content="Real">')).title).toBe(
        'Real',
      );
    });

    it('treats an unclosed quote as running to the end of the page, as HTML does', async () => {
      const preview = await previewOfHtml(
        `<meta property="og:title" content="never closed ${'y'.repeat(3000)}` +
          ' <meta property=og:description content=Inside>',
      );
      expect(preview).toMatchObject({ title: null, description: null });
    });

    it('skips an oversized title tag whole, quote-aware', async () => {
      const preview = await previewOfHtml(
        `<title data-x="${'t'.repeat(17 * 1024)} >Injected</title> ">Hidden</title>` +
          '<title>Real</title>',
      );
      expect(preview.title).toBe('Real');
    });

    // Every tag is read with the attribute tokenizer, so markup written
    // inside another tag's attribute value, a comment or raw text is not read
    it('keeps the real metadata when another tag quotes markup in an attribute', async () => {
      const preview = await previewOfHtml(
        '<link rel="x" title="Example <title> tag">' +
          '<meta name="description" content="Real description">' +
          '<meta property="og:image" content="https://example.com/image.png">' +
          '<title>Real title</title>',
      );
      expect(preview).toMatchObject({
        title: 'Real title',
        description: 'Real description',
        image: 'https://example.com/image.png',
      });
    });

    it.each([
      ['a comment', '<!-- ', ' -->'],
      ['an unclosed comment', '<!-- ', ''],
      ['a script string', '<script>var s = "', '";</script>'],
      ['a style block', '<style>/* ', ' */</style>'],
      ['an xmp element', '<xmp>', '</xmp>'],
      ['an iframe', '<iframe>', '</iframe>'],
      ['a noembed element', '<noembed>', '</noembed>'],
      ['a noframes element', '<noframes>', '</noframes>'],
      ['a noscript element', '<noscript>', '</noscript>'],
      ['a textarea', '<textarea>', '</textarea>'],
      ['a title', '<title>T', '</title>'],
      ['a CDATA-like declaration', '<![CDATA[ ', ' ]]>'],
      ['a processing instruction', '<?php ', ' ?>'],
    ])('does not read a meta tag inside %s', async (_label, before, after) => {
      const preview = await previewOfHtml(
        `${before}<meta property="og:description" content="Forged">${after}`,
      );
      expect(preview.description).toBeNull();
    });

    it('still reads a meta tag after each of those, once closed', async () => {
      for (const [before, after] of [
        ['<!-- x ', ' -->'],
        ['<script>if (a < b) {}', '</SCRIPT >'],
        ['<style>p{}', '</style>'],
        ['<textarea>x', '</textarea>'],
        ['<noscript>x', '</noscript>'],
      ]) {
        const preview = await previewOfHtml(
          `${before}${after}<meta property="og:description" content="Real">`,
        );
        expect(preview.description).toBe('Real');
      }
    });

    // A DOCTYPE ends at its first `>`, as HTML ends it: in every DOCTYPE
    // tokenizer state, a quoted public or system identifier included (an
    // abrupt end), so markup written inside a quoted identifier is read from
    // that `>` on, exactly as parse5 reads it (v1.38.0; checked against parse5)
    it.each([
      ['a quoted public id holding >', '<!DOCTYPE html PUBLIC "a>b">', 'Real', null],
      [
        'a public id holding a forged tag',
        '<!DOCTYPE html PUBLIC "<meta property=og:title content=Forged>">',
        'Real',
        null,
      ],
      [
        'a single-quoted system id holding a title',
        "<!doctype html SYSTEM '<title>Forged</title>'>",
        'Real',
        null,
      ],
      ['a system id after a public id', '<!DOCTYPE html PUBLIC "x" "y>z">', 'Real', null],
      ['mixed case and no space before the name', '<!DoCtYpEhtml>', 'Real', null],
      ['an empty DOCTYPE', '<!DOCTYPE>', 'Real', null],
      ['an unquoted identifier', '<!DOCTYPE html PUBLIC x>y>', 'Real', null],
      ['whitespace variants', '<!DOCTYPE\t\nhtml\fPUBLIC\n"a"\t"b">', 'Real', null],
    ])('reads the tag after a DOCTYPE with %s', async (_label, doctype, title, description) => {
      const preview = await previewOfHtml(`${doctype}<meta property=og:title content=Real>`);
      expect(preview.title).toBe(title);
      expect(preview.description).toBe(description);
    });

    it('reads a forged tag after the > that ends the DOCTYPE, as HTML does', async () => {
      // The tag after the first `>` is markup to HTML too (parse5 agrees)
      const preview = await previewOfHtml(
        '<!DOCTYPE html PUBLIC "a><meta property=og:title content=AsHtml>">',
      );
      expect(preview.title).toBe('AsHtml');
    });

    it.each([
      ['an empty comment', '<!-->'],
      ['an empty comment with a dash', '<!--->'],
      ['a comment closed by --!>', '<!-- c --!>'],
      ['a comment closed by -->', '<!-- c -->'],
    ])('reads the tag after %s', async (_label, comment) => {
      const preview = await previewOfHtml(`${comment}<meta property=og:title content=Real>`);
      expect(preview.title).toBe('Real');
    });

    it.each([
      [
        '<!--> closes the escape at once',
        '<script><!--><script></script><meta property=og:title content=Real>',
      ],
      [
        '<!---> closes the escape at once',
        '<script><!---><script></script><meta property=og:title content=Real>',
      ],
      [
        '--> after dashes',
        '<script><!-- a --- --><script></script><meta property=og:title content=Real>',
      ],
      [
        'a double-escaped </script> returns to escaped',
        '<script><!--<script>x</script></script><meta property=og:title content=Real>',
      ],
      [
        '--> in the double-escaped state returns to script data',
        '<script><!--<script>--></script><meta property=og:title content=Real>',
      ],
      [
        'an end tag needs a delimiter',
        '<script></scriptx></script><meta property=og:title content=Real>',
      ],
    ])('script data states: %s', async (_label, page) => {
      expect((await previewOfHtml(page)).title).toBe('Real');
    });

    it('treats an end tag at the very end of the input as text, as HTML does', async () => {
      // `</title` with nothing after it is not an end tag: the title is never
      // closed, so there is no title
      expect((await previewOfHtml('<title>Real</title')).title).toBeNull();
      expect((await previewOfHtml('<title>Real</title>')).title).toBe('Real');
    });

    it("follows the script element's escaped states", async () => {
      const forged =
        '<script><!--<script></script><meta property=og:title content=Forged>--></script>' +
        '<meta property=og:title content=Real>';
      expect((await previewOfHtml(forged)).title).toBe('Real');
      // `</script` in the escaped state ends the element
      expect(
        (await previewOfHtml('<script><!-- x </script><meta property=og:title content=After>'))
          .title,
      ).toBe('After');
      // `<!-->` closes at once
      expect(
        (
          await previewOfHtml(
            '<script><!--><script></script><meta property=og:title content=After>',
          )
        ).title,
      ).toBe('After');
    });

    it('does not read a meta tag written in an end tag', async () => {
      const preview = await previewOfHtml(
        '</div title="<meta property=og:description content=Forged>"><p>x</p>',
      );
      expect(preview.description).toBeNull();
    });

    it('reads the first title with text', async () => {
      expect((await previewOfHtml('<title></title><title lang="en">  Real  </title>')).title).toBe(
        'Real',
      );
      expect((await previewOfHtml('<TITLE>Upper</TITLE>')).title).toBe('Upper');
      // Title text is RCDATA: markup inside it is text, as browsers show it
      expect((await previewOfHtml('<title>Open <b>bold</b></title>')).title).toBe(
        'Open <b>bold</b>',
      );
      expect((await previewOfHtml('<title>No close')).title).toBeNull();
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
      // A host this Worker does not serve: own-domain links resolve in process
      // (test/utils/og-own-host.test.ts)
      const response = await og('https://page.example.org/page');
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

    // v1.38.0: each failure class answers a fixed message, never an error's own text
    it.each([
      [
        'an unparseable URL',
        'not a url',
        403,
        'URL blocked for security reasons',
        'Invalid URL format',
      ],
      [
        'a blocked scheme',
        'ftp://files.example.org/x',
        403,
        'URL blocked for security reasons',
        'Blocked scheme',
      ],
      [
        'a blocked name',
        'http://printer.local/x',
        403,
        'URL blocked for security reasons',
        'Blocked hostname',
      ],
      [
        'a private IPv4 address',
        'http://10.1.2.3/',
        403,
        'URL blocked for security reasons',
        'Blocked private IP address',
      ],
      [
        'a refused IPv6 address',
        'http://[fd00::1]/',
        403,
        'URL blocked for security reasons',
        'Blocked IPv6 address',
      ],
    ])('answers %s with fixed text naming no host', async (_label, url, status, error, details) => {
      const response = await og(url);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ success: false, error, details });
    });

    it('answers a network failure with fixed text, never the error message', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(
        new Error('connect ECONNREFUSED secret-internal-name'),
      );
      const response = await og('https://page.example.org/x');
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Failed to fetch URL',
        details: 'The page could not be fetched',
      });
    });

    it('answers a timeout and an upstream status with fixed text', async () => {
      const abort = new Error('The operation was aborted: secret');
      abort.name = 'AbortError';
      vi.mocked(fetch).mockRejectedValueOnce(abort);
      const timedOut = await og('https://page.example.org/slow');
      expect(timedOut.status).toBe(502);
      expect(await timedOut.json()).toEqual({
        success: false,
        error: 'Failed to fetch URL',
        details: 'The page did not answer in time',
      });
      vi.mocked(fetch).mockResolvedValueOnce(new Response('secret body', { status: 503 }));
      const failed = await og('https://page.example.org/down');
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({
        success: false,
        error: 'Failed to fetch URL',
        details: 'HTTP 503',
      });
    });

    it('answers an oversized page with fixed text', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('<p>secret</p>', {
          headers: { ...HTML, 'content-length': String(2 * 1024 * 1024) },
        }),
      );
      const response = await og('https://page.example.org/huge');
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Response too large',
        details: 'The page is over the 1 MB limit',
      });
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
