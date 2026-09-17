import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeRouterClient, EdgeRouterError, createClientFromEnv } from './client.js';

describe('EdgeRouterClient', () => {
  const mockFetch = vi.fn();
  let client: EdgeRouterClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new EdgeRouterClient({
      baseUrl: 'https://test.example.com',
      apiKey: 'test-api-key',
      fetch: mockFetch,
    });
  });

  describe('constructor', () => {
    it('removes trailing slash from baseUrl', () => {
      const clientWithSlash = new EdgeRouterClient({
        baseUrl: 'https://test.example.com/',
        apiKey: 'test-api-key',
        fetch: mockFetch,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      clientWithSlash.listRoutes('links.example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://test.example.com/api/routes'),
        expect.any(Object),
      );
    });
  });

  describe('listRoutes', () => {
    it('calls GET /api/routes with domain param', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      await client.listRoutes('links.example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/routes?domain=links.example.com',
        expect.objectContaining({
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Key': 'test-api-key',
          },
        }),
      );
    });

    it('sends exactly the domain it is given', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      await client.listRoutes('example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/routes?domain=example.com',
        expect.any(Object),
      );
    });

    it('returns routes array', async () => {
      const mockRoutes = [{ path: '/test', type: 'redirect', target: 'https://example.com' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        // API returns { routes: [...], total: N }
        json: async () => ({
          success: true,
          data: { routes: mockRoutes, total: 1 },
        }),
      });

      const routes = await client.listRoutes('links.example.com');

      expect(routes).toEqual(mockRoutes);
    });
  });

  describe('getRoute', () => {
    it('calls GET /api/routes with path query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            path: '/test/path',
            type: 'redirect',
            target: 'https://example.com',
          },
        }),
      });

      await client.getRoute('/test/path', 'links.example.com');

      // Path is passed as query parameter, URLSearchParams handles encoding
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.any(Object),
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest%2Fpath');
    });
  });

  describe('createRoute', () => {
    it('calls POST /api/routes with body', async () => {
      const input = {
        path: '/new',
        type: 'redirect' as const,
        target: 'https://new.com',
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: input }),
      });

      await client.createRoute(input, 'links.example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
    });
  });

  describe('updateRoute', () => {
    it('calls PUT /api/routes with path query parameter', async () => {
      const input = { target: 'https://updated.com' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            path: '/test',
            type: 'redirect',
            target: 'https://updated.com',
          },
        }),
      });

      await client.updateRoute('/test', input, 'links.example.com');

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('deleteRoute', () => {
    it('calls DELETE /api/routes with path query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await client.deleteRoute('/test', 'links.example.com');

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({ method: 'DELETE' }),
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('toggleRoute', () => {
    it('calls updateRoute with enabled field via query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            path: '/test',
            type: 'redirect',
            target: 'https://example.com',
            enabled: false,
          },
        }),
      });

      await client.toggleRoute('/test', false, 'links.example.com');

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabled: false }),
        }),
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('getAnalyticsSummary', () => {
    it('calls GET /api/analytics/summary', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            period: '30d',
            domain: 'all',
            clicks: { total: 0, uniqueSlugs: 0 },
          },
        }),
      });

      await client.getAnalyticsSummary({ domain: 'links.example.com', days: 7 });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/analytics/summary?domain=links.example.com&days=7',
        expect.any(Object),
      );
    });
  });

  describe('getClicks', () => {
    it('calls GET /api/analytics/clicks with filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [],
          meta: { total: 0, limit: 50, offset: 0, hasMore: false },
        }),
      });

      await client.getClicks({ limit: 10, offset: 5, slug: '/linkedin' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
      expect(url).toContain('slug=%2Flinkedin');
    });
  });

  describe('getSlugStats', () => {
    it('calls GET /api/analytics/clicks/:slug', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { slug: '/linkedin', totalClicks: 100 },
        }),
      });

      await client.getSlugStats('/linkedin', { domain: 'links.example.com' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/analytics/clicks/linkedin'),
        expect.any(Object),
      );
    });
  });

  // v1.35.0 — every domain-bearing method sends exactly the domain it is given
  // and nothing else: there is no client-level default to fall back to.
  describe('domain pass-through on migrate, views and QR methods', () => {
    const okJson = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
    const okText = (text: string) => ({ ok: true, text: async () => text });
    const calledUrl = () => String(mockFetch.mock.calls[0][0]);
    const calledMethod = () => (mockFetch.mock.calls[0][1] as { method: string }).method;

    it('migrateRoute posts oldPath, newPath and the given domain as query params', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ path: '/new', domain: 'links.example.com' }));
      await client.migrateRoute('/old', '/new', 'links.example.com');
      expect(calledMethod()).toBe('POST');
      expect(calledUrl()).toContain('/api/routes/migrate?');
      expect(calledUrl()).toContain('oldPath=%2Fold');
      expect(calledUrl()).toContain('newPath=%2Fnew');
      expect(calledUrl()).toContain('domain=links.example.com');
    });

    it('getViews scopes to the given domain and sends no domain param when omitted', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({ items: [], meta: { total: 0, limit: 50, offset: 0, hasMore: false } }),
      );
      await client.getViews({ domain: 'example.com', days: 7 });
      expect(calledUrl()).toContain('/api/analytics/views?');
      expect(calledUrl()).toContain('domain=example.com');
      expect(calledUrl()).toContain('days=7');

      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(
        okJson({ items: [], meta: { total: 0, limit: 50, offset: 0, hasMore: false } }),
      );
      await client.getViews({ days: 7 });
      expect(calledUrl()).not.toContain('domain=');
    });

    it('listQrs sends the given domain and the optional filters', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ items: [], meta: { total: 0 } }));
      await client.listQrs({ domain: 'links.example.com', type: 'url', limit: 5 });
      expect(calledMethod()).toBe('GET');
      expect(calledUrl()).toContain('/api/qr?');
      expect(calledUrl()).toContain('domain=links.example.com');
      expect(calledUrl()).toContain('type=url');
      expect(calledUrl()).toContain('limit=5');
    });

    it('getQr reads by id inside the given domain namespace', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'qr_1' }));
      await client.getQr('qr_1', 'links.example.com');
      expect(calledMethod()).toBe('GET');
      expect(calledUrl()).toContain('/api/qr/qr_1?domain=links.example.com');
    });

    it('createQr posts the body into the given domain namespace', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'qr_2' }));
      await client.createQr(
        { type: 'url', payload: { url: 'https://target.example.com' } },
        'links.example.com',
      );
      expect(calledMethod()).toBe('POST');
      expect(calledUrl()).toContain('/api/qr?domain=links.example.com');
      const init = mockFetch.mock.calls[0][1] as { body: string };
      expect(JSON.parse(init.body)).toEqual({
        type: 'url',
        payload: { url: 'https://target.example.com' },
      });
    });

    it('updateQr puts the body to the id inside the given domain namespace', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'qr_3' }));
      await client.updateQr('qr_3', { description: 'renamed' }, 'secondary.example.net');
      expect(calledMethod()).toBe('PUT');
      expect(calledUrl()).toContain('/api/qr/qr_3?domain=secondary.example.net');
    });

    it('deleteQr deletes the id inside the given domain namespace', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ deleted: true, id: 'qr_4' }));
      await client.deleteQr('qr_4', 'secondary.example.net');
      expect(calledMethod()).toBe('DELETE');
      expect(calledUrl()).toContain('/api/qr/qr_4?domain=secondary.example.net');
    });

    it('getQrImageSvg fetches the image for the id inside the given domain namespace', async () => {
      mockFetch.mockResolvedValueOnce(okText('<svg/>'));
      const svg = await client.getQrImageSvg('qr_5', 'links.example.com');
      expect(svg).toBe('<svg/>');
      expect(calledUrl()).toContain('/api/qr/qr_5/image?domain=links.example.com');
    });

    it('getRouteQrSvg searches the given domain route table for the path', async () => {
      mockFetch.mockResolvedValueOnce(okText('<svg/>'));
      const svg = await client.getRouteQrSvg('/linkedin', {
        domain: 'links.example.com',
        size: 256,
      });
      expect(svg).toBe('<svg/>');
      expect(calledUrl()).toContain('/api/qr/from-route?');
      expect(calledUrl()).toContain('domain=links.example.com');
      expect(calledUrl()).toContain('path=%2Flinkedin');
      expect(calledUrl()).toContain('size=256');
    });
  });

  describe('error handling', () => {
    it('throws EdgeRouterError on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ success: false, error: 'Route not found' }),
      });

      try {
        await client.getRoute('/notfound', 'links.example.com');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EdgeRouterError);
        expect((error as EdgeRouterError).message).toBe('Route not found');
        expect((error as EdgeRouterError).status).toBe(404);
      }
    });

    it('throws EdgeRouterError on parse failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await client.listRoutes('links.example.com');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EdgeRouterError);
        expect((error as EdgeRouterError).message).toContain('Failed to parse response');
        expect((error as EdgeRouterError).status).toBe(500);
      }
    });
  });
});

describe('createClientFromEnv', () => {
  it('creates client from env object', () => {
    const client = createClientFromEnv({
      EDGE_ROUTER_API_KEY: 'test-key',
      EDGE_ROUTER_URL: 'https://custom.example.com',
    });

    expect(client).toBeInstanceOf(EdgeRouterClient);
  });

  // v1.35.0 — a stale EDGE_ROUTER_DOMAIN in the operator's environment is read
  // by nothing. This is the regression guard for RESTORING the default: the
  // three analytics methods are called with no domain at all, so a
  // reintroduced client-level fallback would show up as a `domain=` parameter
  // that nobody asked for. createClientFromEnv builds no fetch of its own, so
  // the global is stubbed before construction rather than reaching into the
  // client's private field.
  describe('a stale EDGE_ROUTER_DOMAIN is ignored end to end', () => {
    const STALE = 'bifrost.example.com';
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { routes: [], total: 0, items: [] } }),
      });
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const staleClient = (): EdgeRouterClient =>
      createClientFromEnv({
        EDGE_ROUTER_API_KEY: 'test-key',
        EDGE_ROUTER_URL: 'https://custom.example.com',
        EDGE_ROUTER_DOMAIN: STALE,
      });

    it.each([
      ['getAnalyticsSummary', (c: EdgeRouterClient) => c.getAnalyticsSummary()],
      ['getClicks', (c: EdgeRouterClient) => c.getClicks()],
      ['getViews', (c: EdgeRouterClient) => c.getViews()],
    ])('%s with no domain sends no domain parameter at all', async (_name, call) => {
      await call(staleClient());

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.searchParams.has('domain')).toBe(false);
      expect(url.search).not.toContain(STALE);
    });

    it('sends only the domain the caller names', async () => {
      await staleClient().listRoutes('secondary.example.net');

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.searchParams.get('domain')).toBe('secondary.example.net');
      expect(url.search).not.toContain(STALE);
    });
  });

  it('uses default URL when not provided', () => {
    const client = createClientFromEnv({
      EDGE_ROUTER_API_KEY: 'test-key',
    });

    expect(client).toBeInstanceOf(EdgeRouterClient);
  });

  it('throws when API key is missing', () => {
    expect(() => createClientFromEnv({})).toThrow(
      'EDGE_ROUTER_API_KEY environment variable is required',
    );
  });
});

describe('EdgeRouterClient credential-target acknowledgement and changelog', () => {
  const mockFetch = vi.fn();
  let client: EdgeRouterClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new EdgeRouterClient({
      baseUrl: 'https://test.example.com',
      apiKey: 'test-api-key',
      fetch: mockFetch,
    });
  });

  const okRoute = () => ({
    ok: true,
    json: async () => ({ success: true, data: { path: '/x' } }),
  });

  const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body as string);

  it('omits the flag entirely when it was not set', async () => {
    mockFetch.mockResolvedValueOnce(okRoute());

    await client.createRoute(
      { path: '/x', type: 'redirect', target: 'https://app.example/ok' },
      'links.example.com',
    );

    expect(sentBody()).not.toHaveProperty('acknowledgeCredentialTarget');
  });

  it('attaches the flag on create, update, toggle and transfer when set', async () => {
    mockFetch.mockResolvedValue(okRoute());

    await client.createRoute(
      { path: '/x', type: 'redirect', target: 'https://app.example/ok' },
      'links.example.com',
      { acknowledgeCredentialTarget: true },
    );
    expect(sentBody().acknowledgeCredentialTarget).toBe(true);

    mockFetch.mockClear();
    await client.updateRoute('/x', { enabled: true }, 'links.example.com', {
      acknowledgeCredentialTarget: true,
    });
    expect(sentBody().acknowledgeCredentialTarget).toBe(true);

    mockFetch.mockClear();
    await client.toggleRoute('/x', true, 'links.example.com', {
      acknowledgeCredentialTarget: true,
    });
    expect(sentBody()).toMatchObject({ enabled: true, acknowledgeCredentialTarget: true });

    mockFetch.mockClear();
    await client.transferRoute('/x', 'links.example.com', 'secondary.example.net', {
      acknowledgeCredentialTarget: true,
    });
    expect(sentBody().acknowledgeCredentialTarget).toBe(true);
  });

  it('carries the refusal CODE and its sentence, and keeps the details', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        success: false,
        error: 'ROUTE_TARGET_CREDENTIAL',
        message: 'This route target carries credential-named parameters (token).',
        details: { parameters: ['token'] },
      }),
    });

    await expect(
      client.createRoute(
        { path: '/x', type: 'redirect', target: 'https://app.example/cb?token=LIVE' },
        'links.example.com',
      ),
    ).rejects.toMatchObject({
      message:
        'ROUTE_TARGET_CREDENTIAL: This route target carries credential-named parameters (token).',
      status: 400,
      details: { parameters: ['token'] },
    });
  });

  it('leaves an ordinary error body byte-identical', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ success: false, error: 'Route not found: /x' }),
    });

    await expect(client.getRoute('/x', 'links.example.com')).rejects.toThrow(
      new EdgeRouterError('Route not found: /x', 404),
    );
  });

  it('fetches the changelog as raw markdown', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '# Changelog\n\n## v1.36.0 (2026-09-17)\n',
    });

    const markdown = await client.getChangelogMarkdown();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.example.com/api/changelog',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(markdown).toMatch(/^# Changelog/);
  });
});
