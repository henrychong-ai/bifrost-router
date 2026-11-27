/**
 * Every dashboard API call goes to the page's own origin with the dashboard
 * header and without an admin key (v1.39.0): the server in front of the
 * dashboard adds the key, and only to requests that carry the header.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupApi, changelogApi, feedbackApi, routesApi, storageApi } from './api-client';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://dashboard.example.com' },
}));

/** Answer every fetch with `body` (JSON unless a string), recording the requests. */
function stubFetch(body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }),
      ),
    );
}

/** The URL and headers of the one request a call made. */
function onlyRequest(fetchMock: ReturnType<typeof stubFetch>) {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return { url: new URL(url), headers: new Headers(init?.headers) };
}

const healthy = {
  status: 'healthy',
  timestamp: '2026-10-07T00:00:00Z',
  lastBackup: null,
  issues: [],
  checks: {
    backupExists: false,
    backupAge: 'ok',
    manifestValid: false,
    filesComplete: false,
    routeCountOk: true,
  },
};

describe('dashboard API requests', () => {
  afterEach(() => vi.restoreAllMocks());

  const calls: Array<[string, unknown, () => Promise<unknown>]> = [
    [
      'a JSON call (fetchApi), with caller headers',
      { routes: [], total: 0 },
      () => routesApi.list('example.com'),
    ],
    ['backup health', healthy, () => backupApi.health()],
    ['an object download', 'bytes', () => storageApi.downloadObject('files', 'a/b.pdf')],
    [
      'an upload',
      { success: true, data: { key: 'a.txt', size: 1, uploaded: '2026-10-07T00:00:00Z' } },
      () => storageApi.uploadObject('files', new File(['x'], 'a.txt'), 'a.txt'),
    ],
    ['a feedback submission', { data: { id: 'f' } }, () => feedbackApi.submit(new FormData())],
    ['a feedback attachment', 'bytes', () => feedbackApi.attachment('f', 'shot.png')],
    ['the changelog', '# Changelog', () => changelogApi.get()],
  ];

  it.each(calls)(
    '%s goes to the page origin with the dashboard header and no key',
    async (_label, body, call) => {
      const fetchMock = stubFetch(body);
      await call().catch(() => undefined);
      const { url, headers } = onlyRequest(fetchMock);
      expect(url.origin).toBe('https://dashboard.example.com');
      expect(url.pathname.startsWith('/api/')).toBe(true);
      expect(headers.get('X-Bifrost-Dashboard')).toBe('1');
      expect(headers.has('X-Admin-Key')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
    },
  );

  it('keeps the dashboard header when a caller passes its own headers', async () => {
    const fetchMock = stubFetch({ success: true, data: { deleted: true } });
    await routesApi.delete('/x', 'example.com').catch(() => undefined);
    const { headers } = onlyRequest(fetchMock);
    expect(headers.get('X-Bifrost-Dashboard')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});

describe('object download signal (v1.47.0)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the signal to the request, keeping the dashboard header', async () => {
    const fetchMock = stubFetch('bytes');
    const controller = new AbortController();
    await storageApi.downloadObject('files', 'a/b.pdf', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.signal).toBe(controller.signal);
    expect(onlyRequest(fetchMock).headers.get('X-Bifrost-Dashboard')).toBe('1');
  });

  it('an abort while the body is read rejects the download', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('partial'));
          init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const download = storageApi.downloadObject('files', 'a/b.pdf', { signal: controller.signal });
    controller.abort();
    await expect(download).rejects.toBeDefined();
  });
});
