/**
 * The dashboard's QR client (v1.38.0): responses are checked with the
 * tolerant stored shape the Worker reads with, so a code saved under earlier
 * limits lists and opens; the server's own QR_NOT_FOUND and its clock reach
 * the caller; a long search is cut to the API's bound.
 */
import { SEARCH_PARAM_MAX_LENGTH } from '@bifrost/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qrApi, routesApi } from './api-client';
import { ApiError, isQrAlreadyExistsError, isQrNotFoundError } from './api-error';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));

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

  it('turns a QR_NOT_FOUND answer into an ApiError with its message and code', async () => {
    answer(
      { success: false, error: 'QR_NOT_FOUND', message: 'QR code not found: gone' },
      { status: 404 },
    );
    const failure: unknown = await qrApi
      .delete('gone', 'example.com')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('QR code not found: gone');
    expect((failure as ApiError).code).toBe('QR_NOT_FOUND');
    expect(isQrNotFoundError(failure)).toBe(true);
  });

  it('does not take a plain 404 for QR_NOT_FOUND', async () => {
    answer({ error: 'Not Found' }, { status: 404 });
    const failure: unknown = await qrApi.get('x', 'example.com').catch((error: unknown) => error);
    expect((failure as ApiError).message).toBe('Not Found');
    expect(isQrNotFoundError(failure)).toBe(false);
    expect(isQrNotFoundError(new Error('QR_NOT_FOUND'))).toBe(false);
  });

  it('resolves a delete with the createdAt of the record it removed', async () => {
    answer({ success: true, data: { deleted: true, id: 'a', createdAt: 42 } });
    await expect(qrApi.delete('a', 'example.com')).resolves.toEqual({ createdAt: 42 });
    vi.restoreAllMocks();
    // An unreadable record names none
    answer({ success: true, data: { deleted: true, id: 'a' } });
    await expect(qrApi.delete('a', 'example.com')).resolves.toEqual({ createdAt: undefined });
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

describe('unreadable records and older routes in the lists (v1.38.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('splits the QR list into readable codes and unreadable rows', async () => {
    answer({
      success: true,
      data: [legacy, { domain: 'example.com', id: 'broken-code', invalid: true }],
      meta: { total: 2, count: 2, offset: 0, limit: 2, hasMore: false },
    });
    const listed = await qrApi.list({ domain: 'example.com' });
    expect(listed.items.map(item => item.id)).toEqual(['legacy-code']);
    expect(listed.invalid).toEqual([{ domain: 'example.com', id: 'broken-code', invalid: true }]);
  });

  it('lists a route stored before today’s rules, and splits out an unreadable row', async () => {
    const older = {
      path: '/older',
      type: 'redirect',
      target: 'https://example.com/',
      statusCode: 303,
      bucket: 'retired-bucket',
      cacheControl: null,
      domain: 'example.com',
    };
    answer({
      success: true,
      data: {
        routes: [older, { domain: 'example.com', path: '/broken', invalid: true }],
        meta: { total: 2, offset: 0, hasMore: false },
      },
    });
    const listed = await routesApi.list('example.com');
    expect(listed.routes).toEqual([
      {
        path: '/older',
        type: 'redirect',
        target: 'https://example.com/',
        statusCode: 303,
        bucket: 'retired-bucket',
        domain: 'example.com',
      },
    ]);
    expect(listed.invalidRoutes).toEqual([
      { domain: 'example.com', path: '/broken', invalid: true },
    ]);
    expect(listed.total).toBe(2);
  });

  it('still refuses a route row that is neither a route nor an unreadable row', async () => {
    answer({
      success: true,
      data: { routes: [{ path: '/x', type: 'script', target: 'x' }], meta: {} },
    });
    await expect(routesApi.list('example.com')).rejects.toBeInstanceOf(Error);
  });
});

describe('a readable record holding an `invalid` field (v1.38.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays a route row: unreadable rows are told apart by shape, never by that field', async () => {
    const flagged = {
      path: '/flagged',
      type: 'redirect',
      target: 'https://example.com/f',
      invalid: true,
      domain: 'example.com',
    };
    answer({
      success: true,
      data: { routes: [flagged], meta: { total: 1, offset: 0, hasMore: false } },
    });
    const listed = await routesApi.list('example.com');
    expect(listed.routes).toEqual([flagged]);
    expect(listed.invalidRoutes).toEqual([]);
  });
});

/** The ApiError a call rejects with. */
const failure = (call: () => Promise<unknown>) =>
  call().catch((error: unknown) => error) as Promise<ApiError>;

describe('failed answers through the one shared envelope reader (v1.38.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a code is an UPPER_SNAKE value only: a label beside a message is text', async () => {
    answer({ error: 'Internal Server Error', message: 'boom' }, { status: 500 });
    const error = await failure(() => qrApi.get('x', 'example.com'));
    expect(error.message).toBe('boom');
    expect(error.code).toBeUndefined();
    vi.restoreAllMocks();
    answer(
      { success: false, code: 'not a code', error: 'Refused', message: 'Why' },
      { status: 409 },
    );
    expect((await failure(() => qrApi.get('x', 'example.com'))).code).toBeUndefined();
  });

  it('shows the server sentence of a plain-text error, as the server wrote it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('QR id must match a pattern', { status: 400 }),
    );
    const error = await failure(() => qrApi.create({ type: 'text' }, 'example.com'));
    expect(error.status).toBe(400);
    expect(error.message).toBe('QR id must match a pattern');
  });

  it('keeps the QR_ALREADY_EXISTS code with its sentence', async () => {
    answer(
      { success: false, error: 'QR_ALREADY_EXISTS', message: 'QR code already exists: a' },
      { status: 409 },
    );
    const error = await failure(() => qrApi.create({ type: 'text', id: 'a' }, 'example.com'));
    expect(error.code).toBe('QR_ALREADY_EXISTS');
    expect(error.message).toBe('QR code already exists: a');
    expect(isQrAlreadyExistsError(error)).toBe(true);
  });

  it('an empty body leaves the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));
    expect((await failure(() => qrApi.get('x', 'example.com'))).message).toBe('HTTP 502');
  });
});

describe('route writes (v1.38.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a recovery delete names the exact key with recover=invalid', async () => {
    const spy = answer({ success: true });
    await routesApi.delete('/p?x', 'example.com', { recoverInvalid: true });
    const url = new URL(String(spy.mock.calls[0]?.[0]));
    expect(url.searchParams.get('path')).toBe('/p?x');
    expect(url.searchParams.get('recover')).toBe('invalid');
    vi.restoreAllMocks();
    const plain = answer({ success: true });
    await routesApi.delete('/promo', 'example.com');
    expect(new URL(String(plain.mock.calls[0]?.[0])).searchParams.has('recover')).toBe(false);
  });

  it('a migration carries the rest of the edit in its body, and no body without one', async () => {
    const route = { path: '/b', type: 'redirect', target: 'https://example.com/' };
    const spy = answer({ success: true, data: route });
    await routesApi.migrate('/a', '/b', 'example.com', { cacheControl: 'no-store' }, true);
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      cacheControl: 'no-store',
      acknowledgeCredentialTarget: true,
    });
    vi.restoreAllMocks();
    const bare = answer({ success: true, data: route });
    await routesApi.migrate('/a', '/b', 'example.com');
    expect(bare.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
