/**
 * Every object key the dashboard puts in a URL goes through the shared
 * `objectKeySegments`, and every route path and slug through `pathSegments`
 * (v1.39.0). A raw key's `#` or `?` ended the path, a backslash became a slash
 * and `%2e` decoded to a dot, so the call addressed another object; a whole
 * value through `encodeURIComponent` carried `%2F`, which the dashboard's /api
 * proxy refuses. A key's leading slash used to be dropped (`/report.pdf`
 * deleted `report.pdf`); such a key is now refused before anything is sent.
 */
import { UNADDRESSABLE_OBJECT_KEY } from '@bifrost/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsApi, feedbackApi, objectKeySegments, storageApi } from './api-client';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://dashboard.example.com' },
}));

const object = { key: 'k', size: 1, etag: 'e', uploaded: '2026-10-07T00:00:00Z' };

/** Answer every fetch with `body`, recording the requests. */
function stubFetch(body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }),
      ),
    );
}

/** The raw path of the one request a call made (as it leaves the browser). */
async function requestedPath(body: unknown, call: () => Promise<unknown>): Promise<string> {
  const fetchMock = stubFetch(body);
  await call().catch(() => undefined);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url] = fetchMock.mock.calls[0] as [string];
  return new URL(url).pathname;
}

/** The value a server reads back from the tail of `pathname` after `prefix`. */
function readBack(pathname: string, prefix: string): string {
  expect(pathname.startsWith(prefix)).toBe(true);
  return pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
}

const KEYS = ['docs/a#b.pdf', 'a?b=1', 'dir/a\\b.txt', 'x/%2e%2e/y', 'café menu.pdf', 'a%2Fb'];

describe('object keys in dashboard URLs', () => {
  afterEach(() => vi.restoreAllMocks());

  const sites: Array<[string, string, unknown, (key: string) => Promise<unknown>]> = [
    [
      'meta',
      '/api/storage/files/meta/',
      { success: true, data: object },
      key => storageApi.getObjectMeta('files', key),
    ],
    [
      'download',
      '/api/storage/files/objects/',
      'bytes',
      key => storageApi.downloadObject('files', key),
    ],
    [
      'delete',
      '/api/storage/files/objects/',
      { success: true },
      key => storageApi.deleteObject('files', key),
    ],
    [
      'metadata',
      '/api/storage/files/metadata/',
      { success: true, data: object },
      key => storageApi.updateObjectMetadata('files', key, { contentType: 'text/plain' }),
    ],
    [
      'comment',
      '/api/storage/files/comment/',
      { success: true, data: {} },
      key => storageApi.setComment('files', key, 'note'),
    ],
    [
      'purge-cache',
      '/api/storage/files/purge-cache/',
      { success: true, data: {} },
      key => storageApi.purgeCache('files', key),
    ],
    [
      'feedback attachment',
      '/api/feedback/f-1/attachment/',
      'bytes',
      key => feedbackApi.attachment('f-1', key),
    ],
  ];

  it.each(sites)(
    '%s sends every key as path segments the server reads back',
    async (_label, prefix, body, call) => {
      for (const key of KEYS) {
        vi.restoreAllMocks();
        const pathname = await requestedPath(body, () => call(key));
        expect({ key, pathname }).toEqual({ key, pathname: `${prefix}${objectKeySegments(key)}` });
        expect(readBack(pathname, prefix)).toBe(key);
        // Nothing the dashboard's proxy refuses, other than a key's own backslash
        expect(pathname).not.toMatch(/%2f|%2e|\/\//i);
      }
    },
  );
});

describe('object keys the dashboard cannot send exactly', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['meta', (key: string) => storageApi.getObjectMeta('files', key)],
    ['download', (key: string) => storageApi.downloadObject('files', key)],
    ['delete', (key: string) => storageApi.deleteObject('files', key)],
    [
      'metadata',
      (key: string) => storageApi.updateObjectMetadata('files', key, { contentType: 'text/plain' }),
    ],
    ['comment', (key: string) => storageApi.setComment('files', key, 'note')],
    ['purge-cache', (key: string) => storageApi.purgeCache('files', key)],
    ['feedback attachment', (key: string) => feedbackApi.attachment('f-1', key)],
  ])(
    '%s refuses a leading slash, an empty or a dot segment and sends nothing',
    async (_l, call) => {
      const fetchMock = stubFetch({ success: true, data: object });
      for (const key of ['/report.pdf', 'a//b', 'a/../b', 'dir/']) {
        await expect(call(key)).rejects.toThrow(new RangeError(UNADDRESSABLE_OBJECT_KEY));
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('analytics paths in dashboard URLs', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['slug stats', '/api/analytics/clicks/', (value: string) => analyticsApi.slugStats(value)],
    [
      'download stats',
      '/api/analytics/downloads/',
      (value: string) => analyticsApi.downloadStats(value),
    ],
    ['proxy stats', '/api/analytics/proxy/', (value: string) => analyticsApi.proxyStats(value)],
  ])('%s sends the path without its leading slash, as segments', async (_label, prefix, call) => {
    // The root path is the bare prefix with its trailing slash (v1.39.0), never
    // the list endpoint without it
    for (const value of ['/', '/promo', '/promo/summer sale', '/a#b?c']) {
      vi.restoreAllMocks();
      const pathname = await requestedPath({ success: true, data: {} }, () => call(value));
      expect(readBack(pathname, prefix)).toBe(value.slice(1));
      expect(pathname).not.toMatch(/%2f/i);
      expect({ value, root: pathname === prefix }).toEqual({ value, root: value === '/' });
    }
  });
});
