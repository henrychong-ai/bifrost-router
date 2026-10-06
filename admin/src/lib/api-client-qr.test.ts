/**
 * The dashboard's QR client (v1.38.0): responses are checked with the
 * tolerant stored shape the Worker reads with, so a code saved under earlier
 * limits lists and opens; the server's own QR_NOT_FOUND and its clock reach
 * the caller; a long search is cut to the API's bound.
 */
import { SEARCH_PARAM_MAX_LENGTH } from '@bifrost/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qrApi, routesApi } from './api-client';
import { ApiError, isQrNotFoundError } from './api-error';

vi.mock('@/env', () => ({
  env: { VITE_API_URL: 'https://api.example.test', ADMIN_API_KEY: 'test-admin-key' },
}));

const DATE = 'Tue, 06 Oct 2026 10:00:00 GMT';
const SECOND = Date.parse('2026-10-06T10:00:00Z');

/** A record saved under earlier limits: a 120-character description, 12 tags. */
const legacy = {
  id: 'legacy-code',
  domain: 'example.com',
  type: 'url',
  payload: { url: 'https://example.com/' },
  description: 'd'.repeat(120),
  tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
  design: { fg: '#000000' },
  createdAt: 1,
  updatedAt: 2,
  createdBy: 'test',
};

function answer(body: unknown, init: ResponseInit = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200, ...init }));
}

describe('qrApi responses', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a list and an update answer holding a record over today’s limits', async () => {
    answer({
      success: true,
      data: [legacy],
      meta: { total: 1, count: 1, offset: 0, limit: 1, hasMore: false },
    });
    const listed = await qrApi.list({ domain: 'example.com' });
    expect(listed.items[0]?.description).toHaveLength(120);
    expect(listed.items[0]?.tags).toHaveLength(12);
    // Normalised as the Worker reads it: missing design fields take defaults
    expect(listed.items[0]?.design.size).toBe(512);

    vi.restoreAllMocks();
    answer({ success: true, data: legacy });
    const updated = await qrApi.update('legacy-code', { design: { fg: '#111111' } }, 'example.com');
    expect(updated.tags).toHaveLength(12);
  });

  it('refuses an answer whose record is not a QR code', async () => {
    answer({ success: true, data: { ...legacy, payload: { link: 'x' } } });
    await expect(qrApi.get('legacy-code', 'example.com')).rejects.toBeInstanceOf(Error);
  });

  it('turns a QR_NOT_FOUND answer into an ApiError with its message, code and clock', async () => {
    answer(
      { success: false, error: 'QR_NOT_FOUND', message: 'QR code not found: gone' },
      { status: 404, headers: { Date: DATE, 'X-Server-Time': String(SECOND + 42) } },
    );
    const failure: unknown = await qrApi
      .delete('gone', 'example.com')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('QR code not found: gone');
    expect((failure as ApiError).code).toBe('QR_NOT_FOUND');
    expect((failure as ApiError).serverTime).toBe(SECOND + 42);
    expect(isQrNotFoundError(failure)).toBe(true);
  });

  it('does not take a plain 404 for QR_NOT_FOUND', async () => {
    answer({ error: 'Not Found' }, { status: 404 });
    const failure: unknown = await qrApi.get('x', 'example.com').catch((error: unknown) => error);
    expect((failure as ApiError).message).toBe('Not Found');
    expect(isQrNotFoundError(failure)).toBe(false);
    expect(isQrNotFoundError(new Error('QR_NOT_FOUND'))).toBe(false);
  });

  it('resolves a delete with the server clock of its answer', async () => {
    answer(
      { success: true, data: { deleted: true, id: 'a' } },
      { headers: { Date: DATE, 'X-Server-Time': String(SECOND + 7) } },
    );
    await expect(qrApi.delete('a', 'example.com')).resolves.toEqual({ serverTime: SECOND + 7 });
  });

  it('cuts a long search to the API bound for QR and route lists', async () => {
    const fetchSpy = answer({
      success: true,
      data: [],
      meta: { total: 0, count: 0, offset: 0, limit: 0, hasMore: false },
    });
    await qrApi.list({ domain: 'example.com', search: 'y'.repeat(3000) });
    const qrUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(qrUrl.searchParams.get('search')).toHaveLength(SEARCH_PARAM_MAX_LENGTH);

    vi.restoreAllMocks();
    const routeSpy = answer({
      success: true,
      data: { routes: [], meta: { total: 0, offset: 0, hasMore: false } },
    });
    await routesApi.list(undefined, { search: 'z'.repeat(3000) });
    const routeUrl = new URL(String(routeSpy.mock.calls[0]?.[0]));
    expect(routeUrl.searchParams.get('search')).toHaveLength(SEARCH_PARAM_MAX_LENGTH);
  });
});
