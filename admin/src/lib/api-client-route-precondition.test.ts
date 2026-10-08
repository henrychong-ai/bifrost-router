/**
 * A route edit carries the version the dashboard loaded (v1.40.0): the
 * Worker refuses it with 409 ROUTE_SOURCE_CHANGED if the route has changed
 * since, instead of overwriting the other change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routesApi } from './api-client';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://dashboard.example.com' },
}));

const ROUTE = {
  path: '/promo',
  type: 'redirect',
  target: 'https://example.com/',
  createdAt: 1000,
  updatedAt: 2000,
};

function sentBody(): unknown {
  const fetchMock = vi.mocked(globalThis.fetch);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return JSON.parse(String(init?.body));
}

describe('routesApi.update', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends expectedUpdatedAt and the acknowledgement beside the patch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: ROUTE }), { status: 200 }),
    );
    await routesApi.update('/promo', { cacheControl: 'no-store' }, 'example.com', true, 2000);
    expect(sentBody()).toEqual({
      cacheControl: 'no-store',
      acknowledgeCredentialTarget: true,
      expectedUpdatedAt: 2000,
    });
  });

  it('sends the patch alone without either', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: ROUTE }), { status: 200 }),
    );
    await routesApi.update('/promo', { enabled: false }, 'example.com');
    expect(sentBody()).toEqual({ enabled: false });
  });

  it('migrate sends expectedUpdatedAt with the updates, and alone when there are none', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: ROUTE }), { status: 200 }),
      ),
    );
    await routesApi.migrate(
      '/promo',
      '/sale',
      'example.com',
      { cacheControl: 'no-store' },
      false,
      2000,
    );
    expect(sentBody()).toEqual({ cacheControl: 'no-store', expectedUpdatedAt: 2000 });
    vi.mocked(globalThis.fetch).mockClear();
    await routesApi.migrate('/promo', '/sale', 'example.com', {}, undefined, 2000);
    expect(sentBody()).toEqual({ expectedUpdatedAt: 2000 });
  });
});
