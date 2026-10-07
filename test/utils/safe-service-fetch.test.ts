import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeServiceFetch } from '../../src/utils/safe-service-fetch';

/**
 * Build a mock Fetcher whose `fetch()` is provided by the test.
 * Cast to `Fetcher` because Fetcher has a few non-public properties we don't need.
 */
function mockFetcher(handler: (req: Request) => Promise<Response>): Fetcher {
  return { fetch: handler } as unknown as Fetcher;
}

describe('safeServiceFetch', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // vitest-pool-workers 0.13+ isolates per test FILE, not per test, so a
    // spy left installed stacks on the next beforeEach and accumulates
    // its call history — restore after each test.
    consoleLogSpy.mockRestore();
  });

  describe('success path', () => {
    it('returns the response from the underlying service', async () => {
      const fetcher = mockFetcher(async () => new Response('hello', { status: 200 }));
      const req = new Request('https://example.com/about');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(200);
      expect(await res?.text()).toBe('hello');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('passes through 5xx responses unchanged (inner-worker errors are not converted)', async () => {
      const fetcher = mockFetcher(async () => new Response('boom', { status: 500 }));
      const req = new Request('https://example.com/path');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(500);
      expect(await res?.text()).toBe('boom');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('passes through 404 from the inner service unchanged', async () => {
      const fetcher = mockFetcher(async () => new Response('not found', { status: 404 }));
      const req = new Request('https://example.com/missing');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res?.status).toBe(404);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('failure path', () => {
    it('returns null when the service fetcher throws an Error', async () => {
      const fetcher = mockFetcher(async () => {
        throw new Error('binding unavailable');
      });
      const req = new Request('https://example.com/x');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res).toBeNull();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logged).toEqual({
        level: 'warn',
        message: 'Service binding fetch failed',
        hostname: 'example.com',
        errorName: 'Error',
      });
    });

    it('returns null when the service fetcher throws a TypeError (e.g. malformed URL)', async () => {
      const fetcher = mockFetcher(async () => {
        throw new TypeError('Invalid URL');
      });
      const req = new Request('https://example.com/path');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res).toBeNull();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      // The error's class only (v1.39.0): workerd's message can quote the URL
      expect(logged.errorName).toBe('TypeError');
      expect(JSON.stringify(logged)).not.toContain('Invalid URL');
    });

    it('returns null and logs string-form when a non-Error is thrown', async () => {
      const fetcher = mockFetcher(async () => {
        throw 'just a string'; // eslint-disable-line @typescript-eslint/only-throw-error
      });
      const req = new Request('https://example.com/path');

      const res = await safeServiceFetch(fetcher, req, {
        hostname: 'example.com',
      });

      expect(res).toBeNull();
      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logged.errorName).toBe('string');
      expect(JSON.stringify(logged)).not.toContain('just a string');
    });

    it('logs the hostname supplied in context, never the request path or URL', async () => {
      const fetcher = mockFetcher(async () => {
        throw new Error('failed');
      });
      const req = new Request('https://anything.example.com/magic/SECRET-TOKEN?q=QUERY-SECRET');

      await safeServiceFetch(fetcher, req, {
        hostname: 'anything.example.com',
      });

      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logged.hostname).toBe('anything.example.com');
      expect(logged).not.toHaveProperty('path');
      expect(JSON.stringify(logged)).not.toContain('SECRET');
    });
  });

  describe('request cloning', () => {
    it('forwards a fresh Request object to the service (not the original)', async () => {
      let received: Request | undefined;
      const fetcher = mockFetcher(async req => {
        received = req;
        return new Response('ok');
      });
      const original = new Request('https://example.com/x', { method: 'POST' });

      await safeServiceFetch(fetcher, original, {
        hostname: 'example.com',
      });

      expect(received).toBeDefined();
      // Method preserved through the clone
      expect(received?.method).toBe('POST');
      expect(received?.url).toBe('https://example.com/x');
      // Confirm it is a different Request instance (clone, not the same reference)
      expect(received).not.toBe(original);
    });
  });
});
