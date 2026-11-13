/**
 * The storage listing's offset-mode metadata reaches the page. The client
 * parses each answer with an inline Zod schema, which strips any key it does
 * not declare, so a response field the server adds is dead in the dashboard
 * until the schema names it too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageApi } from './api-client';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://dashboard.example.com' },
}));

function stubFetch(body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
}

const listing = (meta: Record<string, unknown>, capped: boolean) => ({
  success: true,
  data: {
    objects: [],
    delimitedPrefixes: ['a/'],
    truncated: capped,
    capped,
    meta,
  },
});

describe('storageApi.listObjects offset metadata', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps meta.totalIsExact when the folder exceeds the cap', async () => {
    const fetchMock = stubFetch(
      listing(
        { total: 1000, count: 1, offset: 0, limit: 50, hasMore: true, totalIsExact: false },
        true,
      ),
    );
    const result = await storageApi.listObjects('files', { prefix: 'a/', offset: 0, limit: 50 });
    expect(result.meta?.totalIsExact).toBe(false);
    expect(result.capped).toBe(true);
    // Offset mode is selected by sending the offset.
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('offset')).toBe('0');
  });

  it('keeps meta.totalIsExact when the total is exact', async () => {
    stubFetch(
      listing(
        { total: 1, count: 1, offset: 0, limit: 50, hasMore: false, totalIsExact: true },
        false,
      ),
    );
    const result = await storageApi.listObjects('files', { offset: 0, limit: 50 });
    expect(result.meta?.totalIsExact).toBe(true);
  });

  it('reads an answer from a server without the field', async () => {
    stubFetch(listing({ total: 1, count: 1, offset: 0, limit: 50, hasMore: false }, false));
    const result = await storageApi.listObjects('files', { offset: 0, limit: 50 });
    expect(result.meta).toEqual({ total: 1, count: 1, offset: 0, limit: 50, hasMore: false });
    expect(result.meta?.totalIsExact).toBeUndefined();
  });
});
